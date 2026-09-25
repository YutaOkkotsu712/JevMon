import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, ours } from './helpers.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { DecisionLoop, GUARDS } from '../src/battle/DecisionLoop.js';
import { preserveSoleDefensiveAnswer } from '../src/strategy/dominance.js';
import { endgame } from '../src/strategy/endgame.js';

test('preserves Carbink for Kilowattrel once Skarmory can safely finish the boosted Rayquaza', async () => {
  const b = battle([
    ours('Carbink', 90, ['Iron Defense', 'Rock Polish', 'Body Press', 'Moonblast'], 'Sturdy', 'Leftovers', 'Fighting'),
    ours('Skarmory', 80, ['Roost', 'Body Press', 'Brave Bird', 'Iron Defense'], 'Sturdy', 'Leftovers', 'Fighting'),
    ours('Pelipper', 86, ['Hydro Pump', 'U-turn', 'Hurricane', 'Weather Ball'], 'Drizzle', 'Choice Specs', 'Water'),
    ours('Urshifu', 74, ['Poison Jab', 'Wicked Blow', 'Close Combat', 'Swords Dance'], 'Unseen Fist', 'Life Orb', 'Dark'),
  ], 'Rayquaza', 72);
  b.feed('|switch|p2a: Kilowattrel|Kilowattrel, L83|100/100');
  b.feed('|move|p2a: Kilowattrel|Hurricane|p1a: Carbink\n|move|p2a: Kilowattrel|U-turn|p1a: Carbink');
  b.feed('|switch|p2a: Foe|Rayquaza, L72|35/100');
  const ray = b.state.sides.p2.team.find(p => p.species === 'Rayquaza')!;
  ray.revealedMoves = ['Dragon Dance']; ray.ability = 'Air Lock'; ray.boosts = { atk: 1, spe: 1, spa: -1 };
  b.state.turn = 11;
  const rawRequest = b.payload(2, 146);
  rawRequest.side.pokemon[0]!.condition = '146/236 par';
  const request = parseChoiceRequest(JSON.stringify(rawRequest))!;
  b.feed(`|request|${JSON.stringify(rawRequest)}`);
  const input = { state: b.state, legalActions: generateLegalActions(request), request };

  assert.equal(endgame(b.state, 'p1')?.soleDurableInto?.find(x => x.opposingPokemon === 'Kilowattrel')?.ourPokemon,
    'Carbink', 'the model should expose its defensive value despite the strict one-on-one loss');
  const moves = b.me().knownMoves;
  b.me().knownMoves = ['Splash'];
  assert.equal(endgame(b.state, 'p1')?.soleDurableInto?.find(x => x.opposingPokemon === 'Kilowattrel')?.ourPokemon,
    'Carbink', 'defensive value does not require a modeled attack');
  b.me().knownMoves = moves;
  assert.ok(GUARDS.includes(preserveSoleDefensiveAnswer));
  assert.equal(preserveSoleDefensiveAnswer(input).get('move-4')?.by, 'switch-2');
  const decision = await new Promise<import('../src/battle/DecisionLoop.js').DecisionRecord>(resolve => {
    const loop = new DecisionLoop({ room: b.state.battleId, username: 'Test Bot', dryRun: true,
      send: () => true, state: () => b.state, onStatus: () => {}, onDecision: resolve,
      provider: { async chooseAction() { return { chosenAction: 'move-4', probabilities: {
        'move-4': 0.7, 'switch-2': 0.2, 'move-3': 0.1,
      } }; } } });
    loop.request(JSON.stringify(request));
  });
  assert.equal(decision.selectedAction.id, 'switch-2');
  assert.equal(decision.skippedDominatedMove?.from, 'move-4');

  ray.hpPercent = 100;
  assert.equal(preserveSoleDefensiveAnswer(input).has('move-4'), false,
    'do not force a switch before Skarmory can knock Rayquaza out');
  ray.hpPercent = 35;
  b.state.sides.p2.team.find(p => p.species === 'Kilowattrel')!.fainted = true;
  assert.equal(preserveSoleDefensiveAnswer(input).has('move-4'), false,
    'the preservation rule needs a living bench threat');
});
