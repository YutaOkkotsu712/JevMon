import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectViability } from '../src/strategy/viability.js';
import { moveEffect } from '../src/pokemon/mechanics.js';
import { battle, ours } from './helpers.js';

const support = (moves: string[]) => ours('Misdreavus', 90, moves, 'Levitate', 'Eviolite', 'Fairy');
const check = (b: ReturnType<typeof battle>, move: string) => effectViability(b.state, move, b.me(), 'p1', b.foe());
const certain = (b: ReturnType<typeof battle>, move: string) => check(b, move)?.certain ?? [];
const possible = (b: ReturnType<typeof battle>, move: string) => check(b, move)?.possible ?? [];

test('a status a type cannot take is reported before the move is chosen', () => {
  // Skeledirge is Fire/Ghost, Heatran Fire/Steel, Great Tusk Ground/Fighting, Garganacl pure Rock.
  assert.deepEqual(certain(battle([support(['Will-O-Wisp'])], 'Skeledirge'), 'Will-O-Wisp'), ['Fire/Ghost cannot be burned']);
  assert.deepEqual(certain(battle([support(['Toxic'])], 'Heatran'), 'Toxic'), ['Fire/Steel cannot be poisoned'],
    'the plain reason is given once, not repeated as a type-chart immunity');
  assert.match(certain(battle([support(['Thunder Wave'])], 'Great Tusk', 78), 'Thunder Wave').join(' '), /immune to Electric/);
  assert.deepEqual(certain(battle([support(['Will-O-Wisp'])], 'Garganacl'), 'Will-O-Wisp'), [], 'Rock types can be burned');
});

test('Trick and other ordinary status moves ignore the damage type chart', () => {
  const rotom = battle([ours('Rotom', 88, ['Trick', 'Thunder Wave'], 'Levitate', 'Choice Scarf', 'Ghost')], 'Umbreon');
  assert.deepEqual(certain(rotom, 'Trick'), [], 'Psychic Trick works on Dark Umbreon');
  const hypnosis = battle([support(['Hypnosis'])], 'Umbreon');
  assert.deepEqual(certain(hypnosis, 'Hypnosis'), [], 'Psychic Hypnosis also ignores Dark type immunity');
  const ground = battle([support(['Thunder Wave'])], 'Great Tusk');
  assert.match(certain(ground, 'Thunder Wave').join(' '), /immune to Electric/, 'Thunder Wave explicitly obeys type immunity');
  const prankster = battle([ours('Klefki', 88, ['Trick'], 'Prankster', 'Choice Scarf', 'Steel')], 'Umbreon');
  assert.match(certain(prankster, 'Trick').join(' '), /Prankster/, 'Dark still blocks Prankster boosted status');
});

test('powder moves are reported against Grass types', () => {
  const grass = battle([ours('Amoonguss', 82, ['Spore'], 'Regenerator', 'Rocky Helmet', 'Steel')], 'Cacturne');
  assert.match(certain(grass, 'Spore').join(' '), /Grass types ignore powder/);
  assert.deepEqual(certain(battle([support(['Spore'])], 'Garganacl'), 'Spore'), []);
});

test('a target that already has a status cannot take another', () => {
  const b = battle([support(['Will-O-Wisp'])], 'Garganacl');
  assert.deepEqual(certain(b, 'Will-O-Wisp'), []);
  b.feed('|-status|p2a: Foe|par');
  assert.match(certain(b, 'Will-O-Wisp').join(' '), /already has a status condition \(par\)/);
});

test('recovery, Substitute and capped boosts are reported as accomplishing nothing', () => {
  const b = battle([ours('Shaymin', 82, ['Synthesis', 'Substitute', 'Growth'], 'Natural Cure', 'Leftovers', 'Grass')], 'Garganacl');
  assert.match(certain(b, 'Synthesis').join(' '), /already at full HP/);
  b.feed(b.request(3, Math.floor(b.me().exactHP!.max / 2)));
  assert.deepEqual(certain(b, 'Synthesis'), [], 'at half HP it heals normally');
  assert.deepEqual(certain(b, 'Substitute'), [], 'and a Substitute is affordable');
  b.feed(b.request(5, Math.floor(b.me().exactHP!.max / 5)));
  assert.match(certain(b, 'Substitute').join(' '), /more than a quarter/);
  b.feed('|-start|p1a: Shaymin|Substitute');
  assert.match(certain(b, 'Substitute').join(' '), /already behind a Substitute/);
  b.feed('|-setboost|p1a: Shaymin|atk|6');
  b.feed('|-setboost|p1a: Shaymin|spa|6');
  assert.match(certain(b, 'Growth').join(' '), /already at its limit/);
});

test('Heal Block makes Rest and ordinary recovery fail', () => {
  const b = battle([ours('Dondozo', 78, ['Rest', 'Sleep Talk'], 'Unaware', 'Leftovers', 'Fairy')], 'Arceus-Fighting');
  b.me().hpPercent = 50;
  b.me().exactHP!.current = Math.round(b.me().exactHP!.max / 2);
  b.me().volatiles.healblock = { sinceTurn: 1, data: null };
  assert.match(certain(b, 'Rest').join(' '), /Heal Block/);
  assert.match(certain(b, 'Recover').join(' '), /Heal Block/);
});

test('delayed healing, damaging moves and Magic Guard retain their real effects', () => {
  const wish = battle([ours('Jirachi', 86, ['Wish'], 'Serene Grace', 'Leftovers', 'Steel')], 'Snorlax');
  assert.deepEqual(certain(wish, 'Wish'), [], 'Wish can heal a teammate next turn at full HP');
  const fighter = battle([ours('Gurdurr', 86, ['Close Combat'], 'Guts', 'Eviolite', 'Fighting')], 'Snorlax');
  fighter.me().boosts.def = -6; fighter.me().boosts.spd = -6;
  assert.deepEqual(certain(fighter, 'Close Combat'), [], 'a capped self drop does not erase the attack');
  const guarded = battle([support(['Will-O-Wisp'])], 'Clefable');
  guarded.foe().ability = 'Magic Guard';
  const assessment = check(guarded, 'Will-O-Wisp')!;
  assert.deepEqual(assessment.certain, [], 'burn still lowers physical Attack');
  assert.match(assessment.limited[0]!.reason, /blocks burn damage, but burn still lowers physical Attack/);
});

test('hazards, screens and weather already in place are reported', () => {
  const b = battle([ours('Skarmory', 84, ['Stealth Rock', 'Spikes', 'Sunny Day'], 'Sturdy', 'Leftovers', 'Dragon')], 'Garganacl');
  assert.deepEqual(certain(b, 'Stealth Rock'), []);
  b.feed('|-sidestart|p2: Foe|move: Stealth Rock');
  assert.match(certain(b, 'Stealth Rock').join(' '), /already at its limit/);
  b.feed('|-sidestart|p2: Foe|move: Spikes');
  assert.deepEqual(certain(b, 'Spikes'), [], 'one layer of Spikes still leaves room for two more');
  b.feed('|-sidestart|p2: Foe|move: Spikes');
  b.feed('|-sidestart|p2: Foe|move: Spikes');
  assert.match(certain(b, 'Spikes').join(' '), /already at its limit/);
  b.feed('|-weather|SunnyDay');
  assert.match(certain(b, 'Sunny Day').join(' '), /SunnyDay is already active/);
});

test('Safeguard and Misty Terrain are reported as protecting the target from status', () => {
  const b = battle([support(['Will-O-Wisp'])], 'Garganacl');
  b.feed('|-sidestart|p2: Foe|move: Safeguard');
  assert.match(certain(b, 'Will-O-Wisp').join(' '), /Safeguard/);
  const misty = battle([support(['Will-O-Wisp'])], 'Garganacl');
  misty.feed('|-fieldstart|move: Misty Terrain');
  assert.match(certain(misty, 'Will-O-Wisp').join(' '), /Misty Terrain/);
});

test('hidden abilities that would block a move are possibilities with a frequency, not claims', () => {
  const bounce = possible(battle([support(['Will-O-Wisp'])], 'Hatterene', 85), 'Will-O-Wisp');
  assert.ok(bounce.some(p => /Magic Bounce/.test(p.reason)), JSON.stringify(bounce));
  assert.ok(bounce.every(p => p.probability === null || (p.probability > 0 && p.probability <= 1)));
  const gold = possible(battle([support(['Will-O-Wisp'])], 'Gholdengo', 77), 'Will-O-Wisp');
  assert.ok(gold.some(p => /Good as Gold/.test(p.reason)));
  const salt = possible(battle([support(['Will-O-Wisp'])], 'Garganacl'), 'Will-O-Wisp');
  assert.ok(salt.some(p => /Purifying Salt/.test(p.reason)));
  const sleep = possible(battle([ours('Amoonguss', 82, ['Spore'], 'Regenerator', 'Rocky Helmet', 'Steel')], 'Hypno', 95), 'Spore');
  assert.ok(sleep.some(p => /Insomnia/.test(p.reason)), JSON.stringify(sleep));
  // A move the ability has nothing to do with stays unflagged.
  assert.deepEqual(possible(battle([support(['Shadow Ball'])], 'Garganacl'), 'Shadow Ball'), []);
});

test('weather-dependent recovery reports the amount it would actually restore', () => {
  assert.equal(moveEffect('Synthesis', 300, null)!.healPercentOfMaxHP, 50);
  assert.equal(moveEffect('Synthesis', 300, 'SunnyDay')!.healPercentOfMaxHP, 66.7);
  assert.equal(moveEffect('Synthesis', 300, 'RainDance')!.healPercentOfMaxHP, 25);
  assert.equal(moveEffect('Synthesis', 300, 'RainDance')!.healHPIfKnown, 75);
  assert.equal(moveEffect('Synthesis', 300, null)!.healVariesWithWeather, true);
  assert.equal(moveEffect('Shore Up', 300, 'Sandstorm')!.healPercentOfMaxHP, 66.7);
  assert.equal(moveEffect('Shore Up', 300, 'RainDance')!.healPercentOfMaxHP, 50, 'only sand changes Shore Up');
  assert.equal(moveEffect('Roost', 300, 'RainDance')!.healPercentOfMaxHP, 50, 'fixed fractions ignore weather');
  assert.equal(moveEffect('Rest', 300)!.healPercentOfMaxHP, 100);
  assert.match(moveEffect('Strength Sap', 300)!.healingIsVariable as string, /target's current Attack/);
  assert.match(moveEffect('Wish', 300)!.healingIsVariable as string, /next turn/);
});

test('an unremarkable move reports nothing, and that is not a promise it will work', () => {
  const b = battle([support(['Shadow Ball'])], 'Garganacl');
  assert.equal(check(b, 'Shadow Ball'), null);
  assert.equal(effectViability(b.state, 'Not A Move', b.me(), 'p1', b.foe()), null);
});

test('moves whose defining effect lives in code are described, not left as a bare damage number', () => {
  // Explosion is not a free 250 power hit: it spends the user.
  assert.equal(moveEffect('Explosion', 300)!.userFaints, 'whether or not it hits');
  assert.equal(moveEffect('Healing Wish', 300)!.userFaints, 'if it hits');
  // Scale Shot keeps its boosts under a field the generic reader missed.
  assert.deepEqual(moveEffect('Scale Shot', 300)!.listedUserBoosts, { def: -1, spe: 1 });
  // A charge turn means nothing lands now, except where the weather skips it.
  assert.match(String(moveEffect('Solar Beam', 300)!.chargesFirst), /spends this turn charging/);
  assert.equal(moveEffect('Solar Beam', 300, 'SunnyDay')!.chargesFirst, undefined);
  assert.match(String(moveEffect('Meteor Beam', 300)!.chargesFirst), /charging/);
  assert.deepEqual(moveEffect('Meteor Beam', 300)!.listedUserBoosts, { spa: 1 });
  assert.match(String(moveEffect('Future Sight', 300)!.alsoDoes), /two turns from now/);
  assert.match(String(moveEffect('Knock Off', 300)!.alsoDoes), /removes the target's held item/);
});

test('Fake Out is reported as failing after the first turn out, and Poltergeist without an item', () => {
  const b = battle([ours('Mew', 80, ['Fake Out', 'Poltergeist'], 'Synchronize', 'Leftovers', 'Psychic')], 'Garchomp');
  assert.deepEqual(certain(b, 'Fake Out'), [], 'on the lead\'s first turn it works');
  b.feed('|turn|2');
  assert.match(certain(b, 'Fake Out').join(' '), /only works on the user's first turn/);
  assert.ok(!certain(b, 'Poltergeist').some(r => /no longer holds/.test(r)), 'an unrevealed item is not an absent one');
  b.feed('|-enditem|p2a: Foe|Air Balloon');
  assert.match(certain(b, 'Poltergeist').join(' '), /no longer holds an item/);
});

import { statusThatHelpsThem } from '../src/strategy/dominance.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';

test('a status that Guts and its kind turn into a boost is reported as helping the target', () => {
  // Conkeldurr's random-battle sets all carry Guts; Ursaring's are split between Guts and Quick Feet.
  const conk = battle([support(['Will-O-Wisp', 'Toxic', 'Thunder Wave', 'Scald'])], 'Conkeldurr');
  assert.match(certain(conk, 'Will-O-Wisp').join(' ') + possible(conk, 'Will-O-Wisp').map(p => p.reason).join(' '),
    /Guts turns the burn into 1.5× Attack and ignores the burn's halving/);
  assert.match(possible(conk, 'Scald').map(p => p.reason).join(' '), /its 30% chance of a burn works against us: Guts/,
    'an attack\'s chance to burn is a cost here, not a bonus');
  conk.foe().ability = 'Guts';
  assert.match(certain(conk, 'Thunder Wave').join(' '), /Guts turns the paralysis into 1.5× Attack, so it hits harder, so this helps the target/);
  const ursaring = battle([support(['Thunder Wave'])], 'Ursaring');
  assert.match(possible(ursaring, 'Thunder Wave').map(p => p.reason).join(' '), /Quick Feet .* the paralysis no longer slows it/);
});

test('a move whose only effect is a status the target thrives on is skipped', () => {
  const guard = (b: ReturnType<typeof battle>, moves: string[]) => {
    const payload = b.payload(3, b.me().exactHP?.max ?? 100);
    payload.active[0]!.moves = moves.map(m => ({ move: m, id: m.toLowerCase().replace(/[^a-z0-9]/g, '') }));
    const request = parseChoiceRequest(JSON.stringify(payload))!;
    const actions = generateLegalActions(request);
    return { skipped: statusThatHelpsThem({ state: b.state, legalActions: actions, request }), actions };
  };
  const labels = (r: ReturnType<typeof guard>) => [...r.skipped.keys()].map(k => r.actions.find(a => a.id === k)!.label);
  const conk = battle([support(['Will-O-Wisp', 'Thunder Wave', 'Shadow Ball'])], 'Conkeldurr');
  const r = guard(conk, ['Will-O-Wisp', 'Thunder Wave', 'Shadow Ball']);
  assert.deepEqual(labels(r), ['Will-O-Wisp', 'Thunder Wave'], 'every Conkeldurr set has Guts; the attack is left alone');
  assert.match([...r.skipped.values()][0]!.reason, /Conkeldurr almost certainly has Guts: .*so Will-O-Wisp helps it/);
  assert.deepEqual(labels(guard(battle([support(['Toxic'])], 'Gliscor', 80), ['Toxic'])), ['Toxic'], 'Poison Heal turns it into healing');
  assert.deepEqual(labels(guard(battle([support(['Toxic', 'Will-O-Wisp'])], 'Zangoose'), ['Toxic', 'Will-O-Wisp'])), ['Toxic'],
    'Toxic Boost answers poison only; a burn still halves Zangoose');
  assert.deepEqual(labels(guard(battle([support(['Thunder Wave'])], 'Ursaring'), ['Thunder Wave'])), [], 'a coin flip between abilities is left to judgement');
  conk.foe().status = 'brn';
  assert.equal(guard(conk, ['Will-O-Wisp']).skipped.size, 0, 'nothing to land on a Pokémon that already has a status');
  const suppressed = battle([support(['Will-O-Wisp'])], 'Conkeldurr');
  suppressed.foe().abilitySuppressed = true;
  assert.equal(guard(suppressed, ['Will-O-Wisp']).skipped.size, 0, 'with its ability suppressed, the burn does what it is for');
});
