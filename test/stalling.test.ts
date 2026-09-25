import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residuals, survivalTurns } from '../src/strategy/residual.js';
import { opponentPP, protectOutlook } from '../src/strategy/stalling.js';
import { battle, ours } from './helpers.js';

const bronzong = (item = 'Leftovers') => ours('Bronzong', 88, ['Protect', 'Body Press', 'Rest'], 'Levitate', item, 'Fighting');

test('end-of-turn healing and chip are totalled, with the opponent item left as a range', () => {
  const b = battle([bronzong()], 'Amoonguss');
  const mine = residuals(b.state, b.me(), 'p1')!;
  assert.equal(mine.perTurnPercentOfMaxHP, 6.3, 'Leftovers is a sixteenth of max HP');
  assert.equal(mine.itemIsKnown, true);
  const theirs = residuals(b.state, b.foe(), 'p2')!;
  assert.deepEqual(theirs.perTurnPercentOfMaxHP, [0, 6.3], 'an unknown item covers every sampled possibility');
  assert.equal(theirs.itemIsKnown, false);
  // Chip stacks against the healing.
  b.feed('|-status|p1a: Bronzong|brn');
  assert.equal(residuals(b.state, b.me(), 'p1')!.perTurnPercentOfMaxHP, 0, 'a burn exactly cancels Leftovers');
  b.feed('|-start|p1a: Bronzong|move: Leech Seed');
  const seeded = residuals(b.state, b.me(), 'p1')!;
  assert.equal(seeded.perTurnPercentOfMaxHP, -12.5);
  // The item belongs in the list: a set of end-of-turn sources that omits Leftovers does not add up.
  assert.deepEqual(seeded.sources.map(x => x.source).sort(), ['Leech Seed', 'Leftovers', 'burn']);
  assert.equal(seeded.sources.reduce((n, x) => n + x.percent, 0), seeded.perTurnPercentOfMaxHP);
});

test('Magic Guard and type immunity remove the chip they are supposed to', () => {
  const sand = battle([bronzong('')], 'Amoonguss');
  sand.feed('|-weather|Sandstorm');
  assert.equal(residuals(sand.state, sand.me(), 'p1')!.perTurnPercentOfMaxHP, 0, 'Steel types ignore Sandstorm');
  const frail = battle([ours('Clefable', 82, ['Moonblast'], 'Magic Guard', 'Leftovers', 'Steel')], 'Amoonguss');
  frail.feed('|-weather|Sandstorm');
  frail.feed('|-status|p1a: Clefable|psn');
  const guarded = residuals(frail.state, frail.me(), 'p1')!;
  assert.equal(guarded.perTurnPercentOfMaxHP, 6.3, 'Magic Guard leaves only the healing');
  assert.deepEqual(guarded.sources, [{ source: 'Leftovers', percent: 6.3 }], 'the healing is all that is left');
});

test('survival counts the healing, and says so when healing wins', () => {
  assert.equal(survivalTurns(50, 20, 6.2)!.turns, 4);
  assert.equal(survivalTurns(50, 20, 0)!.turns, 3, 'without the healing it is a turn shorter');
  assert.equal(survivalTurns(50, 5, 6.2)!.turns, null);
  assert.match(survivalTurns(50, 5, 6.2)!.note, /healing matches or beats/);
  assert.equal(survivalTurns(null, 20, 0), null);
  assert.equal(survivalTurns(50, null, 0), null);
});

test('opposing PP is counted from observed uses, as an upper bound', () => {
  const b = battle([bronzong()], 'Amoonguss');
  assert.equal(opponentPP(b.state, b.foe(), b.me()), null, 'nothing revealed yet');
  b.feed('|move|p2a: Foe|Spore|p1a: Bronzong');
  b.feed('|move|p2a: Foe|Spore|p1a: Bronzong');
  const seen = opponentPP(b.state, b.foe(), b.me())!;
  const spore = seen.moves.find(m => m.move === 'Spore')!;
  assert.equal(spore.assumedMaxPP, 24, 'Spore is 15 base PP with full PP Ups');
  assert.equal(spore.timesSeenUsed, 2);
  assert.equal(spore.atMostRemaining, 22);
  // A called move spends no PP of its own.
  b.feed('|move|p2a: Foe|Spore|p1a: Bronzong|[from]Sleep Talk');
  assert.equal(opponentPP(b.state, b.foe(), b.me())!.moves.find(m => m.move === 'Spore')!.timesSeenUsed, 2);
});

test('Pressure doubles what the opponent spends, which is what makes a stall realistic', () => {
  const b = battle([ours('Dusclops', 84, ['Protect'], 'Pressure', 'Eviolite', 'Fairy')], 'Amoonguss');
  b.feed('|move|p2a: Foe|Spore|p1a: Dusclops');
  const pp = opponentPP(b.state, b.foe(), b.me())!;
  assert.equal(pp.ourPressureDoublesTheirCost, true);
  assert.equal(pp.moves[0]!.atMostRemaining, 22, 'one use costs two under Pressure');
});

test('Protect reports its falling success rate and whether stalling gains ground', () => {
  const b = battle([bronzong()], 'Amoonguss');
  assert.equal(protectOutlook(b.state, 'Body Press', 'p1', b.me(), b.foe()), null, 'only protecting moves report this');
  const first = protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!;
  assert.equal(first.successChance, 1, 'the first protect always works');
  assert.equal(first.opponentStillSpendsPPOnTheBlockedMove, true);
  b.feed('|move|p1a: Bronzong|Protect|p1a: Bronzong');
  assert.equal(protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!.successChance, 0.333);
  b.feed('|move|p1a: Bronzong|Protect|p1a: Bronzong');
  assert.equal(protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!.successChance, 0.111);
  // Anything else resets the streak.
  b.feed('|move|p1a: Bronzong|Body Press|p2a: Foe');
  assert.equal(protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!.successChance, 1);
  // Stalling gains ground when the end-of-turn balance favours us.
  b.feed('|-status|p2a: Foe|psn');
  const winning = protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!;
  assert.ok(winning.endOfTurnSwingPercentOfMaxHP! > 0, `poisoned opponent, got ${winning.endOfTurnSwingPercentOfMaxHP}`);
  assert.equal(winning.gainsGroundIfItWorks, true);
});

test('a state recorded before these counts existed reads as nothing seen, not as a failure', () => {
  const b = battle([bronzong()], 'Amoonguss');
  b.feed('|move|p2a: Foe|Spore|p1a: Bronzong');
  const foe = b.foe() as { moveUses?: Record<string, number>; ppSpent?: Record<string, number>; consecutiveProtects?: number };
  delete foe.moveUses; delete foe.ppSpent;
  delete (b.me() as { consecutiveProtects?: number }).consecutiveProtects;
  const pp = opponentPP(b.state, b.foe(), b.me())!;
  assert.equal(pp.moves[0]!.timesSeenUsed, 0, 'unknown usage counts as none seen');
  assert.equal(pp.moves[0]!.atMostRemaining, pp.moves[0]!.assumedMaxPP);
  assert.equal(protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!.successChance, 1);
});
