import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cyclicSwitch } from '../src/strategy/loopGuard.js';
import { incomingThreats } from '../src/strategy/threat.js';
import { DecisionLoop } from '../src/battle/DecisionLoop.js';
import type { DecisionRecord } from '../src/battle/DecisionLoop.js';
import type { DecisionProvider, DecisionResult } from '../src/decisions/DecisionProvider.js';
import { battle, ours, room } from './helpers.js';

const bronzong = () => ours('Bronzong', 88, ['Body Press', 'Psychic Noise', 'Rest', 'Iron Defense'], 'Levitate', 'Chesto Berry', 'Fighting');
const dragapult = () => ours('Dragapult', 78, ['Shadow Ball', 'Draco Meteor'], 'Infiltrator', 'Choice Specs', 'Ghost');
/** Bronzong leads, leaves on turn 2, Dragapult arrives on turn 2: returning to Bronzong now undoes that. */
function pingPong() {
  const b = battle([bronzong(), dragapult()], 'Amoonguss');
  b.feed('|turn|2');
  b.feed(`|switch|p1a: Dragapult|Dragapult, L78, M|${b.state.sides.p1.team[1]!.exactHP!.max}/${b.state.sides.p1.team[1]!.exactHP!.max}`);
  b.feed('|turn|3');
  return b;
}

test('returning to a Pokemon we just left, with one that just arrived, is recognised as a cycle', () => {
  const b = pingPong();
  const [left, arrived] = b.state.sides.p1.team as [typeof b.state.sides.p1.team[0], typeof b.state.sides.p1.team[0]];
  assert.equal(arrived!.activeSinceTurn, 2, 'Dragapult arrived on turn 2');
  assert.equal(left!.lastActiveTurn, 2, 'Bronzong left on turn 2');
  const reason = cyclicSwitch(b.state, 'p1', left!);
  assert.ok(reason, 'the cycle is detected');
  assert.match(reason!, /would undo last turn's switch/);
  assert.equal(cyclicSwitch(b.state, 'p1', arrived!), null, 'switching to the Pokemon already in is not a cycle');
});

test('the guard stays out of the way of ordinary play', () => {
  const settled = pingPong();
  settled.feed('|turn|6');
  assert.equal(cyclicSwitch(settled.state, 'p1', settled.state.sides.p1.team[0]!), null,
    'once our Pokemon has settled in, leaving is an ordinary choice');
  const fresh = battle([bronzong(), dragapult()], 'Amoonguss');
  fresh.feed('|turn|2');
  assert.equal(cyclicSwitch(fresh.state, 'p1', fresh.state.sides.p1.team[1]!), null,
    'a target we have never sent out is not a cycle');
  // Fleeing a certain knockout is worth a turn even when the shape looks cyclic.
  const doomed = pingPong();
  doomed.feed(doomed.request(9, 1, 1));
  assert.equal(cyclicSwitch(doomed.state, 'p1', doomed.state.sides.p1.team[0]!), null,
    'at 1 HP the incoming attack is a certain KO, so leaving is not a cycle');
});

test('a replacement for a fainted Pokemon has spent no turn, so leaving it is not a cycle', () => {
  const b = battle([bronzong(), dragapult(), ours('Seviper', 93, ['Gunk Shot', 'Earthquake'], 'Infiltrator', 'Leftovers', 'Poison')], 'Amoonguss');
  b.feed('|turn|2');
  b.feed('|faint|p1a: Bronzong');
  // Both sides replace at once: Dragapult is chosen without seeing Wo-Chien.
  b.feed(`|switch|p1a: Dragapult|Dragapult, L78, M|${b.state.sides.p1.team[1]!.exactHP!.max}/${b.state.sides.p1.team[1]!.exactHP!.max}`);
  b.feed('|switch|p2a: Wo-Chien|Wo-Chien, L83|100/100');
  b.feed('|turn|3');
  assert.equal(b.state.sides.p1.team[1]!.activeSinceTurn, 2);
  const seviper = b.state.sides.p1.team.find(p => p.species === 'Seviper')!;
  assert.equal(cyclicSwitch(b.state, 'p1', seviper), null);
  b.state.sides.p1.team[0]!.fainted = false;
  assert.ok(cyclicSwitch(b.state, 'p1', seviper), 'the same arrival by a chosen switch is still held in');
});

test('a cyclic choice is skipped for the provider\'s next preference, and recorded', async () => {
  const b = pingPong();
  const sent: string[] = [];
  const records: DecisionRecord[] = [];
  // The provider most wants the cycle, then Shadow Ball, then Draco Meteor.
  const ranked: Record<string, number> = { 'switch-1': 0.6, 'move-1': 0.3, 'move-2': 0.1 };
  const provider: DecisionProvider = { async chooseAction(): Promise<DecisionResult> {
    return { chosenAction: 'switch-1', provider: 'jev', confidence: 0.6, probabilities: { ...ranked } };
  } };
  const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: false, provider,
    send: command => { sent.push(command); return true; },
    state: () => b.state, onStatus: () => {}, onDecision: r => records.push(r) });
  loop.request(JSON.stringify({ rqid: 11,
    active: [{ moves: [{ move: 'Shadow Ball', id: 'shadowball' }, { move: 'Draco Meteor', id: 'dracometeor' }] }],
    side: { id: 'p1', name: 'Test Bot', pokemon: [
      { ident: 'p1: Bronzong', details: 'Bronzong, L88', condition: '261/261', active: false },
      { ident: 'p1: Dragapult', details: 'Dragapult, L78, M', condition: '265/265', active: true }] } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.selectedAction.id, 'move-1', 'it takes the next-ranked action, not an invented one');
  assert.ok(record.skippedCyclicSwitch, 'the skip is recorded rather than silent');
  assert.equal(record.skippedCyclicSwitch!.from, 'switch-1');
  assert.equal(record.skippedCyclicSwitch!.to, 'move-1');
  assert.match(record.skippedCyclicSwitch!.reason, /would undo last turn's switch/);
  assert.ok(sent[0]!.endsWith('|/choose move 1|11'), `sent ${sent[0]}`);
  loop.stop();
});

test('a replacement that dies on entry is left to the provider, even when another would survive', async () => {
  // Entry death is a sacrifice cost for the model to weigh, so the loop must not veto it on its own.
  const roster = [ours('Bronzong', 88, ['Body Press'], 'Levitate', 'Chesto Berry', 'Fighting'),
    ours('Dragapult', 78, ['Shadow Ball'], 'Infiltrator', 'Choice Specs', 'Ghost'),
    ours('Skarmory', 84, ['Body Press', 'Roost'], 'Sturdy', 'Leftovers', 'Dragon')];
  const b = battle(roster, 'Basculegion-F', 83);
  b.feed('|turn|5');
  b.feed(`|switch|p1a: Dragapult|${roster[1]!.details}|${roster[1]!.maxHP}/${roster[1]!.maxHP}`);
  b.feed('|turn|9');
  const payload = b.payload(12, roster[1]!.maxHP, 1);
  payload.side.pokemon[0]!.condition = `6/${roster[0]!.maxHP}`; // Bronzong waits on the bench at a sliver.
  b.feed(`|request|${JSON.stringify(payload)}`);
  const [frail, , sturdy] = b.state.sides.p1.team;
  assert.equal(incomingThreats(b.state, frail!, 'p1', 1)?.conditionalKO, 'all-sampled-rolls', 'Bronzong dies on entry');
  assert.notEqual(incomingThreats(b.state, sturdy!, 'p1', 1)?.conditionalKO, 'all-sampled-rolls', 'Skarmory survives it');
  const sent: string[] = [];
  const records: DecisionRecord[] = [];
  const provider: DecisionProvider = { async chooseAction(): Promise<DecisionResult> {
    return { chosenAction: 'switch-1', provider: 'jev', confidence: 0.5,
      probabilities: { 'switch-1': 0.5, 'switch-3': 0.3, 'move-1': 0.2 } };
  } };
  const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: false, provider,
    send: command => { sent.push(command); return true; },
    state: () => b.state, onStatus: () => {}, onDecision: r => records.push(r) });
  loop.request(JSON.stringify(payload));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(records.length, 1);
  assert.equal(records[0]!.selectedAction.id, 'switch-1', 'the sacrifice the provider chose is what is sent');
  assert.equal(records[0]!.skippedCyclicSwitch, undefined);
  assert.equal(records[0]!.skippedDominatedMove, undefined);
  assert.ok(sent[0]!.endsWith('|/choose switch 1|12'), `sent ${sent[0]}`);
  loop.stop();
});

test('the opening lead is not treated as a switch that was just made', () => {
  // Nothing was spent putting the lead on the field, so leaving on turn one undoes nothing.
  const b = battle([bronzong(), dragapult()], 'Amoonguss');
  assert.equal(b.me().activeSinceTurn, 0, 'the lead arrives before turn one');
  assert.equal(cyclicSwitch(b.state, 'p1', b.state.sides.p1.team[1]!), null, 'so switching away is an ordinary choice');
  // A Pokemon that genuinely switched in on turn one is still covered.
  b.feed('|turn|2');
  b.feed(`|switch|p1a: Dragapult|Dragapult, L78, M|${b.state.sides.p1.team[1]!.exactHP!.max}/${b.state.sides.p1.team[1]!.exactHP!.max}`);
  b.feed('|turn|3');
  assert.ok(cyclicSwitch(b.state, 'p1', b.state.sides.p1.team[0]!), 'returning to what we just left is still a cycle');
});

test('two repeated switch pairs are stopped before a nearly spent answer is sent around again', () => {
  const b = battle([
    ours('Arboliva', 91, ['Energy Ball', 'Strength Sap'], 'Seed Sower', 'Leftovers', 'Grass'),
    ours('Rotom', 88, ['Thunderbolt', 'Trick'], 'Levitate', 'Choice Scarf', 'Ghost'),
  ], 'Noctowl');
  b.feed('|switch|p2a: Alcremie|Alcremie, L90, F|100/100');
  b.feed('|switch|p2a: Noctowl|Noctowl, L95, M|100/100');
  b.state.turn = 35;
  const oursSide = b.state.sides.p1, theirSide = b.state.sides.p2;
  const target = oursSide.team.find(p => p.species === 'Rotom')!;
  target.hpPercent = 17;
  const ourSwitch = (turn: number, from: string, to: string, facing: string) =>
    ({ turn, from, to, facing, afterFaint: false, dragged: false, via: null });
  oursSide.switches = [ourSwitch(27, 'Arboliva', 'Rotom', 'Noctowl'),
    ourSwitch(29, 'Rotom', 'Arboliva', 'Alcremie'),
    ourSwitch(31, 'Arboliva', 'Rotom', 'Noctowl'),
    ourSwitch(33, 'Rotom', 'Arboliva', 'Alcremie')];
  theirSide.switches = [ourSwitch(28, 'Noctowl', 'Alcremie', 'Rotom'),
    ourSwitch(30, 'Alcremie', 'Noctowl', 'Arboliva'),
    ourSwitch(32, 'Noctowl', 'Alcremie', 'Rotom'),
    ourSwitch(34, 'Alcremie', 'Noctowl', 'Arboliva')];
  assert.match(cyclicSwitch(b.state, 'p1', target)!, /already led twice/);
  target.hpPercent = 80;
  assert.equal(cyclicSwitch(b.state, 'p1', target), null, 'a healthy target leaves the strategic choice open');
});
