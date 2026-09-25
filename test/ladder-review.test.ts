import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asleepWhileTheyBoost, outhealed, setupIntoPhazer } from '../src/strategy/dominance.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { battle, ours } from './helpers.js';

const decide = (b: ReturnType<typeof battle>, hp?: number, activeIndex = 0) => {
  const request = parseChoiceRequest(JSON.stringify(b.payload(9, hp ?? b.me().exactHP?.max ?? 100, activeIndex)))!;
  return { state: b.state, legalActions: generateLegalActions(request), request };
};
const labels = (input: ReturnType<typeof decide>, skipped: Map<string, unknown>) =>
  [...skipped.keys()].map(k => input.legalActions.find(a => a.id === k)!.label).sort();

test('a healer that restores more than every hit is not attacked forever', () => {
  const roster = [ours('Gurdurr', 86, ['Knock Off', 'Drain Punch', 'Mach Punch', 'Defog'], 'Guts', 'Eviolite', 'Fighting'),
    ours('Rayquaza', 72, ['Dragon Ascent', 'Dragon Dance', 'Extreme Speed', 'Earthquake'], 'Air Lock', 'Life Orb', 'Flying')];
  const b = battle(roster, 'Illumise', 97);
  b.feed('|-enditem|p2a: Foe|Leftovers|[from] move: Knock Off'); b.feed('|-damage|p2a: Foe|40/100');
  const roost = (turn: number) => { b.feed('|move|p2a: Foe|Roost|p2a: Foe'); b.feed('|-heal|p2a: Foe|90/100'); b.feed(`|turn|${turn}`); };
  roost(2);
  assert.equal(outhealed(decide(b)).size, 0, 'one heal is not yet a stall');
  roost(3);
  const input = decide(b), skipped = outhealed(input);
  assert.deepEqual(labels(input, skipped), ['Defog', 'Drain Punch', 'Knock Off', 'Mach Punch'], 'with the item gone, Knock Off is one more attack');
  assert.match((skipped.get(input.legalActions.find(a => a.label === 'Knock Off')!.id) as { reason: string }).reason,
    /Illumise has healed 2 times against Gurdurr, and each heal restores 50% while our best hit, .* does at most [\d.]+%/);
  b.feed('|-status|p2a: Foe|slp'); b.feed('|turn|4');
  assert.equal(outhealed(decide(b)).size, 0, 'asleep, it cannot reach its heal, so the attacks land for free');
  b.feed('|-curestatus|p2a: Foe|slp|[msg]');
  b.feed('|-damage|p2a: Foe|5/100');
  assert.equal(outhealed(decide(b)).size, 0, 'a certain knockout ends the stall, so nothing is skipped');
});

test('a sleeper is not left in while the opponent sets up', () => {
  const roster = [ours('Reshiram', 76, ['Blue Flare', 'Draco Meteor', 'Earth Power', 'Will-O-Wisp'], 'Turboblaze', 'Heavy-Duty Boots', 'Fire'),
    ours('Gardevoir', 86, ['Moonblast', 'Psyshock', 'Mystical Fire', 'Calm Mind'], 'Trace', 'Life Orb', 'Fairy')];
  const b = battle(roster, 'Darkrai', 77);
  b.feed('|move|p2a: Foe|Hypnosis|p1a: Reshiram'); b.feed('|-status|p1a: Reshiram|slp'); b.feed('|turn|2');
  const input = decide(b), skipped = asleepWhileTheyBoost(input);
  assert.deepEqual(labels(input, skipped), ['Blue Flare', 'Draco Meteor', 'Earth Power', 'Will-O-Wisp'], 'Darkrai carries Nasty Plot in every sampled set');
  assert.match((skipped.values().next().value as { reason: string }).reason, /Reshiram is asleep and cannot wake this turn, and Darkrai has Nasty Plot/);
  b.state.sides.p1.team[0]!.sleepFromRest = true;
  assert.equal(asleepWhileTheyBoost(decide(b)).size, 0, 'Rest is a known two turns, a plan rather than a gamble');
});

test('boosting into a phazer that has shown itself, or that always carries Haze, is skipped', () => {
  const gogoat = (ability: string) => [ours('Gogoat', 88, ['Bulk Up', 'Horn Leech', 'Earthquake', 'Milk Drink'], ability, 'Leftovers', 'Ground'),
    ours('Medicham', 86, ['Close Combat', 'Zen Headbutt'], 'Pure Power', 'Choice Band', 'Fighting')];
  const skarm = battle(gogoat('Sap Sipper'), 'Skarmory', 84);
  assert.equal(setupIntoPhazer(decide(skarm)).size, 0, 'a quarter of Skarmory sets carry Whirlwind: a judgement call until it is seen');
  skarm.feed('|move|p2a: Foe|Whirlwind|p1a: Gogoat'); skarm.feed('|turn|2');
  const input = decide(skarm);
  assert.deepEqual(labels(input, setupIntoPhazer(input)), ['Bulk Up'], 'Milk Drink heals; only the boost is thrown away');
  const cups = battle(gogoat('Suction Cups'), 'Skarmory', 84);
  cups.feed('|move|p2a: Foe|Whirlwind|p1a: Gogoat'); cups.feed('|turn|2');
  assert.equal(setupIntoPhazer(decide(cups)).size, 0, 'Suction Cups keeps us in');
  assert.equal(setupIntoPhazer(decide(battle(gogoat('Suction Cups'), 'Toxapex', 86))).size, 1, 'but not in the face of Haze');
});

import { setupRaceLost } from '../src/strategy/dominance.js';
import { residuals } from '../src/strategy/residual.js';
import { effectViability } from '../src/strategy/viability.js';

test('a Leech Seed and Harvest stall is counted: the seeder heals, the berry grows back, and seeding a Grass type fails', () => {
  const roster = [ours('Tropius', 88, ['Leech Seed', 'Substitute', 'Protect', 'Air Slash'], 'Harvest', 'Sitrus Berry', 'Steel')];
  const b = battle(roster, 'Snorlax', 84);
  b.feed('|move|p1a: Tropius|Leech Seed|p2a: Foe'); b.feed('|-start|p2a: Foe|move: Leech Seed'); b.feed('|turn|2');
  const healing = residuals(b.state, b.me(), 'p1')!;
  const drain = healing.sources.find(x => x.source === 'Leech Seed draining the opponent');
  assert.ok(drain && drain.percent > 5, `the seeder gains what the seed drains: ${JSON.stringify(healing.sources)}`);
  assert.ok(residuals(b.state, b.foe(), 'p2')!.sources.some(x => x.source === 'Leech Seed' && x.percent < 0), 'and the seeded side still loses it');
  // Tropius eats its Sitrus Berry at half HP; Harvest grows it back half the time, every time in sun.
  b.feed(`|-damage|p1a: Tropius|${Math.round(roster[0]!.maxHP * 0.4)}/${roster[0]!.maxHP}`);
  b.feed('|-enditem|p1a: Tropius|Sitrus Berry|[eat]'); b.state.sides.p1.team[0]!.item = '';
  assert.equal(b.me().lastBerry, 'Sitrus Berry');
  const harvest = residuals(b.state, b.me(), 'p1')!.sources.find(x => x.source.startsWith('Harvest'));
  assert.equal(harvest?.percent, 12.5, 'a quarter of max HP, half the time');
  b.feed('|-weather|SunnyDay'); b.state.field.weather = 'SunnyDay';
  assert.equal(residuals(b.state, b.me(), 'p1')!.sources.find(x => x.source.startsWith('Harvest'))?.percent, 25, 'every turn in sun');
  b.feed('|-enditem|p1a: Tropius|Sitrus Berry|[from] move: Knock Off');
  assert.equal(b.me().lastBerry, 'Sitrus Berry', 'a berry knocked off is not one it ate, so it does not replace the last one eaten');

  const grass = battle(roster, 'Sinistcha', 84);
  assert.ok(effectViability(grass.state, 'Leech Seed', grass.me(), 'p1', grass.foe())!.certain.includes('Grass types cannot be seeded'));
  const seeded = battle(roster, 'Snorlax', 84);
  seeded.feed('|-start|p2a: Foe|move: Leech Seed');
  assert.ok(effectViability(seeded.state, 'Leech Seed', seeded.me(), 'p1', seeded.foe())!.certain.includes('the target is already seeded'));
});

test('a boost that loses the Speed race to a Pokémon that boosts its own Speed is skipped', () => {
  const polt = (moves: string[]) => [ours('Polteageist-Antique', 88, moves, 'Weak Armor', 'White Herb', 'Psychic'),
    ours('Sandaconda', 88, ['Glare', 'Stone Edge', 'Earthquake', 'Stealth Rock'], 'Shed Skin', 'Leftovers', 'Ground')];
  const b = battle(polt(['Shell Smash', 'Stored Power', 'Shadow Ball', 'Strength Sap']), 'Oricorio', 92);
  assert.equal(setupRaceLost(decide(b)).size, 0, 'no Speed-raising move seen yet: a judgement call');
  b.feed('|move|p2a: Foe|Quiver Dance|p2a: Foe'); b.feed('|-boost|p2a: Foe|spa|1'); b.feed('|-boost|p2a: Foe|spd|1'); b.feed('|-boost|p2a: Foe|spe|1'); b.feed('|turn|2');
  const input = decide(b), skipped = setupRaceLost(input);
  assert.deepEqual(labels(input, skipped), ['Shell Smash']);
  assert.match((skipped.values().next().value as { reason: string }).reason, /Oricorio has Quiver Dance; after Shell Smash we would have \d+ Speed and it at least \d+ after one more/);
  b.state.field.trickRoom = true;
  assert.equal(setupRaceLost(decide(b)).size, 0, 'under Trick Room the slower side moves first');
  b.state.field.trickRoom = false;
  const scizor = battle([ours('Scizor', 82, ['Swords Dance', 'Bullet Punch', 'Close Combat', 'Knock Off'], 'Technician', 'Life Orb', 'Steel')], 'Oricorio', 92);
  scizor.feed('|move|p2a: Foe|Quiver Dance|p2a: Foe'); scizor.feed('|-boost|p2a: Foe|spe|1'); scizor.feed('|turn|2');
  assert.equal(setupRaceLost(decide(scizor)).size, 0, 'a priority attack can win the race without outspeeding');
});

test('a defensive boost, or one taken when the opponent already outspeeds us, is not a race lost', () => {
  // 2687157918: the guard skipped Chimecho's Cosmic Power five times while one Dragon Dance Tropius swept the team.
  const chime = battle([ours('Chimecho', 93, ['Cosmic Power', 'Stored Power', 'Dazzling Gleam', 'Recover'], 'Levitate', 'Leftovers', 'Steel')], 'Tropius', 91);
  chime.feed('|move|p2a: Foe|Dragon Dance|p2a: Foe'); chime.feed('|-boost|p2a: Foe|atk|1'); chime.feed('|-boost|p2a: Foe|spe|1'); chime.feed('|turn|2');
  assert.equal(setupRaceLost(decide(chime)).size, 0, 'Defense is how a slower Pokémon beats a faster one');
  const gallade = () => battle([ours('Gallade', 86, ['Swords Dance', 'Sacred Sword', 'Psycho Cut', 'Leaf Blade'], 'Sharpness', 'Life Orb', 'Fighting')], 'Tropius', 91);
  const slower = gallade();
  slower.feed('|move|p2a: Foe|Dragon Dance|p2a: Foe'); slower.feed('|-boost|p2a: Foe|atk|1'); slower.feed('|-boost|p2a: Foe|spe|1'); slower.feed('|turn|2');
  assert.equal(setupRaceLost(decide(slower)).size, 0, 'at +1 it already outspeeds Gallade, so Swords Dance loses no race');
  const faster = gallade();
  faster.feed('|move|p2a: Foe|Dragon Dance|p2a: Foe'); faster.feed('|turn|2');
  const input = decide(faster);
  assert.deepEqual(labels(input, setupRaceLost(input)), ['Swords Dance'], 'Gallade moves first now; one more Dragon Dance takes that away');
});

import { freeKnockoutPassedUp, healAtFullHP } from '../src/strategy/dominance.js';

test('a certain first-strike knockout is not passed up for setup or utility', () => {
  const mouse = [ours('Maushold-Four', 80, ['Tidy Up', 'Population Bomb', 'Bite', 'Encore'], 'Technician', 'Wide Lens', 'Normal')];
  const b = battle(mouse, 'Uxie', 85);
  b.feed('|-damage|p2a: Foe|17/100'); b.feed('|turn|2');
  assert.equal(freeKnockoutPassedUp(decide(b)).size, 0, 'Tera Steel, Fairy or Dark would turn Bite from super effective into no knockout');
  // Their one Tera spent earlier, on another Pokémon: Uxie keeps its Psychic typing, so Bite stays super effective.
  b.feed('|switch|p2a: Mew|Mew, L80|100/100'); b.feed('|-terastallize|p2a: Mew|Fairy'); b.feed('|turn|3');
  b.feed('|switch|p2a: Foe|Uxie, L85|17/100'); b.feed('|turn|4');
  const input = decide(b), skipped = freeKnockoutPassedUp(input);
  assert.deepEqual(labels(input, skipped), ['Encore', 'Population Bomb', 'Tidy Up'],
    'Population Bomb knocks Uxie out only on some rolls, and Bite costs nothing Population Bomb would not');
  assert.match((skipped.values().next().value as { reason: string }).reason, /Bite moves first and knocks Uxie out at every sampled roll, whatever Tera it could choose/);
  const healthy = battle(mouse, 'Uxie', 85);
  assert.equal(freeKnockoutPassedUp(decide(healthy)).size, 0, 'no certain knockout on a healthy Uxie');
  b.feed('|-start|p2a: Foe|Substitute');
  assert.equal(freeKnockoutPassedUp(decide(b)).size, 0, 'a knockout of a Substitute is not a knockout');
});

test('a healing move at full HP is skipped, and only then', () => {
  const goat = [ours('Gogoat', 88, ['Milk Drink', 'Bulk Up', 'Horn Leech', 'Earthquake'], 'Sap Sipper', 'Leftovers', 'Ground')];
  const b = battle(goat, 'Snorlax', 84);
  const full = decide(b);
  assert.deepEqual(labels(full, healAtFullHP(full)), ['Milk Drink']);
  const hurt = decide(b, Math.round(goat[0]!.maxHP * 0.8));
  b.feed(b.request(9, Math.round(goat[0]!.maxHP * 0.8)));
  assert.equal(healAtFullHP(decide(b, Math.round(goat[0]!.maxHP * 0.8))).size, 0, 'at 80% it restores something');
  void hurt;
});

test('a heal at full HP is kept when a faster opponent hits first, and outhealed leaves our heals alone', () => {
  // 2687703481: Florges at full HP, slower than Latias. A heal after Psyshock restores it; Draco Meteor cannot touch
  // a Fairy, so with only that shown the heal is idle.
  const florges = [ours('Florges', 85, ['Moonblast', 'Calm Mind', 'Synthesis', 'Tera Blast'], 'Flower Veil', 'Leftovers', 'Ground'),
    ours('Ditto', 87, ['Transform'], 'Imposter', 'Choice Scarf', 'Steel')];
  const b = battle(florges, 'Latias', 79);
  b.feed('|move|p2a: Foe|Draco Meteor|p1a: Florges'); b.feed('|-immune|p1a: Florges'); b.feed('|turn|2');
  assert.deepEqual(labels(decide(b), healAtFullHP(decide(b))), ['Synthesis'], 'only an attack we are immune to is shown');
  b.feed('|move|p2a: Foe|Psyshock|p1a: Florges'); b.feed('|turn|3');
  assert.equal(healAtFullHP(decide(b)).size, 0, 'Latias moves first with Psyshock, so Synthesis restores that hit');
  // Two Recovers against Florges, each more than Moonblast does into +4 Special Defense: the attacks are outhealed,
  // and Synthesis is not an attack.
  b.feed('|-boost|p2a: Foe|spd|4');
  for (const turn of [4, 5]) { b.feed('|-damage|p2a: Foe|50/100'); b.feed('|move|p2a: Foe|Recover|p2a: Foe'); b.feed('|-heal|p2a: Foe|100/100'); b.feed(`|turn|${turn}`); }
  const input = decide(b), stalled = labels(input, outhealed(input));
  assert.ok(stalled.includes('Moonblast'), `the attacks are skipped: ${stalled.join(', ')}`);
  assert.ok(!stalled.includes('Synthesis'), 'our own heal is left to healAtFullHP and the search');
});

import { incomingThreats } from '../src/strategy/threat.js';
import { damageRange } from '../src/strategy/damage.js';
import { speedSummary } from '../src/strategy/speed.js';
import { choiceLock } from '../src/strategy/stalling.js';

test('an Imposter Ditto becomes a Choice Scarf copy of our Pokémon, and every estimate follows it', () => {
  // Kingdra rather than Rayquaza: Air Lock would make every Speed estimate decline, copied or not.
  const team = [ours('Kingdra', 86, ['Wave Crash', 'Outrage', 'Dragon Dance', 'Iron Head'], 'Sniper', 'Life Orb', 'Water'),
    ours('Snorlax', 84, ['Body Slam', 'Curse', 'Rest', 'Sleep Talk'], 'Thick Fat', 'Leftovers', 'Ghost')];
  const b = battle(team, 'Ditto', 87);
  b.feed(b.request(2, team[0]!.maxHP));
  b.feed('|-transform|p2a: Foe|p1a: Kingdra|[from] ability: Imposter'); b.feed('|turn|2');
  const ditto = b.foe();
  assert.equal(ditto.transformedInto, 'Kingdra');
  assert.deepEqual(ditto.copiedMoves, ['Wave Crash', 'Outrage', 'Dragon Dance', 'Iron Head'], 'all four of our moves, not only the ones it has used');
  assert.equal(ditto.ability, 'Sniper', 'the copied ability, not Imposter');
  assert.equal(ditto.baseAbility, 'Imposter');
  assert.equal(ditto.stats.atk, b.me().stats.atk, 'our exact stats');
  const threat = incomingThreats(b.state, b.me(), 'p1', 4)!;
  assert.ok(threat.damagingMoves.some(m => m.move === 'Outrage' && m.percentOfMaxHP[1] > 30), `its copy of our moves hurts: ${JSON.stringify(threat.damagingMoves)}`);
  assert.ok(damageRange(b.state, 'Outrage'), 'and ours can be priced against it');
  assert.equal(speedSummary(b.state, b.me()).relation, 'slower-than-all-samples', 'its Choice Scarf outspeeds the Pokémon it copied');
  b.feed('|move|p2a: Foe|Outrage|p1a: Kingdra'); b.feed('|turn|3');
  assert.deepEqual([choiceLock(b.foe())?.lockedInto, choiceLock(b.foe())?.probability], ['Outrage', 1], 'locked by the Scarf into its first move');
  b.feed('|switch|p2a: Other|Snorlax, L84|100/100'); b.feed('|turn|4');
  const out = b.state.sides.p2.team.find(p => p.species === 'Ditto')!;
  assert.equal(out.transformedInto, null); assert.deepEqual(out.stats, {}); assert.equal(out.ability, 'Imposter', 'back to itself on leaving');
});

test('boosting with their Ditto on the bench is flagged: Imposter would copy the boosts', () => {
  const team = [ours('Kingdra', 86, ['Wave Crash', 'Outrage', 'Dragon Dance', 'Iron Head'], 'Sniper', 'Life Orb', 'Water')];
  const b = battle(team, 'Snorlax', 84);
  const warned = () => (effectViability(b.state, 'Dragon Dance', b.me(), 'p1', b.foe())?.possible ?? []).some(p => /copy these boosts with Imposter/.test(p.reason));
  assert.equal(warned(), false, 'no Ditto seen');
  b.feed('|switch|p2a: Ditto|Ditto, L87|100/100'); b.feed('|turn|2');
  b.feed('|switch|p2a: Foe|Snorlax, L84|100/100'); b.feed('|turn|3');
  assert.equal(warned(), true, 'a healthy Ditto waiting on the bench');
});

import { hitChancePercent } from '../src/pokemon/mechanics.js';
import { certainty } from '../src/strategy/threat.js';
import { extractFeatures } from '../src/strategy/features.js';

test('hit chance counts evasion, No Guard and the target\'s own items and abilities', () => {
  const b = battle([ours('Terrakion', 79, ['Stone Edge', 'Close Combat', 'Toxic'], 'Justified', 'Choice Band', 'Ground')], 'Charizard', 84);
  const me = b.me(), foe = b.foe();
  assert.equal(hitChancePercent('Stone Edge', null, me, foe), 80);
  foe.item = 'Bright Powder'; assert.equal(hitChancePercent('Stone Edge', null, me, foe), 72);
  foe.item = null; foe.ability = 'Sand Veil';
  assert.equal(hitChancePercent('Stone Edge', 'Sandstorm', me, foe), 64, 'Sand Veil only in sand');
  assert.equal(hitChancePercent('Stone Edge', null, me, foe), 80);
  foe.ability = 'No Guard'; assert.equal(hitChancePercent('Stone Edge', null, me, foe), 100, 'No Guard on either side lands everything');
  foe.ability = null; foe.boosts.evasion = 1;
  assert.equal(hitChancePercent('Stone Edge', null, me, foe), 60, 'a raised evasion');
  me.ability = 'Keen Eye'; assert.equal(hitChancePercent('Stone Edge', null, me, foe), 80, 'Keen Eye reads through it');
  me.ability = 'Justified'; foe.boosts.evasion = 0; me.boosts.accuracy = 1;
  assert.equal(hitChancePercent('Stone Edge', null, me, foe), 100);
  foe.ability = 'Wonder Skin'; me.boosts.accuracy = 0;
  assert.equal(hitChancePercent('Will-O-Wisp', null, me, foe), 50, 'Wonder Skin halves a status move');
});

test('a knockout that needs a move to hit is not called certain, and ours is priced with its odds', () => {
  const t = (move: string, accuracyPercent?: number) => ({ move, revealed: true, priorProbability: 1, percentOfMaxHP: [120, 140] as [number, number],
    conditionalKO: 'all-sampled-rolls', ...(accuracyPercent ? { accuracyPercent } : {}) });
  assert.deepEqual(certainty([t('Focus Blast', 70)]), { knockoutIsCertain: false, knockoutNeedsItToHit: { move: 'Focus Blast', accuracyPercent: 70 } });
  assert.deepEqual(certainty([t('Focus Blast', 70), t('Thunderbolt')]), { knockoutIsCertain: true }, 'one sure knockout is enough');
  const roster = [ours('Terrakion', 79, ['Stone Edge', 'Close Combat'], 'Justified', 'Choice Band', 'Ground')];
  const b = battle(roster, 'Charizard', 84);
  b.feed('|-damage|p2a: Foe|10/100'); b.feed('|turn|2');
  const request = parseChoiceRequest(JSON.stringify(b.payload(3, roster[0]!.maxHP)))!;
  const f = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'full') as { actions: Record<string, unknown>[] };
  const edge = f.actions.find(a => a.label === 'Stone Edge')!;
  assert.deepEqual(edge.knockoutOnlyIfItHits, { hitChancePercent: 80, knockoutChancePercent: 80 });
});

test('Stakeout doubles the hit on a Pokémon switching in, and only then', () => {
  const team = [ours('Kingdra', 86, ['Wave Crash', 'Outrage'], 'Sniper', 'Life Orb', 'Water'),
    ours('Snorlax', 84, ['Body Slam', 'Curse', 'Rest', 'Sleep Talk'], 'Thick Fat', 'Leftovers', 'Ghost')];
  const b = battle(team, 'Gumshoos', 94);
  b.feed('|move|p2a: Foe|Double-Edge|p1a: Kingdra'); b.feed('|turn|2');
  const snorlax = b.state.sides.p1.team.find(p => p.species === 'Snorlax')!;
  const hit = () => incomingThreats(b.state, snorlax, 'p1', 4)!.damagingMoves.find(m => m.move === 'Double-Edge')!.percentOfMaxHP[1];
  b.foe().ability = 'Strong Jaw';
  const plain = hit();
  b.foe().ability = 'Stakeout';
  const staked = hit();
  assert.ok(staked > plain * 1.8 && staked < plain * 2.2, `a switch-in takes double from Stakeout: ${plain}% → ${staked}%`);
  const active = incomingThreats(b.state, b.me(), 'p1', 4)!.damagingMoves.find(m => m.move === 'Double-Edge')!.percentOfMaxHP[1];
  b.foe().ability = 'Strong Jaw';
  assert.equal(active, incomingThreats(b.state, b.me(), 'p1', 4)!.damagingMoves.find(m => m.move === 'Double-Edge')!.percentOfMaxHP[1],
    'the Pokémon already on the field takes the ordinary hit');
});

test('an Outrage lock is tracked, read as a certain next move, and ends in confusion', () => {
  const team = [ours('Kingdra', 86, ['Wave Crash', 'Outrage'], 'Sniper', 'Life Orb', 'Water'),
    ours('Sylveon', 86, ['Hyper Voice', 'Wish', 'Protect', 'Calm Mind'], 'Pixilate', 'Leftovers', 'Water')];
  const b = battle(team, 'Garchomp', 80);
  b.feed('|move|p2a: Foe|Outrage|p1a: Kingdra'); b.feed('|turn|2');
  assert.deepEqual(b.foe().rampage, { move: 'Outrage', turns: 1 });
  assert.deepEqual([choiceLock(b.foe())?.lockedInto, choiceLock(b.foe())?.probability, choiceLock(b.foe())?.certainty], ['Outrage', 1, 'rampage']);
  // With its next move certain, a Fairy switch-in is priced against Outrage alone — and takes nothing.
  const sylveon = b.state.sides.p1.team.find(p => p.species === 'Sylveon')!;
  const threat = incomingThreats(b.state, sylveon, 'p1', 4)!;
  assert.deepEqual(threat.damagingMoves.map(m => [m.move, m.percentOfMaxHP[1]]), [['Outrage', 0]]);
  b.feed('|move|p2a: Foe|Outrage|p1a: Kingdra|[from]lockedmove'); b.feed('|turn|3');
  assert.equal(b.foe().rampage?.turns, 2); assert.equal(choiceLock(b.foe())?.probability, 0.5, 'a third turn is even odds');
  b.feed('|-start|p2a: Foe|confusion|[fatigue]');
  assert.equal(b.foe().rampage, undefined, 'the lock ends in confusion');
});

test('our own Outrage warns when a Pokémon of theirs that it cannot touch is waiting', () => {
  const b = battle([ours('Kingdra', 86, ['Wave Crash', 'Outrage'], 'Sniper', 'Life Orb', 'Water')], 'Garchomp', 80);
  const warned = () => (effectViability(b.state, 'Outrage', b.me(), 'p1', b.foe())?.possible ?? []).some(p => /takes nothing from Outrage and can switch in for free/.test(p.reason));
  assert.equal(warned(), false);
  b.feed('|switch|p2a: Clefable|Clefable, L84|100/100'); b.feed('|turn|2');
  b.feed('|switch|p2a: Foe|Garchomp, L80|100/100'); b.feed('|turn|3');
  assert.equal(warned(), true, 'their Clefable, a Fairy, waits on the bench');
});

import { chargeWontFire } from '../src/strategy/dominance.js';

test('a charge move that will probably not get to fire is skipped once its Power Herb is gone', () => {
  const team = (item: string) => [ours('Iron Jugulis', 80, ['Meteor Beam', 'Hurricane', 'Dark Pulse', 'Earth Power'], 'Quark Drive', item, 'Ground'),
    ours('Feraligatr', 79, ['Liquidation', 'Ice Punch', 'Dragon Dance', 'Crunch'], 'Sheer Force', 'Life Orb', 'Water')];
  const setup = (item: string, hpPercent: number) => {
    const roster = team(item), b = battle(roster, 'Krookodile', 86);
    b.feed('|move|p2a: Foe|Gunk Shot|p1a: Iron Jugulis'); b.feed(`|-damage|p1a: Iron Jugulis|${Math.round(roster[0]!.maxHP * hpPercent / 100)}/${roster[0]!.maxHP}`);
    b.feed(b.request(3, Math.round(roster[0]!.maxHP * hpPercent / 100))); b.feed('|turn|2');
    return decide(b, Math.round(roster[0]!.maxHP * hpPercent / 100));
  };
  const input = setup('', 45), skipped = chargeWontFire(input);
  assert.deepEqual(labels(input, skipped), ['Meteor Beam']);
  assert.match((skipped.values().next().value as { reason: string }).reason, /Meteor Beam spends this turn charging, and Krookodile's Gunk Shot knocks Iron Jugulis out before it fires about \d+% of the time/);
  assert.equal(chargeWontFire(setup('Power Herb', 45)).size, 0, 'with the Power Herb it fires at once');
  assert.equal(chargeWontFire(setup('', 100)).size, 0, 'healthy enough to see it fire');
});

import { seededAndLosing } from '../src/strategy/dominance.js';

test('a seeded Pokémon losing the exchange to a Leftovers stall switches out instead of healing or attacking', () => {
  const roster = [ours('Arceus-Steel', 71, ['Judgment', 'Recover', 'Earthquake', 'Calm Mind'], 'Multitype', 'Iron Plate', 'Steel'),
    ours('Kyurem', 80, ['Freeze-Dry', 'Earth Power', 'Draco Meteor', 'Roost'], 'Pressure', 'Heavy-Duty Boots', 'Ground')];
  const hp = Math.round(roster[0]!.maxHP * 0.6);
  const setup = (seeded: boolean, ourHP = hp, foeHP = 80) => {
    const b = battle(roster, 'Wo-Chien', 83);
    b.feed('|move|p2a: Foe|Protect|p2a: Foe'); b.feed('|-singleturn|p2a: Foe|Protect'); b.feed('|turn|2');
    b.feed('|move|p2a: Foe|Stun Spore|p1a: Arceus-Steel'); b.feed('|-status|p1a: Arceus-Steel|par'); b.feed('|turn|3');
    if (seeded) { b.feed('|move|p2a: Foe|Leech Seed|p1a: Arceus-Steel'); b.feed('|-start|p1a: Arceus-Steel|move: Leech Seed'); }
    b.feed('|move|p2a: Foe|Knock Off|p1a: Arceus-Steel');
    b.feed(`|-damage|p1a: Arceus-Steel|${ourHP}/${roster[0]!.maxHP}`);
    b.feed(`|-heal|p2a: Foe|${foeHP}/100|[from] item: Leftovers`); b.feed('|turn|4');
    return decide(b, ourHP);
  };
  const input = setup(true), skipped = seededAndLosing(input);
  assert.deepEqual(labels(input, skipped), ['Calm Mind', 'Earthquake', 'Judgment', 'Recover'],
    'healing and boosting only feed the stall');
  assert.match((skipped.values().next().value as { reason: string }).reason,
    /Arceus-Steel is seeded and loses about [\d.]+% a turn, lasting about [\d.]+ turns, while Wo-Chien regains 1[89]\.\d% a turn and (would take [\d.]+ turns to knock out|outheals)/);
  assert.equal(seededAndLosing(setup(false)).size, 0, 'unseeded, there is nothing a switch would clear');
  assert.equal(seededAndLosing(setup(true, Math.round(roster[0]!.maxHP * 0.2))).size, 0, 'at 20% it is spent, not saved');
  assert.equal(seededAndLosing(setup(true, hp, 4)).size, 0, 'a certain knockout ends the stall');
});

test('a pivot move clears the seed as well as a switch, so it is never skipped', () => {
  const roster = [ours('Raging Bolt', 78, ['Draco Meteor', 'Thunderbolt', 'Volt Switch', 'Calm Mind'], 'Protosynthesis', 'Leftovers', 'Fairy'),
    ours('Glalie', 99, ['Freeze-Dry', 'Earthquake', 'Spikes', 'Taunt'], 'Inner Focus', 'Heavy-Duty Boots', 'Ice')];
  const b = battle(roster, 'Wo-Chien', 83), hp = Math.round(roster[0]!.maxHP * 0.5);
  b.feed('|move|p2a: Foe|Protect|p2a: Foe'); b.feed('|-singleturn|p2a: Foe|Protect'); b.feed('|turn|2');
  b.feed('|move|p2a: Foe|Leech Seed|p1a: Raging Bolt'); b.feed('|-start|p1a: Raging Bolt|move: Leech Seed'); b.feed('|turn|3');
  b.feed('|move|p2a: Foe|Knock Off|p1a: Raging Bolt'); b.feed(`|-damage|p1a: Raging Bolt|${hp}/${roster[0]!.maxHP}`);
  b.feed('|-enditem|p1a: Raging Bolt|Leftovers|[from] move: Knock Off');
  b.feed('|-heal|p2a: Foe|90/100|[from] item: Leftovers'); b.feed('|turn|4');
  const input = decide(b, hp), skipped = seededAndLosing(input);
  assert.ok(skipped.size > 0, 'Raging Bolt is losing this exchange');
  assert.ok(!labels(input, skipped).some(l => l.startsWith('Volt Switch')), 'Volt Switch hits and clears the seed on the way out');
});

test('Wish counts as the half it heals, so attacking into a Wish and Protect loop is skipped', () => {
  const roster = [ours('Sandy Shocks', 83, ['Volt Switch', 'Thunderbolt', 'Stealth Rock', 'Earth Power'], 'Protosynthesis', 'Heavy-Duty Boots', 'Grass'),
    ours('Hitmonlee', 88, ['Swords Dance', 'Poison Jab', 'Knock Off', 'Close Combat'], 'Unburden', 'White Herb', 'Fighting')];
  const b = battle(roster, 'Scream Tail', 88);
  const wish = (turn: number) => { b.feed('|move|p2a: Foe|Wish|p2a: Foe'); b.feed(`|turn|${turn}`); b.feed('|move|p2a: Foe|Protect|p2a: Foe'); b.feed('|-heal|p2a: Foe|80/100|[from] move: Wish|[wisher] Foe'); b.feed(`|turn|${turn + 1}`); };
  wish(2);
  assert.equal(outhealed(decide(b)).size, 0, 'one heal is not yet a stall');
  wish(4);
  const input = decide(b), skipped = outhealed(input);
  assert.deepEqual(labels(input, skipped), ['Earth Power', 'Stealth Rock', 'Thunderbolt'], 'Volt Switch leaves as a switch would');
  assert.match((skipped.values().next().value as { reason: string }).reason, /Scream Tail has healed 2 times against Sandy Shocks, and each heal restores 50%/);
});

import { setupIntoSleep, sleeperThrownAway } from '../src/strategy/dominance.js';

test('a boost is skipped in front of a sleep move that will land', () => {
  const team = (item: string) => [ours('Magearna-Original', 77, ['Flash Cannon', 'Calm Mind', 'Fleur Cannon', 'Shift Gear'], 'Soul-Heart', item, 'Fairy'),
    ours('Toedscruel', 87, ['Spore', 'Rapid Spin', 'Leaf Storm', 'Earth Power'], 'Mycelium Might', 'Leftovers', 'Water')];
  const input = decide(battle(team('Leftovers'), 'Brute Bonnet', 85)), skipped = setupIntoSleep(input);
  assert.deepEqual(labels(input, skipped), ['Calm Mind', 'Shift Gear'], 'every Brute Bonnet set carries Spore');
  assert.match((skipped.values().next().value as { reason: string }).reason, /Brute Bonnet almost certainly has Spore, and nothing stops it on Magearna-Original/);
  assert.equal(setupIntoSleep(decide(battle(team('Safety Goggles'), 'Brute Bonnet', 85))).size, 0, 'Safety Goggles stops Spore');
  const asleep = battle(team('Leftovers'), 'Brute Bonnet', 85);
  asleep.feed('|-status|p2a: Foe|slp|[from] move: Rest'); asleep.feed('|turn|2');
  assert.equal(setupIntoSleep(decide(asleep)).size, 0, 'a sleeping Brute Bonnet cannot use it');
});

test('a boost is allowed before a sleep that attacking would not prevent, when the sleep can be sat out', () => {
  // As 2686936581 opened: Iron Head did 24-29% into Regenerator and Rocky Helmet, and Spore landed all the same.
  const team = [ours('Magearna-Original', 77, ['Shift Gear', 'Fleur Cannon', 'Iron Head', 'Tera Blast'], 'Soul-Heart', 'Weakness Policy', 'Ground'),
    ours('Toedscruel', 87, ['Spore', 'Rapid Spin', 'Leaf Storm', 'Earth Power'], 'Mycelium Might', 'Leftovers', 'Water')];
  assert.equal(setupIntoSleep(decide(battle(team, 'Amoonguss', 82))).size, 0,
    'two of our best hits leave Amoonguss standing, two of its worst leave us standing, and Clear Smog cannot touch Steel');
  const hurt = battle(team, 'Amoonguss', 82);
  hurt.feed(`|-damage|p1a: Magearna-Original|${Math.round(team[0]!.maxHP * 0.3)}/${team[0]!.maxHP}`); hurt.feed('|turn|2');
  assert.deepEqual(labels(decide(hurt, Math.round(team[0]!.maxHP * 0.3)), setupIntoSleep(decide(hurt, Math.round(team[0]!.maxHP * 0.3)))), ['Shift Gear'],
    'at 30% the sleep cannot be sat out in front of Stomping Tantrum');
});

test('our only sleeper is kept alive while the opponent still has a sleep move', () => {
  const roster = [ours('Magearna-Original', 77, ['Flash Cannon', 'Calm Mind', 'Fleur Cannon', 'Shift Gear'], 'Soul-Heart', 'Leftovers', 'Fairy'),
    ours('Toedscruel', 87, ['Spore', 'Rapid Spin', 'Leaf Storm', 'Earth Power'], 'Mycelium Might', 'Leftovers', 'Water')];
  const setup = (hpPercent: number) => {
    const b = battle(roster, 'Brute Bonnet', 85), hp = Math.round(roster[0]!.maxHP * hpPercent / 100);
    b.feed('|move|p2a: Foe|Spore|p1a: Magearna-Original'); b.feed('|-status|p1a: Magearna-Original|slp|[from] move: Spore'); b.feed('|turn|2');
    b.feed('|switch|p2a: Barraskewda|Barraskewda, L84|100/100'); b.feed('|turn|3');
    b.feed('|move|p2a: Barraskewda|Waterfall|p1a: Magearna-Original'); b.feed(`|-damage|p1a: Magearna-Original|${hp}/${roster[0]!.maxHP} slp`); b.feed('|turn|4');
    return decide(b, hp);
  };
  const input = setup(25), skipped = sleeperThrownAway(input);
  assert.deepEqual(labels(input, skipped), ['Calm Mind', 'Flash Cannon', 'Fleur Cannon', 'Shift Gear']);
  assert.match((skipped.values().next().value as { reason: string }).reason, /Sleep Clause stops Brute Bonnet's Spore on the rest of the team/);
  assert.equal(sleeperThrownAway(setup(100)).size, 0, 'at full HP it survives the hit, so there is nothing to save');
});

import { afterEntry } from '../src/strategy/entry.js';
import { doomedReplacement } from '../src/strategy/dominance.js';

const veluzaAtPlusTwo = () => {
  const roster = [ours('Iron Hands', 80, ['Ice Punch', 'Swords Dance', 'Drain Punch', 'Thunder Punch'], 'Quark Drive', 'Leftovers', 'Steel'),
    ours('Latios', 78, ['Flip Turn', 'Draco Meteor', 'Luster Purge', 'Aura Sphere'], 'Levitate', 'Choice Specs', 'Steel'),
    ours('Talonflame', 83, ['Brave Bird', 'U-turn', 'Roost', 'Overheat'], 'Flame Body', 'Heavy-Duty Boots', 'Ground'),
    ours('Ditto', 87, ['Transform'], 'Imposter', 'Choice Scarf', 'Normal')];
  const b = battle(roster, 'Veluza', 86);
  b.feed('|move|p2a: Foe|Fillet Away|p2a: Foe'); b.feed('|-damage|p2a: Foe|55/100');
  for (const stat of ['atk', 'spa', 'spe']) b.feed(`|-boost|p2a: Foe|${stat}|2`);
  b.feed('|turn|2');
  return { b, roster };
};

test('our Imposter Ditto arrives as a copy of what it faces, boosts and all', () => {
  const { b } = veluzaAtPlusTwo();
  const ditto = b.state.sides.p1.team.find(p => p.species === 'Ditto')!;
  const copy = afterEntry(b.state, ditto, 'p1');
  assert.equal(copy.transformedInto, 'Veluza');
  assert.deepEqual(copy.boosts, { atk: 2, spa: 2, spe: 2 });
  assert.ok(copy.knownMoves.includes('Night Slash') && copy.knownMoves.includes('Fillet Away'), 'it copies the moves of the likely set');
  assert.equal(speedSummary(b.state, ditto).relation, 'faster-than-all-samples', 'the copied +2 with a Choice Scarf outspeeds Veluza');
  assert.equal(ditto.transformedInto, null, 'the projection leaves the battle state alone');
});

test('their Ditto copies our active Pokémon exactly, and Boots no longer hide an arrival ability', () => {
  const roster = [ours('Garchomp', 80, ['Earthquake', 'Scale Shot'], 'Rough Skin', 'Loaded Dice', 'Steel'),
    ours('Porygon-Z', 84, ['Tri Attack'], 'Download', 'Heavy-Duty Boots', 'Normal')];
  const b = battle(roster, 'Ditto', 90);
  b.feed('|switch|p2a: Blissey|Blissey, L88, F|100/100'); b.feed('|turn|2');
  const theirs = b.state.sides.p2.team.find(p => p.species === 'Ditto')!;
  const copy = afterEntry(b.state, theirs, 'p2');
  assert.equal(copy.transformedInto, 'Garchomp');
  assert.equal(copy.stats.spe, roster[0]!.stats.spe, 'our own stats are known exactly');
  const porygon = b.state.sides.p1.team.find(p => p.species === 'Porygon-Z')!;
  assert.equal(afterEntry(b.state, porygon, 'p1').boosts.atk, 1, "Download reads Blissey's lower Defense even through Heavy-Duty Boots");
});

test('a boosted sweeper is not fed doomed replacements while the answer waits', () => {
  const { b } = veluzaAtPlusTwo();
  const forced = () => {
    b.me().fainted = true;
    const r = b.payload(9, 0, 0) as unknown as { active?: unknown; forceSwitch?: boolean[]; side: { pokemon: { condition: string }[] } };
    r.side.pokemon[0]!.condition = '0 fnt'; delete r.active; r.forceSwitch = [true];
    const request = parseChoiceRequest(JSON.stringify(r))!;
    return { state: b.state, legalActions: generateLegalActions(request), request };
  };
  const input = forced(), skipped = doomedReplacement(input);
  assert.deepEqual(labels(input, skipped).map(l => l.split(',')[0]), ['Switch to Latios', 'Switch to Talonflame']);
  assert.match((skipped.values().next().value as { reason: string }).reason, /Ditto moves first and knocks it out/);
  b.foe().boosts = {};
  assert.equal(doomedReplacement(forced()).size, 0, 'an unboosted opponent may well switch or do something else, so nothing is skipped');
});

test('heals against the same Pokémon count across switches, and Taunt stands in for a switch that would not survive', () => {
  const roster = [ours('Electrode', 88, ['Taunt', 'Volt Switch', 'Thunderbolt', 'Tera Blast'], 'Aftermath', 'Life Orb', 'Ice'),
    ours('Hitmontop', 88, ['Close Combat', 'Triple Axel', 'Bulk Up', 'Rapid Spin'], 'Intimidate', 'Leftovers', 'Fighting')];
  const b = battle(roster, 'Chimecho', 97);
  const recover = (turn: number) => { b.feed('|move|p2a: Foe|Recover|p2a: Foe'); b.feed('|-heal|p2a: Foe|90/100'); b.feed(`|turn|${turn}`); };
  recover(2); recover(3);
  const top = b.state.sides.p1.team[1]!, electrode = b.state.sides.p1.team[0]!;
  b.feed(`|switch|p1a: Hitmontop|${top.details}|${top.exactHP!.max}/${top.exactHP!.max}`); b.feed('|turn|4');
  b.feed(`|switch|p1a: Electrode|${electrode.details}|${electrode.exactHP!.max}/${electrode.exactHP!.max}`); b.feed('|turn|5');
  assert.equal(b.state.matchup!.heals?.p2 ?? 0, 0, 'the pairing itself starts afresh');
  const input = decide(b), skipped = outhealed(input);
  assert.deepEqual(labels(input, skipped), ['Tera Blast', 'Thunderbolt'],
    'Chimecho healed twice against this Electrode before it left; Taunt breaks the stall and Volt Switch leaves');
  assert.match((skipped.values().next().value as { reason: string }).reason, /Chimecho has healed 2 times against Electrode/);
  // Hitmontop at 1 HP cannot come in, but Taunt still ends the stall, so the attacks stay skipped.
  top.hpPercent = 1; top.exactHP!.current = 1;
  const cornered = decide(b);
  assert.ok(outhealed(cornered).has(cornered.legalActions.find(a => a.label === 'Thunderbolt')!.id));
});

import { futileSubstitute, statusIntoKnockout, repeatedSelfEffect } from '../src/strategy/dominance.js';

test('a second Substitute into the hit that broke the first is skipped, but not the first', () => {
  const roster = [ours('Darkrai', 77, ['Substitute', 'Dark Pulse', 'Nasty Plot', 'Sludge Bomb'], 'Bad Dreams', 'Leftovers', 'Poison'),
    ours('Altaria', 88, ['Roost', 'Brave Bird', 'Dragon Dance', 'Earthquake'], 'Natural Cure', 'Leftovers', 'Ground')];
  const b = battle(roster, 'Rhyperior');
  b.feed('|turn|2');
  assert.equal(futileSubstitute(decide(b)).size, 0, 'a first Substitute can scout or block a status move');
  const max = roster[0]!.maxHP, left = max - Math.floor(max / 4);
  b.feed('|move|p1a: Darkrai|Substitute|p1a: Darkrai'); b.feed('|-start|p1a: Darkrai|Substitute'); b.feed(`|-damage|p1a: Darkrai|${left}/${max}`);
  b.feed('|move|p2a: Foe|Earthquake|p1a: Darkrai'); b.feed('|-end|p1a: Darkrai|Substitute'); b.feed('|turn|3');
  const input = decide(b, left), skipped = futileSubstitute(input);
  assert.deepEqual(labels(input, skipped), ['Substitute']);
  assert.match((skipped.values().next().value as { reason: string }).reason, /Rhyperior broke Darkrai's last Substitute, and its best sampled hit, \d+ HP, breaks a \d+-HP shell again/);
});

test('a status move is skipped when a revealed attack that moves first knocks us out, and a switch survives', () => {
  const roster = [ours('Dewgong', 94, ['Encore', 'Knock Off', 'Triple Axel', 'Flip Turn'], 'Thick Fat', 'Leftovers', 'Water'),
    ours('Ferrothorn', 86, ['Leech Seed', 'Power Whip', 'Gyro Ball', 'Spikes'], 'Iron Barbs', 'Leftovers', 'Fighting')];
  const low = Math.round(roster[0]!.maxHP * 0.22);
  const unrevealed = battle(roster, 'Swanna', 88);
  unrevealed.feed(`|-damage|p1a: Dewgong|${low}/${roster[0]!.maxHP}`); unrevealed.feed('|turn|2');
  assert.equal(statusIntoKnockout(decide(unrevealed, low)).size, 0, 'a sampled knockout alone is too often not used');
  const b = battle(roster, 'Swanna', 88);
  b.feed('|move|p2a: Foe|Brave Bird|p1a: Dewgong'); b.feed(`|-damage|p1a: Dewgong|${low}/${roster[0]!.maxHP}`); b.feed('|turn|2');
  const input = decide(b, low), skipped = statusIntoKnockout(input);
  assert.deepEqual(labels(input, skipped), ['Encore'], 'attacks are a sacrifice left to judgement');
  assert.match((skipped.values().next().value as { reason: string }).reason, /Swanna moves first and its revealed Brave Bird knocks Dewgong out at every sampled roll, so Encore never happens/);

  // With no switch that survives Swanna, staying in is the only line, so nothing is skipped.
  const cornered = battle([roster[0]!, ours('Rhyperior', 82, ['Earthquake', 'Stone Edge', 'Megahorn', 'Rock Polish'], 'Solid Rock', 'Weakness Policy', 'Rock')], 'Swanna', 88);
  cornered.feed('|move|p2a: Foe|Brave Bird|p1a: Dewgong'); cornered.feed(`|-damage|p1a: Dewgong|${low}/${roster[0]!.maxHP}`); cornered.feed('|turn|2');
  assert.equal(statusIntoKnockout(decide(cornered, low)).size, 0);
});

test('Falinks cannot spend another turn on No Retreat after it is active', () => {
  const roster = [ours('Falinks', 84, ['No Retreat', 'Close Combat', 'Throat Chop', 'Iron Head'], 'Defiant', 'Leftovers', 'Steel')];
  const b = battle(roster, 'Gurdurr', 86);
  assert.equal(repeatedSelfEffect(decide(b)).size, 0, 'the first use must remain available');
  b.feed('|move|p1a: Falinks|No Retreat|p1a: Falinks');
  b.feed('|-start|p1a: Falinks|move: No Retreat');
  b.feed('|turn|2');
  const input = decide(b), skipped = repeatedSelfEffect(input);
  assert.deepEqual(labels(input, skipped), ['No Retreat']);
  assert.match((skipped.values().next().value as { reason: string }).reason, /already under No Retreat/);
  const teraRequest = parseChoiceRequest(JSON.stringify({ ...b.payload(10, b.me().exactHP!.max),
    active: [{ ...b.payload(10, b.me().exactHP!.max).active[0]!, canTerastallize: 'Steel' }] }))!;
  const teraInput = { state: b.state, request: teraRequest, legalActions: generateLegalActions(teraRequest) };
  assert.deepEqual([...repeatedSelfEffect(teraInput).keys()], ['move-1'], 'Tera can still change the defensive matchup');
});

import { moveEffect } from '../src/pokemon/mechanics.js';
import { defensiveTera } from '../src/strategy/projection.js';

test('Diamond Storm raises Defense only half the time, and Tera Fairy buys Diancie a third Jet Punch', () => {
  const effect = moveEffect('Diamond Storm', 216)!;
  assert.equal(effect.userBoosts, undefined, 'not a certain boost');
  assert.deepEqual(effect.userBoostsOnlySometimes, { boosts: { def: 2 }, chancePercent: 50 });
  assert.equal(effect.secondaryEffects, undefined, 'its empty secondary exists only for Sheer Force');
  const b = battle([ours('Diancie', 82, ['Diamond Storm', 'Earth Power', 'Calm Mind', 'Draining Kiss'], 'Clear Body', 'Leftovers', 'Fairy')], 'Palafin-Hero', 77);
  b.feed('|move|p2a: Foe|Jet Punch|p1a: Diancie'); b.feed('|turn|2');
  // Every Palafin-Hero set is still possible here, so the numbers run higher than the game's narrowed ones (two hits
  // becoming three); what matters is that the count is given at all.
  const tera = defensiveTera(b.state, b.me(), 'p1', 'Fairy')!;
  assert.equal(tera.hitsItTakesToKnockUsOutBecomes, tera.wasHitsBefore! + 1, 'a neutral Jet Punch takes one hit more than a super-effective one');
});

test('a sleeping switch-in says it cannot wake on its first turn back', () => {
  const roster = [ours('Zebstrika', 87, ['Supercell Slam', 'High Horsepower', 'Volt Switch', 'Overheat'], 'Sap Sipper', 'Life Orb', 'Ground'),
    ours('Cacturne', 92, ['Sucker Punch', 'Swords Dance', 'Seed Bomb', 'Knock Off'], 'Water Absorb', 'Life Orb', 'Poison')];
  const b = battle(roster, 'Magearna-Original', 77);
  b.state.sides.p1.team[1]!.status = 'slp';
  const input = decide(b);
  const features = extractFeatures(input) as unknown as { actions: { kind: string; switchIn?: { asleep?: Record<string, unknown> } }[] };
  const asleep = features.actions.find(a => a.kind === 'switch')!.switchIn!.asleep!;
  assert.deepEqual(asleep, { turnsAlreadyLostToSleep: 0, chanceItWakesOnItsFirstTurnBackPercent: 0 });
});

import { phazeOutlook } from '../src/strategy/phaze.js';

test('a phaze says which boosts it wipes, who comes in and what hazards they land on, and when it cannot drag', () => {
  // 2687159529: a Curse Snorlax at +1/+1 Body Slammed Piloswine out over two Earthquakes while Roar went unused.
  const pilo = [ours('Piloswine', 85, ['Roar', 'Earthquake', 'Icicle Crash', 'Stealth Rock'], 'Thick Fat', 'Eviolite', 'Ice')];
  const b = battle(pilo, 'Snorlax', 84);
  assert.equal(phazeOutlook(b.state, 'p1', 'Roar'), null, 'nothing to erase and no hazards: only a scout, so nothing is said');
  b.feed('|move|p2a: Foe|Curse|p2a: Foe'); b.feed('|-unboost|p2a: Foe|spe|1'); b.feed('|-boost|p2a: Foe|atk|1'); b.feed('|-boost|p2a: Foe|def|1');
  b.feed('|-sidestart|p2: Foe|move: Stealth Rock'); b.feed('|turn|2');
  const roar = phazeOutlook(b.state, 'p1', 'Roar') as Record<string, unknown>;
  assert.deepEqual(roar.erasesTheirStatChanges, { spe: -1, atk: 1, def: 1 });
  assert.deepEqual(roar.theReplacementEntersInto, { 'Stealth Rock': 1 });
  assert.deepEqual(roar.dragsInAtRandom, { revealed: [], unrevealed: 5 });
  b.feed('|-start|p2a: Foe|Substitute'); b.feed('|turn|3');
  assert.equal((phazeOutlook(b.state, 'p1', 'Roar') as Record<string, unknown>).endsTheirSubstitute, true, 'Roar passes through a Substitute');
  assert.deepEqual(phazeOutlook(b.state, 'p1', 'Dragon Tail'), { noDrag: ['its Substitute takes the hit, so it is not forced out'], onlyItsDamageLands: true });
  b.state.sides.p2.teamSize = 1;
  assert.ok(effectViability(b.state, 'Roar', b.me(), 'p1', b.foe())!.certain.includes('they have no other Pokémon to bring in, so Roar fails'));
  assert.equal(effectViability(b.state, 'Dragon Tail', b.me(), 'p1', b.foe())?.certain.some(r => /bring in/.test(r)) ?? false, false, 'Dragon Tail still hits');
});

import { encoreThreat } from '../src/strategy/encoreThreat.js';

test('a Prankster Encore that would lock us into a useless last move is flagged before it lands', () => {
  // 2687149125: Sableye's Encore went first and held Cobalion to Aura Sphere, which Sableye is immune to.
  const cob = [ours('Cobalion', 80, ['Aura Sphere', 'Flash Cannon', 'Calm Mind', 'Vacuum Wave'], 'Justified', 'Leftovers', 'Water')];
  const b = battle(cob, 'Sableye', 87);
  assert.equal(encoreThreat(b.state, b.me(), 'p1'), null, 'nothing used yet, so Encore has nothing to hold');
  b.feed('|move|p1a: Cobalion|Aura Sphere|p2a: Foe'); b.feed('|-immune|p2a: Foe'); b.feed('|turn|2');
  const threat = encoreThreat(b.state, b.me(), 'p1') as Record<string, unknown> & { movesFirstBecause: string };
  assert.equal(threat.locksUsInto, 'Aura Sphere');
  assert.equal(threat.itIsImmune, true);
  assert.match(threat.movesFirstBecause, /Prankster/);
  b.feed('|move|p1a: Cobalion|Flash Cannon|p2a: Foe'); b.feed('|-damage|p2a: Foe|50/100'); b.feed('|turn|3');
  assert.equal(encoreThreat(b.state, b.me(), 'p1'), null, 'a lock into an attack that hurts it is not worth warning about');
});

import { teraImmunityShare } from '../src/strategy/teraImmunity.js';

test('a crash move names the unspent Tera types that would make its target immune', () => {
  // 2687152284: Talonflame went Tera Ground and Electivire's Supercell Slam crashed it out.
  const vire = [ours('Electivire', 84, ['Supercell Slam', 'Ice Punch', 'Earthquake', 'Bulk Up'], 'Motor Drive', 'Life Orb', 'Electric')];
  const b = battle(vire, 'Talonflame', 86);
  const risk = teraImmunityShare(b.state, 'p1', 'Supercell Slam')!;
  assert.ok(risk.teraTypes.includes('Ground'));
  assert.ok(risk.shareOfTheirSetsPercent > 0 && risk.shareOfTheirSetsPercent < 100);
  assert.equal(teraImmunityShare(b.state, 'p1', 'Ice Punch'), null, 'no Tera type is immune to Ice');
  b.feed('|-terastallize|p2a: Foe|Dragon'); b.feed('|turn|2');
  assert.equal(teraImmunityShare(b.state, 'p1', 'Supercell Slam'), null, 'their Tera is spent');
});

test('an attack whose Speed raise Sheer Force removes is not a Speed race', () => {
  // 2687202806: Feraligatr's Trailblaze raised nothing, yet it was counted as +1 against Haxorus's Swords Dance.
  const hax = () => battle([ours('Haxorus', 80, ['Swords Dance', 'Scale Shot', 'Earthquake', 'Close Combat'], 'Mold Breaker', 'Loaded Dice', 'Fighting')], 'Feraligatr', 79);
  const trail = hax();
  trail.feed('|move|p2a: Foe|Trailblaze|p1a: Haxorus'); trail.feed('|turn|2');
  assert.equal(setupRaceLost(decide(trail)).size, 0, 'every Feraligatr set with Trailblaze has Sheer Force');
  const dance = hax();
  dance.feed('|move|p2a: Foe|Dragon Dance|p2a: Foe'); dance.feed('|turn|2');
  const input = decide(dance);
  assert.deepEqual(labels(input, setupRaceLost(input)), ['Swords Dance'], 'Dragon Dance is no secondary: that race is real');
});

test('a Substitute loop against a seeded opponent that is losing the race is not skipped', () => {
  // 2687219758: Serperior's Leftovers and Leech Seed refunded all but 3.8% of each shell while Vespiquen lost 12.5% a turn.
  const roster = [ours('Serperior', 84, ['Substitute', 'Leech Seed', 'Leaf Storm', 'Dragon Pulse'], 'Contrary', 'Leftovers', 'Grass'),
    ours('Hydreigon', 79, ['Draco Meteor', 'Dark Pulse', 'Flash Cannon', 'U-turn'], 'Levitate', 'Choice Specs', 'Dark')];
  const max = roster[0]!.maxHP;
  const loop = (ours: number, theirs: number) => {
    const b = battle(roster, 'Vespiquen', 90);
    b.feed('|move|p1a: Serperior|Leech Seed|p2a: Foe'); b.feed('|-start|p2a: Foe|move: Leech Seed'); b.feed('|turn|2');
    b.feed('|move|p1a: Serperior|Substitute|p1a: Serperior'); b.feed('|-start|p1a: Serperior|Substitute');
    b.feed('|move|p2a: Foe|Air Slash|p1a: Serperior'); b.feed('|-end|p1a: Serperior|Substitute');
    b.feed(`|-damage|p2a: Foe|${theirs}/100|[from] Leech Seed|[of] p1a: Serperior`);
    const hp = Math.round(max * ours / 100);
    b.feed(`|-heal|p1a: Serperior|${hp}/${max}|[silent]`); b.feed('|turn|3');
    return futileSubstitute(decide(b, hp)).size;
  };
  assert.equal(loop(49, 27), 0, 'seven more shells against three turns of Vespiquen: the loop wins');
  assert.equal(loop(30, 76), 1, 'one more shell against six turns of Vespiquen: the loop runs out first');
});

import { redundantTera as teraGuard } from '../src/strategy/dominance.js';

test('Tera damage is not "surplus" when the hit we land first is the only one we get, or against their last Pokémon', () => {
  // 2687217753: Flamigo at 48% was knocked out by Icicle Crash with or without Tera; Tera Fighting Close Combat left a last
  // Glastrier at 8-22% instead of 31-42%, and the guard skipped it for High Horsepower and a second hit that never came.
  const roster = [ours('Flamigo', 82, ['Close Combat', 'U-turn', 'Brave Bird', 'Throat Chop'], 'Scrappy', 'Choice Scarf', 'Fighting'),
    ours('Garganacl', 80, ['Salt Cure', 'Recover', 'Earthquake', 'Protect'], 'Purifying Salt', 'Leftovers', 'Water'),
    ours('Mesprit', 85, ['Psychic', 'Thunderbolt', 'U-turn', 'Stealth Rock'], 'Levitate', 'Choice Scarf', 'Psychic'),
    ours('Magnezone', 84, ['Thunderbolt', 'Flash Cannon', 'Body Press', 'Volt Switch'], 'Magnet Pull', 'Choice Specs', 'Water')];
  const turn = (hpPercent: number, theirLeft: number, trickRoom = false) => {
    const b = battle(roster, 'Glastrier', 86);
    b.state.sides.p2.teamSize = theirLeft; b.state.field.trickRoom = trickRoom;
    const hp = Math.round(roster[0]!.maxHP * hpPercent / 100);
    b.feed(`|-damage|p1a: Flamigo|${hp}/${roster[0]!.maxHP}`); b.feed('|turn|2');
    const payload = b.payload(9, hp, 0) as ReturnType<typeof b.payload> & { active: { canTerastallize?: string }[] };
    payload.active[0]!.canTerastallize = 'Fighting';
    const request = parseChoiceRequest(JSON.stringify(payload))!;
    const input = { state: b.state, legalActions: generateLegalActions(request), request };
    return labels(input, teraGuard(input));
  };
  assert.ok(!turn(48, 1).includes('Close Combat + Tera Fighting'), 'doomed either way, against their last Pokémon');
  assert.ok(turn(48, 6, true).includes('Close Combat + Tera Fighting'), 'under Trick Room Glastrier hits first, so the Tera buys nothing');
});

import { levelOf } from '../src/strategy/calcCore.js';

test('a temporary form change keeps the level and gender', () => {
  // 2687193686: Cramorant-Gorging lost its L86 and was read as level 100, a third off in both directions.
  const b = battle([ours('Dialga', 72, ['Draco Meteor', 'Heavy Slam', 'Fire Blast', 'Thunder Wave'], 'Pressure', 'Choice Specs', 'Dragon')], 'Cramorant', 86);
  b.feed('|-formechange|p2a: Foe|Cramorant-Gorging|'); b.feed('|turn|2');
  assert.equal(b.foe().species, 'Cramorant-Gorging');
  assert.equal(levelOf(b.foe()), 86);
  b.feed('|detailschange|p2a: Foe|Cramorant, L86, M'); b.feed('|turn|3');
  assert.equal(levelOf(b.foe()), 86, 'a detailschange carries its own level');
});

import { pivotIntoKnockout } from '../src/strategy/dominance.js';

test('a pivot into teammates that are knocked out on arrival is skipped when one of them would act after a free switch', () => {
  // 2687217753: three U-turns fed Garganacl, Mesprit and Magnezone to Glastrier's Icicle Crash before any of them acted.
  const roster = [ours('Flamigo', 82, ['Close Combat', 'U-turn', 'Brave Bird', 'Throat Chop'], 'Scrappy', 'Life Orb', 'Fighting'),
    ours('Garganacl', 80, ['Salt Cure', 'Recover', 'Earthquake', 'Protect'], 'Purifying Salt', 'Leftovers', 'Water'),
    ours('Mesprit', 85, ['Psychic', 'Thunderbolt', 'U-turn', 'Stealth Rock'], 'Levitate', 'Choice Scarf', 'Psychic'),
    ours('Magnezone', 84, ['Thunderbolt', 'Flash Cannon', 'Body Press', 'Volt Switch'], 'Magnet Pull', 'Choice Specs', 'Water')];
  const run = (benchPercent: number[]) => {
    const b = battle(roster, 'Glastrier', 86);
    const hp = Math.round(roster[0]!.maxHP * 0.48);
    b.feed(`|-damage|p1a: Flamigo|${hp}/${roster[0]!.maxHP}`); b.feed('|turn|2');
    b.state.sides.p1.team.forEach(p => { const i = roster.findIndex(r => p.species.startsWith(r.details.split(',')[0]!)); if (i > 0) {
      p.hpPercent = benchPercent[i - 1]!; if (p.exactHP) p.exactHP.current = Math.round(p.exactHP.max * benchPercent[i - 1]! / 100); } });
    const input = decide(b, hp);
    return labels(input, pivotIntoKnockout(input));
  };
  assert.deepEqual(run([24, 29, 7]), ['U-turn'], 'all three die to Icicle Crash on arrival; Mesprit would outspeed Glastrier after a free switch');
  assert.deepEqual(run([100, 100, 100]), [], 'healthy teammates survive the hit, so the pivot is a judgement call');
});

test('a certain knockout is not passed up for a heal or a boost when the opponent moves first but cannot stop it', () => {
  // 2686983295: Gogoat drank Milk over a Horn Leech that knocked out a 19% Darkrai at every roll. Darkrai moves first,
  // but its Hypnosis would stop Milk Drink as surely as Horn Leech, and at 19% it has no HP for a Substitute.
  const roster = [ours('Gogoat', 88, ['Earthquake', 'Milk Drink', 'Horn Leech', 'Bulk Up'], 'Sap Sipper', 'Leftovers', 'Water')];
  const run = (foePercent: number) => {
    const b = battle(roster, 'Darkrai', 77);
    const hp = Math.round(roster[0]!.maxHP * 0.54);
    b.feed('|move|p2a: Foe|Dark Pulse|p1a: Gogoat'); b.feed(`|-damage|p1a: Gogoat|${hp}/${roster[0]!.maxHP}`);
    b.feed(`|-damage|p2a: Foe|${foePercent}/100`); b.feed('|turn|2');
    const input = decide(b, hp);
    return labels(input, freeKnockoutPassedUp(input));
  };
  assert.deepEqual(run(19), ['Bulk Up', 'Milk Drink']);
  assert.deepEqual(run(30), [], 'at 30% Darkrai can put up a Substitute before the hit, and Milk Drink would still have worked');
});

test('a heal the opponent can use first keeps a status move open', () => {
  // 2687212923: Groudon's Heat Crash knocked out a 12% Jumpluff at every roll, but Jumpluff moves first and Strength Sap
  // heals it out of range while Thunder Wave or Spikes would still have worked.
  const roster = [ours('Groudon', 72, ['Precipice Blades', 'Spikes', 'Heat Crash', 'Thunder Wave'], 'Drought', 'Leftovers', 'Fire')];
  const b = battle(roster, 'Jumpluff', 87);
  for (const m of ['Acrobatics', 'Substitute', 'Strength Sap']) b.feed(`|move|p2a: Foe|${m}|p1a: Groudon`);
  b.feed('|-damage|p2a: Foe|12/100'); b.feed('|turn|2');
  const input = decide(b);
  assert.deepEqual(labels(input, freeKnockoutPassedUp(input)), []);
});

test('a burn used first stops a physical knockout only when the halved hit falls short', () => {
  const roster = [ours('Garchomp', 74, ['Earthquake', 'Swords Dance', 'Stone Edge', 'Scale Shot'], 'Rough Skin', 'Loaded Dice', 'Steel')];
  const run = (foePercent: number) => {
    const b = battle(roster, 'Pyroar', 88);
    for (const m of ['Will-O-Wisp', 'Hyper Voice', 'Fire Blast', 'Work Up']) b.feed(`|move|p2a: Foe|${m}|p1a: Garchomp`);
    b.feed(`|-damage|p2a: Foe|${foePercent}/100`); b.feed('|turn|2');
    const input = decide(b);
    return labels(input, freeKnockoutPassedUp(input));
  };
  assert.deepEqual(run(1), ['Swords Dance'], 'burned, Earthquake still deals far more than 1%');
  assert.deepEqual(run(60), [], 'burned, Earthquake may leave a 60% Pyroar standing while Swords Dance still works');
});
