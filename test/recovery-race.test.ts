import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, ours } from './helpers.js';
import { parseChoiceRequest, generateLegalActions } from '../src/battle/LegalActionGenerator.js';
import { DecisionLoop, GUARDS } from '../src/battle/DecisionLoop.js';
import { recoilIntoRecovery } from '../src/strategy/dominance.js';
import { extractFeatures } from '../src/strategy/features.js';

test('Rest interrupts a losing Wave Crash recoil race against faster Recover', async () => {
  const b = battle([
    ours('Dondozo', 78, ['Rest', 'Sleep Talk', 'Curse', 'Wave Crash'], 'Unaware', 'Leftovers', 'Fairy'),
    ours('Weavile', 79, ['Triple Axel', 'Knock Off', 'Swords Dance', 'Low Kick'], 'Pressure', 'Life Orb', 'Dark'),
  ], 'Arceus-Fighting', 70);
  const me = b.me(), foe = b.foe();
  b.state.turn = 32;
  me.boosts = { spe: -1, atk: 1, def: 1 };
  foe.hpPercent = 40;
  foe.revealedMoves = ['Body Press', 'Recover'];
  foe.lastMoveUsed = 'Recover';
  b.state.healsAgainst = { [`${foe.id}>${me.id}`]: 1 };
  const request = parseChoiceRequest(JSON.stringify(b.payload(32, 119)))!;
  b.feed(`|request|${JSON.stringify(request)}`);
  const input = { state: b.state, request, legalActions: generateLegalActions(request) };

  assert.ok(GUARDS.includes(recoilIntoRecovery));
  assert.equal(recoilIntoRecovery(input).get('move-4')?.by, 'move-1');
  const wave = extractFeatures(input, 'reduced').actions.find(a => a.id === 'move-4')!;
  const recovery = 'ifTheyRecoverBeforeThisHit' in wave ? wave.ifTheyRecoverBeforeThisHit : null;
  assert.equal(recovery?.knockoutAfterRecovery, false);
  assert.equal(recovery?.theirHPBeforeHitPercent, 90);
  const decision = await new Promise<import('../src/battle/DecisionLoop.js').DecisionRecord>(resolve => {
    const loop = new DecisionLoop({ room: b.state.battleId, username: 'Test Bot', dryRun: true,
      send: () => true, state: () => b.state, onStatus: () => {}, onDecision: resolve,
      provider: { async chooseAction() { return { chosenAction: 'move-4', probabilities: {
        'move-4': 0.78, 'move-1': 0.08, 'move-3': 0.07, 'switch-2': 0.06, 'move-2': 0.01,
      } }; } } });
    loop.request(JSON.stringify(request));
  });
  assert.equal(decision.selectedAction.id, 'move-1');
  assert.equal(decision.skippedDominatedMove?.from, 'move-4');

  b.state.healsAgainst = {};
  assert.equal(recoilIntoRecovery(input).has('move-4'), false, 'do not assume an unobserved healing loop');
  b.state.healsAgainst = { [`${foe.id}>${me.id}`]: 1 };
  me.hpPercent = 14;
  me.exactHP!.current = Math.round(me.exactHP!.max * 0.14);
  assert.equal(recoilIntoRecovery(input).has('move-4'), false, 'Rest must survive the hit before it can heal');
  me.hpPercent = 32;
  me.exactHP!.current = Math.round(me.exactHP!.max * 0.32);
  foe.volatiles.taunt = { sinceTurn: 32, data: null };
  assert.equal(recoilIntoRecovery(input).has('move-4'), false, 'Taunt stops their Recover, so the apparent KO is real');
  const tauntedWave = extractFeatures(input, 'reduced').actions.find(a => a.id === 'move-4')!;
  assert.equal('ifTheyRecoverBeforeThisHit' in tauntedWave, false);
  delete foe.volatiles.taunt;
  b.state.healsAgainst = { [`${foe.id}>${me.id}`]: 2 };
  foe.item = 'Choice Scarf';
  foe.lastMoveUsed = 'Body Press';
  assert.equal(recoilIntoRecovery(input).has('move-4'), false, 'a known Choice lock prevents Recover');
  foe.item = 'Leftovers';
  foe.lastMoveUsed = 'Recover';
  foe.ppSpent = { recover: 8 };
  const exhaustedWave = extractFeatures(input, 'reduced').actions.find(a => a.id === 'move-4')!;
  assert.equal('ifTheyRecoverBeforeThisHit' in exhaustedWave, false, 'an exhausted Recover cannot undo the knockout');
});
