import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choiceTrickOutlook } from '../src/strategy/itemSwap.js';
import { extractFeatures } from '../src/strategy/features.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { battle, ours } from './helpers.js';

test('Trick prices locking a revealed recovery move and taking the switch-in item', () => {
  const b = battle([ours('Rotom', 88, ['Thunderbolt', 'Trick'], 'Levitate', 'Choice Scarf', 'Ghost')], 'Noctowl', 95);
  b.foe().revealedMoves = ['Roost', 'Calm Mind'];
  const plan = choiceTrickOutlook(b.state, b.me(), b.foe(), 'p1', 'Trick')!;
  assert.equal(plan.gives, 'Choice Scarf');
  assert.deepEqual(plan.ifTheyStay.theirRevealedSetupOrRecovery, ['Roost', 'Calm Mind']);
  assert.equal(plan.ifTheyStay.swapBeforeTheirMove, true);

  b.feed('|switch|p2a: Alcremie|Alcremie, L90, F|100/100');
  b.feed('|switch|p2a: Noctowl|Noctowl, L95, M|100/100');
  const alcremie = b.state.sides.p2.team.find(p => p.species === 'Alcremie')!;
  alcremie.item = 'Leftovers';
  const arrival = choiceTrickOutlook(b.state, b.me(), b.foe(), 'p1', 'Trick', 'Alcremie')!;
  assert.deepEqual(arrival.ifTheyRepeatObservedSwitch?.incoming, 'Alcremie');
  assert.equal(arrival.ifTheyRepeatObservedSwitch?.itsItem, 'Leftovers');

  const request = parseChoiceRequest(JSON.stringify(b.payload(2, b.me().exactHP!.max)))!;
  const features = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'minimal');
  const action = features.actions.find(x => x.label === 'Trick') as { choiceItemTrick?: { gives: string } };
  assert.equal(action.choiceItemTrick?.gives, 'Choice Scarf', 'the value survives a compact payload');
});
