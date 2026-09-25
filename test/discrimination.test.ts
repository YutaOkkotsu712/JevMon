import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, ours } from './helpers.js';
import { dominatedMoves } from '../src/strategy/dominance.js';
import { generateLegalActions, type ChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { damageRange } from '../src/strategy/damage.js';
import { extractFeatures } from '../src/strategy/features.js';
import { survivalTurns } from '../src/strategy/residual.js';
import { hazardValue } from '../src/strategy/hazards.js';
function input(b: ReturnType<typeof battle>) {
  const request = b.payload(7, b.me().exactHP!.current) as unknown as ChoiceRequest;
  for (const m of request.active![0]!.moves) { m.pp = 24; m.maxpp = 24; }
  return { state: b.state, request, legalActions: generateLegalActions(request) };
}
test('a simple weaker attack is dominated only when its effects, PP and accuracy offer no tradeoff', () => {
  const b = battle([ours('Blastoise', 84, ['Water Gun','Surf'], 'Torrent', '', 'Water')], 'Sylveon', 84);
  const i = input(b);
  assert.equal(dominatedMoves(i).get('move-1')?.by, 'move-2');
  i.request.active![0]!.moves[1]!.pp = 1;
  assert.equal(dominatedMoves(i).size, 0, 'preserve a scarce stronger move');
  i.request.active![0]!.moves[1]!.pp = 24;
  i.request.active![0]!.moves[1]!.id = 'hydropump';
  assert.equal(dominatedMoves(i).size, 0, 'accuracy is not interchangeable');
});
test('Flamethrower burn remains an option; existing status can remove that tradeoff', () => {
  const b = battle([ours('Walking Wake', 78, ['Flamethrower','Hydro Steam'], 'Protosynthesis', '', 'Water')], 'Sylveon', 84);
  assert.equal(dominatedMoves(input(b)).size, 0);
  b.foe().status = 'par';
  assert.equal(dominatedMoves(input(b)).get('move-1')?.by, 'move-2');
});
test('Substitute HP starts at floor(maxHP/4), remains an interval after hits, and clears when broken', () => {
  const b = battle([ours('Blastoise', 84, ['Water Gun','Surf'], 'Torrent', '', 'Water')], 'Sylveon', 84);
  b.feed('|-start|p1a: Blastoise|Substitute');
  const size = Math.floor(b.me().exactHP!.max / 4);
  assert.deepEqual(b.me().substitute!.hp, [size, size]);
  b.feed('|move|p2a: Foe|Quick Attack|p1a: Blastoise\n|-activate|p1a: Blastoise|move: Substitute|[damage]');
  assert.ok(b.me().substitute!.hp[0] >= 1);
  assert.ok(b.me().substitute!.hp[1] < size);
  assert.equal(b.me().substitute!.hits, 1);
  b.feed('|-end|p1a: Blastoise|Substitute');
  assert.equal(b.me().substitute, undefined);
});
test('breaking a Substitute is not a KO and single-hit excess damage never reaches its holder', () => {
  const b = battle([ours('Blastoise', 84, ['Surf'], 'Torrent', '', 'Water')], 'Sylveon', 84);
  b.feed('|-start|p2a: Foe|Substitute');
  b.foe().substitute!.hp = [1, 5];
  const d = damageRange(b.state, 'Surf')!;
  assert.equal(d.substituteDamage!.breaks, 'all-sampled-rolls');
  assert.deepEqual(d.hp, [0, 0]); assert.equal(d.conditionalKO, 'none-sampled');
  assert.equal(d.substituteDamage!.excessDamageSpillsThrough, false);
  assert.deepEqual(d.substituteDamage!.damageHP, [1, 5], 'damage absorbed cannot exceed remaining shield HP');
  assert.equal(d.takesNothingFromIt, undefined, 'a shield is not a type or ability immunity');
});
test('sound and Infiltrator bypass Substitute; a missed or critical hit does not pretend to give exact HP', () => {
  const b = battle([ours('Dragapult', 78, ['Shadow Ball','Psychic Noise'], 'Infiltrator', '', 'Ghost')], 'Sylveon', 84);
  b.feed('|-start|p2a: Foe|Substitute');
  assert.ok(damageRange(b.state, 'Shadow Ball')!.hp[0] > 0);
  b.me().ability = 'Clear Body';
  assert.deepEqual(damageRange(b.state, 'Shadow Ball')!.hp, [0, 0]);
  assert.ok(damageRange(b.state, 'Psychic Noise')!.hp[0] > 0);
  const old = [...b.foe().substitute!.hp];
  b.feed('|move|p1a: Dragapult|Shadow Ball|p2a: Foe\n|-miss|p1a: Dragapult|p2a: Foe');
  assert.deepEqual(b.foe().substitute!.hp, old);
  b.feed('|move|p1a: Dragapult|Shadow Ball|p2a: Foe\n|-crit|p2a: Foe\n|-activate|p2a: Foe|move: Substitute|[damage]');
  assert.deepEqual(b.foe().substitute!.hp, [1, old[1]]);
});
test('fatal damage precedes healing, and zero future entries means zero hazard value', () => {
  assert.equal(survivalTurns(5, 6, 10)!.turns, 1);
  assert.equal(survivalTurns(50, 55, 6.3)!.turns, 1);
  const b = battle([ours('Skarmory', 84, ['Stealth Rock'], 'Sturdy', '', 'Dragon')], 'Sylveon');
  b.state.sides.p2.teamSize = 1;
  assert.equal(hazardValue(b.state, 'Stealth Rock', 'p1')!.noFutureEntryValue, true);
});
test('forced replacements have no attack on entry, and reduced detail preserves threat and endgame fields', () => {
  const b = battle([ours('Blastoise', 84, ['Surf'], 'Torrent', '', 'Water'), ours('Charizard', 84, ['Flamethrower'], 'Blaze', '', 'Fire')], 'Sylveon');
  const i = input(b); b.me().fainted = true; i.request.forceSwitch = [true]; delete i.request.active;
  i.legalActions = generateLegalActions(i.request);
  const f = extractFeatures(i, 'reduced');
  assert.ok(f.endgame); assert.ok(f.switching.forcedReplacement);
  assert.ok(f.actions.every(a => !('knockedOutOnEntry' in a) && !('wouldUndoLastSwitch' in a)));
  assert.ok(f.actions.every(a => 'entryAttackThisTurn' in a && a.entryAttackThisTurn === false));
});
test('the runtime guard follows the provider ranking and logs a dominated-move override', async () => {
  const { DecisionLoop } = await import('../src/battle/DecisionLoop.js');
  const b = battle([ours('Blastoise', 84, ['Water Gun','Surf'], 'Torrent', '', 'Water')], 'Sylveon', 84);
  const i = input(b);
  const record = await new Promise<import('../src/battle/DecisionLoop.js').DecisionRecord>(resolve => {
    const loop = new DecisionLoop({ room: b.state.battleId, username: 'Test Bot', dryRun: true,
      send: () => true, state: () => b.state, onStatus: () => {}, onDecision: resolve,
      provider: { async chooseAction() { return { chosenAction: 'move-1', probabilities: { 'move-1': 0.9, 'move-2': 0.1 } }; } } });
    loop.request(JSON.stringify(i.request));
  });
  assert.equal(record.selectedAction.id, 'move-2');
  assert.equal(record.skippedDominatedMove?.from, 'move-1');
  assert.equal(record.providerResult?.chosenAction, 'move-1', 'retain the original model decision for audit');
  assert.equal(record.fallback, false);
});
test('reduced payload names the stronger damage option without pretending burn has no value', () => {
  const b = battle([ours('Walking Wake', 78, ['Flamethrower','Hydro Steam'], 'Protosynthesis', '', 'Water')], 'Sylveon', 84);
  const features = extractFeatures(input(b), 'reduced');
  const flame = features.actions.find(a => a.id === 'move-1')!;
  assert.equal(flame.strongerImmediateDamageAvailable?.action, 'move-2');
  assert.ok('effect' in flame && JSON.stringify(flame.effect).includes('brn'));
  assert.ok(!('dominatedBy' in flame) || !flame.dominatedBy);
});
test('Substitute HP survives an explicit Baton Pass without being resized to the recipient', () => {
  const b = battle([ours('Blastoise', 84, ['Baton Pass'], 'Torrent', '', 'Water'), ours('Charizard', 84, ['Flamethrower'], 'Blaze', '', 'Fire')], 'Sylveon');
  b.feed('|-start|p1a: Blastoise|Substitute');
  b.me().substitute!.hp = [8, 14];
  b.feed('|move|p1a: Blastoise|Baton Pass|p1a: Blastoise\n|switch|p1a: Charizard|Charizard, L84|250/250');
  assert.deepEqual(b.me().substitute!.hp, [8, 14]);
  assert.ok(b.me().volatiles.Substitute);
});
test('emergency payload retains switching, setup warnings, turn order and endgame', () => {
  const b = battle([ours('Misdreavus', 84, ['Nasty Plot','Shadow Ball'], 'Levitate', '', 'Ghost'), ours('Blastoise', 84, ['Surf'], 'Torrent', '', 'Water')], 'Dragapult');
  b.feed(b.request(6, 1));
  const f = extractFeatures(input(b), 'minimal');
  const setup = f.actions.find(a => a.label === 'Nasty Plot')!;
  const sw = f.actions.find(a => a.kind === 'switch')!;
  assert.ok('afterItsStatChange' in setup && setup.afterItsStatChange?.wastedBecauseWeAreKnockedOutFirst);
  assert.ok('turnOrder' in setup && setup.turnOrder);
  assert.ok('switchIn' in sw && sw.switchIn?.incomingThreat);
  assert.ok(f.endgame);
  assert.ok(f.omittedForBudget.length);
});
test('a forced pivot is not advertised as immune to a pending opposing action', () => {
  const b = battle([ours('Blastoise', 84, ['Flip Turn'], 'Torrent', '', 'Water'), ours('Charizard', 84, ['Flamethrower'], 'Blaze', '', 'Fire')], 'Sylveon');
  const i = input(b); i.request.forceSwitch = [true]; delete i.request.active;
  i.legalActions = generateLegalActions(i.request);
  const f = extractFeatures(i, 'reduced');
  assert.ok(f.actions.every(a => 'entryAttackThisTurn' in a && a.entryAttackThisTurn === null));
  assert.match(f.stayingInIsNotAnOption!, /pending/);
});
test('authoritative trapping removes switch options while retaining survival warnings', () => {
  const b = battle([ours('Blastoise', 84, ['Surf'], 'Torrent', '', 'Water'), ours('Charizard', 84, ['Flamethrower'], 'Blaze', '', 'Fire')], 'Sylveon');
  const i = input(b); i.request.active![0]!.trapped = true; i.legalActions = generateLegalActions(i.request);
  const f = extractFeatures(i, 'reduced');
  assert.equal(f.switching.legalSwitchCount, 0);
  assert.equal(f.switching.trapped, true);
  assert.ok(f.actions.every(a => a.kind !== 'switch'));
});
