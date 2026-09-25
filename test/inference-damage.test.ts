import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pokemon } from '@smogon/calc';
import { BattleTracker } from '../src/battle/BattleTracker.js';
import { inferOpponent } from '../src/strategy/inference.js';
import { damageRange } from '../src/strategy/damage.js';
import { battle, ours } from './helpers.js';
const room = 'battle-gen9randombattle-test';
function fixture(foe = 'Venusaur') {
  const t = new BattleTracker(room);
  t.handle({ room, type: 'switch', data: 'p1a: Charizard|Charizard, L85|100/100' });
  t.handle({ room, type: 'switch', data: `p2a: Foe|${foe}, L84|100/100` });
  t.state.mySide = 'p1';
  const p = t.state.sides.p1.team[0]!;
  const calc = new Pokemon(9, 'Charizard', { level: 85, nature: 'Serious', evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 } });
  p.stats = { ...calc.rawStats }; p.exactHP = { current: calc.maxHP(), max: calc.maxHP() }; p.hpPrecision = 'exact';
  p.ability = 'Blaze'; p.item = '';
  return t;
}
test('revealed moves narrow official role pools; contradictions remain explicit', () => {
  const t = fixture('Charizard'), p = t.state.sides.p2.team[0]!;
  const before = inferOpponent(p); p.revealedMoves = ['Dragon Dance'];
  const after = inferOpponent(p);
  assert.ok(after.summary.roles.length < before.summary.roles.length);
  assert.ok(after.candidates.length > 0);
  assert.ok(after.candidates.every(c => c.moves.includes('dragondance')));
  p.revealedMoves.push('Spore');
  assert.equal(inferOpponent(p).summary.status, 'no-compatible-role');
  assert.equal(inferOpponent(p).candidates.length, 0);
  assert.equal(damageRange(t.state, 'Flamethrower'), null);
});
test('damage responds to screens, rain and attacking Tera', () => {
  const t = fixture();
  const base = damageRange(t.state, 'Flamethrower')!;
  assert.ok(base.hp[0]! > 0); assert.ok(base.hp[1]! >= base.hp[0]!);
  t.state.sides.p2.conditions['Light Screen'] = { sinceTurn: 1 };
  assert.ok(damageRange(t.state, 'Flamethrower')!.hp[1]! < base.hp[1]!);
  t.state.sides.p2.conditions = {};
  t.state.field.weather = 'RainDance';
  assert.ok(damageRange(t.state, 'Flamethrower')!.hp[1]! < base.hp[1]!);
  t.state.field.weather = null;
  assert.ok(damageRange(t.state, 'Flamethrower', 'Fire')!.hp[1]! > base.hp[1]!);
});
test('known immunity overrides sampled original ability; consumed item remains empty', () => {
  const t = fixture();
  t.state.sides.p2.team[0]!.ability = 'Flash Fire';
  assert.deepEqual(damageRange(t.state, 'Flamethrower')!.hp, [0, 0]);
  t.state.sides.p2.team[0]!.abilitySuppressed = true;
  assert.ok(damageRange(t.state, 'Flamethrower')!.hp[0]! > 0);
});
test('missing private HP and Transform decline; multihit is bounded and Substitute redirects damage', () => {
  const t = fixture();
  assert.ok(damageRange(t.state, 'Bullet Seed')?.mechanicsNotes?.length);
  const foe = t.state.sides.p2.team[0]!;
  foe.volatiles.Substitute = { sinceTurn: 1, data: null };
  assert.deepEqual(damageRange(t.state, 'Flamethrower')!.hp, [0, 0]);
  assert.ok(damageRange(t.state, 'Flamethrower')!.substituteDamage);
  foe.volatiles = {}; foe.transformedInto = 'Ditto';
  // A transformed Pokémon keeps its own sets (its HP, level and item); only the copied stats decide the damage, and
  // while those are unknown the estimate declines rather than guess. Imposter copying our Pokémon makes them known.
  assert.notEqual(inferOpponent(foe).summary.status, 'unsupported-transformation');
  assert.ok(inferOpponent(foe).candidates.length > 0);
  assert.equal(damageRange(t.state, 'Flamethrower'), null, 'copied stats unknown');
  foe.stats = { atk: 150, def: 150, spa: 150, spd: 150, spe: 150 };
  assert.ok(damageRange(t.state, 'Flamethrower'), 'copied stats known');
  foe.transformedInto = null; foe.stats = {};
  delete t.state.sides.p1.team[0]!.exactHP;
  assert.equal(damageRange(t.state, 'Flamethrower'), null);
});
test('public 100 percent HP includes damaged Multiscale scenarios', () => {
  const t = fixture('Dragonite'), foe = t.state.sides.p2.team[0]!;
  foe.ability = 'Multiscale'; foe.item = '';
  const rounded = damageRange(t.state, 'Dragon Pulse')!;
  assert.ok(rounded);
  foe.ability = 'No Ability';
  const unprotected = damageRange(t.state, 'Dragon Pulse')!;
  assert.equal(rounded.hp[1], unprotected.hp[1]);
  assert.ok(rounded.hp[0]! < unprotected.hp[0]!);
});

test('item and ability IDs from the private request reach the calculator as real modifiers', () => {
  // Showdown's private request supplies IDs ("lifeorb", "hugepower"). The calculator matches display names
  // and silently ignores anything else, which quietly understated every estimate involving our own side.
  const orb = damageRange(battle([ours('Gengar', 81, ['Shadow Ball'], 'cursedbody', 'lifeorb', 'Ghost')], 'Typhlosion').state, 'Shadow Ball')!;
  const bare = damageRange(battle([ours('Gengar', 81, ['Shadow Ball'], 'cursedbody', '', 'Ghost')], 'Typhlosion').state, 'Shadow Ball')!;
  assert.ok(orb.hp[1]! > bare.hp[1]!, `Life Orb must raise the estimate: ${orb.hp} vs ${bare.hp}`);
  assert.ok(Math.abs(orb.hp[1]! / bare.hp[1]! - 1.3) < 0.02, `and by roughly 1.3x, not ${orb.hp[1]! / bare.hp[1]!}`);
  const huge = damageRange(battle([ours('Azumarill', 82, ['Liquidation'], 'hugepower', '', 'Water')], 'Typhlosion').state, 'Liquidation')!;
  const thick = damageRange(battle([ours('Azumarill', 82, ['Liquidation'], 'thickfat', '', 'Water')], 'Typhlosion').state, 'Liquidation')!;
  // Doubling Attack does not double damage exactly: the formula rounds at several steps.
  assert.ok(Math.abs(huge.hp[1]! / thick.hp[1]! - 2) < 0.05, `Huge Power must double Attack, not ${huge.hp[1]! / thick.hp[1]!}`);
  // Display names keep working, so protocol-sourced values are unaffected.
  assert.deepEqual(damageRange(battle([ours('Gengar', 81, ['Shadow Ball'], 'Cursed Body', 'Life Orb', 'Ghost')], 'Typhlosion').state, 'Shadow Ball')!.hp, orb.hp);
});

test('an unrecognised item or ability declines the estimate instead of quietly dropping it', () => {
  for (const [ability, item] of [['cursedbody', 'notanitem'], ['notanability', 'lifeorb']]) {
    const b = battle([ours('Gengar', 81, ['Shadow Ball'], ability!, item!, 'Ghost')], 'Typhlosion');
    assert.equal(damageRange(b.state, 'Shadow Ball'), null, `${ability}/${item} must fail closed`);
  }
});

test('a zero from Mirror Coat or an equal-HP Endeavor is not reported as a type immunity', () => {
  const mirror = battle([ours('Mew', 80, ['Mirror Coat', 'Endeavor'], 'Synchronize', 'Leftovers', 'Psychic')], 'Espeon');
  // Mirror Coat is priced in conditionalDamage; claiming the target takes nothing contradicted it.
  assert.equal(damageRange(mirror.state, 'Mirror Coat')!.takesNothingFromIt, undefined);
  assert.match(String(damageRange(mirror.state, 'Endeavor')!.takesNothingFromIt!.cause), /only cuts the target down to our current HP/);
  const ghost = battle([ours('Mew', 80, ['Body Slam'], 'Synchronize', 'Leftovers', 'Psychic')], 'Gengar');
  assert.equal(damageRange(ghost.state, 'Body Slam')!.takesNothingFromIt!.cause, 'type immunity', 'a real immunity is still named');
});
