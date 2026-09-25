import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, ours } from './helpers.js';
import { damageRange } from '../src/strategy/damage.js';
import { residuals } from '../src/strategy/residual.js';
import { extractFeatures } from '../src/strategy/features.js';
import { futileProtect } from '../src/strategy/dominance.js';
import { generateLegalActions, type ChoiceRequest } from '../src/battle/LegalActionGenerator.js';
const conk = () => battle([ours('Conkeldurr', 80, ['Mach Punch', 'Close Combat'], 'Guts', 'Flame Orb', 'Normal')], 'Abomasnow', 84);
function input(b: ReturnType<typeof battle>) {
  const request = b.payload(10, b.me().exactHP!.current) as unknown as ChoiceRequest;
  return { state: b.state, request, legalActions: generateLegalActions(request) };
}
test('Showdown Snowscape becomes Snow, adds Ice Defence and supports legacy saved weather', () => {
  const b = conk();
  const dry = damageRange(b.state, 'Close Combat')!.hp;
  b.feed('|-weather|Snowscape|[from] ability: Snow Warning|[of] p2a: Foe');
  assert.equal(b.state.field.weather, 'Snow');
  const snow = damageRange(b.state, 'Close Combat')!.hp;
  assert.ok(snow[1] < dry[0]);
  assert.equal(damageRange(b.state, 'Close Combat')!.conditionalKO, 'none-sampled');
  b.state.field.weather = 'Snowscape';
  assert.deepEqual(damageRange(b.state, 'Close Combat')!.hp, snow);
  b.feed('|-weather|none');
  assert.deepEqual(damageRange(b.state, 'Close Combat')!.hp, dry);
});
test('Ice Body heals during Snowscape, which does not cause hail chip', () => {
  const b = battle([ours('Glaceon',94,['Protect','Freeze-Dry'],'Ice Body','Heavy-Duty Boots','Water')], 'Greedent',86);
  b.state.field.weather = 'Snowscape';
  assert.equal(residuals(b.state,b.me(),'p1')!.perTurnPercentOfMaxHP,6.3);
  b.me().ability = 'Snow Cloak';
  assert.equal(residuals(b.state,b.me(),'p1')!.perTurnPercentOfMaxHP,0);
});
test('weak priority comparison survives minimal detail and distinguishes safe hits from revenge chip', () => {
  const b = conk(); b.feed('|-weather|Snowscape');
  for (const detail of ['full','reduced','minimal'] as const) {
    const a = extractFeatures(input(b),detail).actions.find(a=>a.id==='move-1')!;
    assert.ok('priorityTradeoff' in a && a.priorityTradeoff);
    assert.equal(a.priorityTradeoff.strongerAction,'move-2');
    assert.equal(a.priorityTradeoff.survivesModeledSingleHit,true);
  }
  b.feed(b.request(11, Math.floor(b.me().exactHP!.max * .4)));
  const a = extractFeatures(input(b),'minimal').actions.find(a=>a.id==='move-1')!;
  assert.ok('priorityTradeoff' in a && a.priorityTradeoff);
  assert.equal(a.priorityTradeoff.survivesModeledSingleHit,false);
  b.feed('|-damage|p2a: Foe|1/100');
  const ko = extractFeatures(input(b),'minimal').actions.find(a=>a.id==='move-1')!;
  assert.ok(!('priorityTradeoff' in ko) || !ko.priorityTradeoff, 'do not discourage priority that finishes the target');
});
test('second empty Protect is blocked but a Wish, timer or recovery is a real exception', () => {
  const b = battle([ours('Glaceon',94,['Protect','Freeze-Dry'],'Ice Body','Heavy-Duty Boots','Water')], 'Greedent',86);
  b.foe().item = ''; b.foe().ability = 'Cheek Pouch'; b.me().consecutiveProtects = 1;
  assert.ok(futileProtect(input(b)).has('move-1'));
  b.state.sides.p1.slotConditions.wish = { setOnTurn: b.state.turn-1, healsHP:100, from:b.me().id };
  assert.equal(futileProtect(input(b)).size,0);
  delete b.state.sides.p1.slotConditions.wish;
  b.state.field.trickRoom = true;
  assert.equal(futileProtect(input(b)).size,0);
  b.state.field.trickRoom = false;
  b.foe().status = 'tox';
  assert.equal(futileProtect(input(b)).size,0);
});
