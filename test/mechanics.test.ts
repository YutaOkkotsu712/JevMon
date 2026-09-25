import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BattleTracker } from '../src/battle/BattleTracker.js';
import { baseStab, fieldFactors, typeEffectiveness, hazardExposure, boostedStat, pokemonTypes } from '../src/pokemon/mechanics.js';
import { extractFeatures } from '../src/strategy/features.js';
const room = 'battle-gen9randombattle-1';
const mon = () => {
  const t = new BattleTracker(room);
  t.handle({ room, type: 'switch', data: 'p1a: Charizard|Charizard|100/100' });
  return t.state.sides.p1.team[0]!;
};
test('type chart handles dual weaknesses, resistances and immunities', () => {
  assert.equal(typeEffectiveness('Rock', ['Fire', 'Flying']), 4);
  assert.equal(typeEffectiveness('Electric', ['Ground']), 0);
  assert.equal(typeEffectiveness('Fire', ['Fire', 'Water']), 0.25);
  assert.equal(typeEffectiveness('Unknown', ['Fire']), null);
});
test('base STAB distinguishes ordinary Tera, original types and Stellar uncertainty', () => {
  const p = mon(); assert.equal(baseStab('Fire', p), 1.5);
  assert.equal(baseStab('Fire', p, 'Fire'), 2); assert.equal(baseStab('Water', p, 'Water'), 1.5);
  assert.equal(baseStab('Fire', p, 'Water'), 1.5); assert.equal(baseStab('Fire', p, 'Stellar'), null);
  p.terastallized = true; p.teraType = 'Water'; assert.deepEqual(pokemonTypes(p), ['Water']);
});
test('hazard features are conditional and apply type-based Stealth Rock damage', () => {
  const t = new BattleTracker(room); t.handle({ room, type: 'switch', data: 'p1a: Charizard|Charizard|100/100' });
  t.state.sides.p1.hazards = { 'Stealth Rock': 1, Spikes: 2 };
  assert.equal(hazardExposure(t.state.sides.p1.team[0]!, t.state.sides.p1).stealthRockPercentBeforePrevention, 50);
  assert.equal(boostedStat(100, -1), 66);
});
test('features exclude usernames and keep unknown speed and damage explicit', () => {
  const t = new BattleTracker(room); t.state.sides.p1.name = 'Private User'; t.state.mySide = 'p1';
  const features = extractFeatures({ state: t.state, legalActions: [] });
  assert.ok(!JSON.stringify(features).includes('Private User'));
  assert.deepEqual(features.speedRelation, { relation: 'unknown' });
  assert.equal(features.incomingThreatIfWeStayIn, null);
});


test('common weather and terrain factors are explicitly conditional', () => {
  assert.equal(fieldFactors('Water', 'surf', 'RainDance', null).weatherIfUnsuppressed, 1.5);
  assert.equal(fieldFactors('Fire', 'flamethrower', 'RainDance', null).weatherIfUnsuppressed, 0.5);
  assert.equal(fieldFactors('Electric', 'thunderbolt', null, 'Electric Terrain').terrainIfAttackerGrounded, 1.3);
  assert.equal(fieldFactors('Ground', 'earthquake', null, 'Grassy Terrain').terrainIfDefenderGrounded, 0.5);
  assert.equal(typeEffectiveness('Stellar', ['Water']), null);
});
