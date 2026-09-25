import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, ours } from './helpers.js';
import { switchRelief } from '../src/strategy/switchRelief.js';
import { cyclicSwitch } from '../src/strategy/loopGuard.js';
import { extractFeatures } from '../src/strategy/features.js';
import { residuals } from '../src/strategy/residual.js';
import { generateLegalActions, type ChoiceRequest } from '../src/battle/LegalActionGenerator.js';
const fixture = (ability = 'Defiant') => battle([
  ours('Bisharp', 79, ['Throat Chop', 'Sucker Punch'], ability, 'Eviolite', 'Dark'),
  ours('Empoleon', 84, ['Surf'], 'Competitive', 'Leftovers', 'Water'),
], 'Venusaur');
const relief = (b: ReturnType<typeof fixture>) => switchRelief(b.state, b.me(), 'p1')!;

test('Leech Seed + Salt Cure are additive, ability-aware relief, not healing', () => {
  const b = fixture();
  b.feed('|-start|p1a: Bisharp|move: Leech Seed\n|-start|p1a: Bisharp|Salt Cure');
  assert.equal(relief(b).avoidsResidualPercentOfOutgoingMaxHPPerTurn, 37.5);
  b.me().terastallized = true; b.me().teraType = 'Dark';
  assert.equal(relief(b).avoidsResidualPercentOfOutgoingMaxHPPerTurn, 25);
  b.me().ability = 'Magic Guard';
  assert.equal(relief(b).avoidsResidualPercentOfOutgoingMaxHPPerTurn, undefined);
  b.me().abilitySuppressed = true;
  assert.equal(relief(b).avoidsResidualPercentOfOutgoingMaxHPPerTurn, 25);
});
test('confusion, attraction, Yawn, restrictions and recurring debuffs have explicit removal value', () => {
  const b = fixture();
  const effects = ['confusion','Attract','Yawn','Encore','Disable','Taunt','Torment','Heal Block','Embargo','Throat Chop','Syrup Bomb','Octolock'];
  for (const effect of effects) b.feed(`|-start|p1a: Bisharp|${effect}`);
  assert.deepEqual(relief(b).clears?.map(x => x.effect), effects);
  assert.equal(relief(b).avoidsResidualPercentOfOutgoingMaxHPPerTurn, undefined);
});
test('Perish countdown is replaced and removed on a real switch', () => {
  const b = fixture();
  b.feed('|-start|p1a: Bisharp|perish3\n|-start|p1a: Bisharp|perish2\n|-start|p1a: Bisharp|perish1');
  assert.equal(relief(b).perishCount, 1);
  assert.deepEqual(Object.keys(b.me().volatiles), ['perish1']);
  const old = b.me();
  b.feed('|switch|p1a: Empoleon|Empoleon, L84|100/100');
  assert.deepEqual(old.volatiles, {});
});
test('binding -activate and -end are tracked without making a trapped switch legal', () => {
  const b = fixture();
  b.feed('|-activate|p1a: Bisharp|move: Fire Spin|[of] p2a: Foe');
  assert.ok(relief(b).clears?.some(x => x.effect === 'partiallytrapped'));
  const request = b.payload(8, b.me().exactHP!.current) as unknown as ChoiceRequest;
  request.active![0]!.trapped = true;
  const legalActions = generateLegalActions(request);
  const f = extractFeatures({ state: b.state, request, legalActions }, 'minimal');
  assert.equal(f.switching.legalSwitchCount, 0);
  assert.equal(f.switching.trapped, true);
  b.feed('|-end|p1a: Bisharp|Fire Spin|[partiallytrapped]');
  assert.equal(b.me().volatiles.partiallytrapped, undefined);
});
test('ordinary switches preserve major status; Toxic resets, Natural Cure cures, Regenerator heals', () => {
  const b = fixture();
  for (const status of ['brn','psn','tox','slp','par','frz']) {
    b.me().status = status;
    assert.equal(relief(b).statusPersists, status);
    assert.equal(relief(b).curesStatus, undefined);
  }
  b.me().status = 'tox'; b.me().toxicTurns = 5;
  assert.equal(relief(b).toxicCounterRestartsOnReturn, true);
  assert.equal(relief(b).poisonIsNotCured, true);
  b.me().ability = 'Natural Cure';
  assert.equal(relief(b).curesStatus, 'tox');
  assert.equal(relief(b).statusPersists, undefined);
  b.me().ability = 'Regenerator'; b.me().hpPercent = 90;
  assert.equal(relief(b).regeneratorHealsPercentOfMaxHP, 10);
  b.me().abilitySuppressed = true;
  assert.equal(relief(b).regeneratorHealsPercentOfMaxHP, undefined);
});
test('clearing negative stages is balanced by lost boosts, Substitute and Aqua Ring', () => {
  const b = fixture(); b.me().boosts = { atk: 2, spe: -2, accuracy: -1 };
  b.feed('|-start|p1a: Bisharp|Substitute\n|-start|p1a: Bisharp|Aqua Ring');
  const r = relief(b);
  assert.deepEqual(r.removesStatDrops, { spe: -2, accuracy: -1 });
  assert.deepEqual(r.losesStatBoosts, { atk: 2 });
  assert.ok(r.otherChanges?.some(x => x.effect === 'Substitute'));
  assert.ok(r.otherChanges?.some(x => x.effect === 'Aqua Ring'));
  assert.equal(residuals(b.state, b.me(), 'p1')?.perTurnPercentOfMaxHP, 6.3);
});
test('Nightmare needs sleep, Curse drains, Heal Block prevents positive residuals', () => {
  const b = fixture();
  b.feed('|-start|p1a: Bisharp|Nightmare\n|-start|p1a: Bisharp|Curse');
  assert.equal(relief(b).avoidsResidualPercentOfOutgoingMaxHPPerTurn, 25);
  b.me().status = 'slp';
  assert.equal(relief(b).avoidsResidualPercentOfOutgoingMaxHPPerTurn, 50);
  b.feed('|-start|p1a: Bisharp|Aqua Ring\n|-start|p1a: Bisharp|Heal Block');
  assert.equal(residuals(b.state, b.me(), 'p1')?.perTurnPercentOfMaxHP, -50);
});
test('cycle guard permits an escape with relief but still blocks an empty switch cycle', () => {
  const b = fixture(); b.state.turn = 5; b.me().activeSinceTurn = 4; b.foe().activeSinceTurn = 1;
  const target = b.state.sides.p1.team[1]!;
  assert.ok(cyclicSwitch(b.state, 'p1', target));
  b.feed('|-start|p1a: Bisharp|Leech Seed');
  assert.equal(cyclicSwitch(b.state, 'p1', target), null);
});
test('repeated draining attack warning and relief survive every payload tier; no reward after fainting', () => {
  const b = fixture(); b.feed('|-start|p1a: Bisharp|Leech Seed');
  b.me().lastMoveUsed = 'Throat Chop'; b.me().sameMoveStreak = 8;
  const request = b.payload(8, b.me().exactHP!.current) as unknown as ChoiceRequest;
  const input = { state: b.state, request, legalActions: generateLegalActions(request) };
  for (const detail of ['full','reduced','minimal'] as const) {
    assert.equal(extractFeatures(input, detail).switching.onSuccessfulSwitchOut?.repeatedMoveWhileDraining?.consecutiveUses, 8);
  }
  b.me().fainted = true; request.forceSwitch = [true];
  assert.equal(extractFeatures(input, 'minimal').switching.onSuccessfulSwitchOut, undefined);
});
test('unrecognised effects remain explicitly unpriced, not invented benefits', () => {
  const b = fixture(); b.feed('|-start|p1a: Bisharp|Future unknown mechanic');
  assert.deepEqual(relief(b).effectsNotPriced, ['Future unknown mechanic']);
  assert.equal(relief(b).hasRelief, false);
});
