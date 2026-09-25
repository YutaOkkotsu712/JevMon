import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, ours } from './helpers.js';
import { certainlyFails } from '../src/strategy/dominance.js';
import { sampleWorld, toEngineState } from '../src/search/engineState.js';
import { inferOpponent } from '../src/strategy/inference.js';
import { damageRange } from '../src/strategy/damage.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';

const decide = (b: ReturnType<typeof battle>) => {
  const request = parseChoiceRequest(JSON.stringify(b.payload(9, b.me().exactHP?.max ?? 100, 0)))!;
  return { state: b.state, legalActions: generateLegalActions(request), request };
};
const seeded = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

test('a move that certainly fails is never the fallback', () => {
  // 2686981978: outhealed skipped Play Rough, and the next in the blend was Thunder Wave into a Ground type, seven turns.
  const b = battle([ours('Scream Tail', 88, ['Play Rough', 'Wish', 'Thunder Wave', 'Protect'], 'Cute Charm', 'Leftovers', 'Steel')], 'Gastrodon-East');
  const input = decide(b), skipped = certainlyFails(input);
  const labels = [...skipped.keys()].map(k => input.legalActions.find(a => a.id === k)!.label);
  assert.deepEqual(labels, ['Thunder Wave'], 'only the certain failure; Tera variants are left to the ranking');
  assert.match([...skipped.values()][0]!.reason, /immune to Electric/);
  // A curing berry or a Guts holder is a cost, not a failure, and is left to statusThatHelpsThem.
  const guts = battle([ours('Scream Tail', 88, ['Thunder Wave'], 'Cute Charm', 'Leftovers', 'Steel')], 'Ursaring');
  guts.foe().ability = 'Guts';
  assert.equal(certainlyFails(decide(guts)).size, 0);
});

test('the search samples every candidate set, not one moveset per ability and item', () => {
  // 2686956370: Volcarona's 38 sets had collapsed to two, Tera Water or Ground, and Tera Grass was never searched.
  const b = battle([ours('Tauros-Paldea-Aqua', 81, ['Liquidation', 'Close Combat', 'Bulk Up', 'Substitute'], 'Intimidate', 'Sitrus Berry', 'Water')], 'Volcarona', 77);
  b.foe().revealedMoves = ['Quiver Dance'];
  const random = seeded(3), teras = new Set<string>();
  for (let i = 0; i < 200; i++) teras.add(sampleWorld(b.state, 'p1', random).sets.get(b.foe().id)!.teraType);
  const inferred = new Set(inferOpponent(b.foe()).candidates.map(c => c.teraType));
  assert.deepEqual([...teras].sort(), [...inferred].sort());
  assert.ok(teras.has('Grass'));
});

test('an opposing Pokémon whose moves no set explains still reaches the search', () => {
  // A Zoroark's Dark Pulse, used as Chimecho, left Chimecho with no set to match; the search saw an empty slot.
  const b = battle([ours('Skarmory', 84, ['Brave Bird', 'Body Press', 'Iron Defense', 'Roost'], 'Sturdy', 'Rocky Helmet', 'Fighting')], 'Chimecho', 93);
  b.foe().revealedMoves = ['Calm Mind', 'Dazzling Gleam', 'Dark Pulse'];
  assert.equal(inferOpponent(b.foe()).candidates.length, 0, 'inference still fails closed for the payload');
  const theirs = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', seeded(5))).state.split('/')[1]!.split('=');
  assert.match(theirs[Number(theirs[6])]!, /^CHIMECHO,/);
});

test('a lost type leaves the other one, and estimates keep running', () => {
  // Double Shock left Pawmot as ???/Fighting, which hid it from every estimate and from the search.
  const b = battle([ours('Skarmory', 84, ['Brave Bird', 'Body Press'], 'Sturdy', 'Rocky Helmet', 'Fighting')], 'Pawmot', 88);
  b.feed('|-start|p2a: Foe|typechange|???/Fighting');
  assert.ok(damageRange(b.state, 'Brave Bird'), 'Brave Bird is priced against a pure Fighting type');
  const theirs = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', seeded(5))).state.split('/')[1]!.split('=');
  assert.match(theirs[Number(theirs[6])]!, /^PAWMOT,/);
});

import { freeKnockoutPassedUp } from '../src/strategy/dominance.js';
import { extractFeatures } from '../src/strategy/features.js';

test('a Speed boost that makes a second-moving knockout land first is not blocked, and says what it buys next', () => {
  const salamence = () => [ours('Salamence', 77, ['Dragon Dance', 'Outrage', 'Earthquake', 'Dual Wingbeat'], 'Intimidate', 'Heavy-Duty Boots', 'Dragon')];
  // A Scarf Rotom-Mow may outspeed us now; at +1 we outspeed every set, and it has no priority to strike first.
  const rotom = battle(salamence(), 'Rotom-Mow', 86);
  rotom.feed('|-damage|p2a: Foe|8/100'); rotom.feed('|turn|2');
  const input = decide(rotom);
  assert.equal(freeKnockoutPassedUp(input).size, 0, 'Dragon Dance costs no extra action and keeps the boost');
  const dd = extractFeatures(input, 'reduced').actions.find(a => a.label === 'Dragon Dance') as any;
  const pool = dd.afterItsStatChange.theirRemainingPokemon.shareOfUnrevealedPoolOutspedPercent;
  assert.ok(pool.after > pool.now, 'the boost outspeeds more of what they have not shown');
  // Bisharp's Sucker Punch would still strike before our knockout next turn, so the extra turn is a real gift.
  const bisharp = battle(salamence(), 'Bisharp', 88);
  bisharp.feed('|-damage|p2a: Foe|8/100'); bisharp.feed('|turn|2');
  const blocked = freeKnockoutPassedUp(decide(bisharp));
  assert.ok([...blocked.keys()].some(k => decide(bisharp).legalActions.find(a => a.id === k)!.label === 'Dragon Dance'));
});

import { redundantTera } from '../src/strategy/dominance.js';

test('Tera is not spent on chip damage early, but is left free when it buys a knockout or a hit fewer', () => {
  const team = [ours('Basculin', 86, ['Wave Crash', 'Aqua Jet', 'Flip Turn', 'Psychic Fangs'], 'Adaptability', 'Choice Band', 'Water'),
    ours('Snorlax', 84, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal'), ours('Garchomp', 77, ['Earthquake'], 'Rough Skin', 'Life Orb', 'Ground'),
    ours('Clefable', 85, ['Moonblast'], 'Magic Guard', 'Leftovers', 'Steel')];
  const withTera = (b: ReturnType<typeof battle>) => {
    const payload = b.payload(9, b.me().exactHP!.max, 0) as ReturnType<typeof b.payload> & { active: { canTerastallize?: string }[] };
    payload.active[0]!.canTerastallize = 'Water';
    const request = parseChoiceRequest(JSON.stringify(payload))!;
    return { state: b.state, legalActions: generateLegalActions(request), request };
  };
  const snorlax = withTera(battle(team, 'Snorlax', 85));
  const skipped = [...redundantTera(snorlax).keys()].map(k => snorlax.legalActions.find(a => a.id === k)!.label);
  assert.ok(skipped.includes('Wave Crash + Tera Water'), 'no knockout and no hit fewer against a full Snorlax, with four of us left');
  const hurt = battle(team, 'Snorlax', 85);
  hurt.feed('|-damage|p2a: Foe|80/100'); hurt.feed('|turn|2');
  const lower = withTera(hurt);
  assert.ok(![...redundantTera(lower).keys()].some(k => lower.legalActions.find(a => a.id === k)!.label === 'Wave Crash + Tera Water'),
    'at 80% Tera turns a possible knockout into a certain one, and that is left to judgement');
});

test('our Shadow Tag keeps them in, and says so', () => {
  const gothitelle = [ours('Gothitelle', 90, ['Psychic', 'Thunderbolt', 'Calm Mind', 'Rest'], 'Shadow Tag', 'Leftovers', 'Fairy')];
  const read = (foe: string) => { const b = battle(gothitelle, foe, 85); return extractFeatures(decide(b), 'reduced') as { theyCannotSwitchOut?: { because: string; exceptThrough?: string[] } }; };
  assert.equal(read('Snorlax').theyCannotSwitchOut?.because, 'our Shadow Tag');
  assert.equal(read('Gengar').theyCannotSwitchOut, undefined, 'a Ghost type is never trapped');
  assert.ok(read('Rotom-Wash').theyCannotSwitchOut?.exceptThrough?.some(m => m.startsWith('Volt Switch')), 'a pivot move still takes it out');
});

import { fasterPivot } from '../src/strategy/pivot.js';

test('no Tera on a turn the opponent cannot act, unless it changes our own damage', () => {
  // 2687051429: Malamar went Tera Steel with Superpower while Slaking loafed, then took Tera Ground Earthquake.
  const team = [ours('Malamar', 82, ['Superpower', 'Knock Off', 'Rest', 'Sleep Talk'], 'Contrary', 'Leftovers', 'Steel'),
    ours('Gothitelle', 90, ['Psychic Noise'], 'Shadow Tag', 'Leftovers', 'Fairy')];
  const b = battle(team, 'Slaking', 84);
  b.feed('|move|p2a: Foe|Knock Off|p1a: Malamar'); b.feed('|turn|2');
  const payload = b.payload(9, b.me().exactHP!.max, 0) as ReturnType<typeof b.payload> & { active: { canTerastallize?: string }[] };
  payload.active[0]!.canTerastallize = 'Steel';
  const request = parseChoiceRequest(JSON.stringify(payload))!;
  const input = { state: b.state, legalActions: generateLegalActions(request), request };
  const skipped = [...redundantTera(input).entries()];
  assert.ok(skipped.some(([k, v]) => input.legalActions.find(a => a.id === k)!.label === 'Superpower + Tera Steel' && /cannot act this turn/.test(v.reason)));
});

test('a faster damaging pivot is found for a hard switch, but not Volt Switch into a Ground type', () => {
  const raikou = [ours('Raikou', 82, ['Volt Switch', 'Thunderbolt', 'Scald', 'Shadow Ball'], 'Pressure', 'Choice Specs', 'Electric'),
    ours('Garchomp', 77, ['Earthquake'], 'Rough Skin', 'Life Orb', 'Ground')];
  const slow = battle(raikou, 'Snorlax', 84);
  assert.match(fasterPivot(decide(slow))?.reason ?? '', /Volt Switch moves first/);
  assert.equal(fasterPivot(decide(battle(raikou, 'Hippowdon', 84))), null, 'Volt Switch does nothing to a Ground type');
});

import { endeavorTooEarly, futileSubstitute, pickedOffOnArrival } from '../src/strategy/dominance.js';
import { hazardValue } from '../src/strategy/hazards.js';

test('an Endeavor user lowers its HP with Substitutes first, and Endeavor waits for low HP or a standing shell', () => {
  // 2687057697: Luvdisc was denied a second Substitute at 75%, used Endeavor, and a 94% Snorlax fell only to 47%.
  const luvdisc = [ours('Luvdisc', 99, ['Substitute', 'Endeavor', 'Surf', 'Charm'], 'Swift Swim', 'Leftovers', 'Water')];
  const b = battle(luvdisc, 'Snorlax', 88);
  b.feed('|-boost|p2a: Foe|spe|-6'); b.feed('|move|p1a: Luvdisc|Substitute|p1a: Luvdisc'); b.feed('|-start|p1a: Luvdisc|Substitute');
  b.feed(`|-damage|p1a: Luvdisc|${Math.round(luvdisc[0]!.maxHP * 0.75)}/${luvdisc[0]!.maxHP}`);
  b.feed('|move|p2a: Foe|Body Slam|p1a: Luvdisc'); b.feed('|-end|p1a: Luvdisc|Substitute'); b.feed('|turn|2');
  const input = { ...decide(b), ...(() => { const r = parseChoiceRequest(JSON.stringify(b.payload(9, Math.round(luvdisc[0]!.maxHP * 0.75), 0)))!; return { request: r, legalActions: generateLegalActions(r) }; })() };
  const early = [...endeavorTooEarly(input).keys()].map(k => input.legalActions.find(a => a.id === k)!.label);
  assert.deepEqual(early, ['Endeavor'], 'at 75% a Substitute that goes up first is worth a quarter off Snorlax');
  assert.equal(futileSubstitute(input).size, 0, 'a broken shell is the point for an Endeavor user');
});

test('a replacement a revealed priority attack picks off is skipped when another survives it', () => {
  // 2687061975: Mismagius at 28% came in on a Banette that had shown Shadow Sneak, and fell before it moved.
  const roster = [ours('Zacian', 72, ['Play Rough'], 'Intrepid Sword', 'Rusted Sword', 'Fighting'),
    ours('Mismagius', 86, ['Shadow Ball', 'Tera Blast'], 'Levitate', 'Leftovers', 'Fighting'),
    ours('Porygon2', 81, ['Ice Beam', 'Recover'], 'Download', 'Eviolite', 'Ghost')];
  const b = battle(roster, 'Banette', 88);
  b.feed('|move|p2a: Foe|Shadow Sneak|p1a: Zacian');
  b.feed('|faint|p1a: Zacian');
  const mismagius = b.state.sides.p1.team.find(p => p.species === 'Mismagius')!;
  mismagius.hpPercent = 28; mismagius.exactHP = { current: Math.round(roster[1]!.maxHP * 0.28), max: roster[1]!.maxHP };
  const { active: _active, ...payload } = b.payload(7, 0);
  const request = parseChoiceRequest(JSON.stringify({ ...payload, forceSwitch: [true] }))!;
  const input = { state: b.state, legalActions: generateLegalActions(request), request };
  const skipped = [...pickedOffOnArrival(input).keys()].map(k => input.legalActions.find(a => a.id === k)!.label);
  assert.ok(skipped.some(l => l.startsWith('Switch to Mismagius')), JSON.stringify(skipped));
  assert.ok(!skipped.some(l => l.startsWith('Switch to Porygon2')), 'Porygon2 survives Shadow Sneak');
});

test('Ceaseless Edge is priced as the Spikes it lays, and as chip once they are maxed', () => {
  const b = battle([ours('Smeargle', 90, ['Ceaseless Edge'], 'Own Tempo', 'Focus Sash', 'Ghost')], 'Snorlax', 88);
  assert.equal(hazardValue(b.state, 'Ceaseless Edge', 'p1')?.sets, 'Spikes');
  b.state.sides.p2.hazards = { Spikes: 3 };
  assert.equal((hazardValue(b.state, 'Ceaseless Edge', 'p1') as { alreadyAtItsLimit?: boolean })?.alreadyAtItsLimit, true);
});
