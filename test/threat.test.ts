import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomingThreats, outgoingBest } from '../src/strategy/threat.js';
import { turnOrder, speedSummary } from '../src/strategy/speed.js';
import { plausibleMoves } from '../src/strategy/setPriors.js';
import { moveEffect, substituteInteraction } from '../src/pokemon/mechanics.js';
import { extractFeatures } from '../src/strategy/features.js';
import type { BattleAction, ChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { inferOpponent } from '../src/strategy/inference.js';
import { dedupeCandidates } from '../src/strategy/calcCore.js';
import { battle, ours } from './helpers.js';
const bronzong = () => ours('Bronzong', 88, ['Body Press', 'Psychic Noise', 'Rest', 'Iron Defense'], 'Levitate', 'Chesto Berry', 'Fighting');
const dragapult = () => ours('Dragapult', 78, ['Shadow Ball', 'Draco Meteor'], 'Infiltrator', 'Choice Specs', 'Ghost');

test('plausible opponent moves put revealed moves first and carry generation frequencies', () => {
  const b = battle([bronzong()], 'Azumarill');
  b.foe().revealedMoves = ['Liquidation'];
  const moves = plausibleMoves(b.foe());
  assert.equal(moves[0]!.move, 'Liquidation');
  assert.equal(moves[0]!.revealed, true);
  assert.ok(moves.length > 1, 'unrevealed role moves are still offered');
  assert.ok(moves.slice(1).every(m => !m.revealed && m.priorProbability !== null && m.priorProbability > 0));
  assert.ok(moves.every((m, i) => i === 0 || (m.priorProbability ?? 0) <= (moves[i - 1]!.priorProbability ?? 1) || moves[i - 1]!.revealed));
});

test('four revealed Random Battle moves close the opposing move set', () => {
  const b = battle([bronzong()], 'Tropius');
  b.foe().revealedMoves = ['Dragon Dance', 'Dual Wingbeat', 'Earthquake', 'Synthesis'];
  assert.deepEqual(plausibleMoves(b.foe()).map(m => m.move), b.foe().revealedMoves);
  assert.deepEqual(inferOpponent(b.foe()).summary.possibleUnrevealedMoves, []);
  const threat = incomingThreats(b.state, b.me(), 'p1')!;
  assert.ok(!threat.damagingMoves.some(m => m.move === 'Leaf Blade'));
});

test('incoming damage reports the worst sampled case and separates unmodelled moves', () => {
  const b = battle([bronzong()], 'Azumarill');
  const threat = incomingThreats(b.state, b.me(), 'p1')!;
  assert.equal(threat.attacker, 'Azumarill');
  assert.ok(threat.sampledSets > 0);
  assert.ok(threat.damagingMoves.length > 0);
  assert.equal(threat.worstCasePercentOfMaxHP, threat.damagingMoves[0]!.percentOfMaxHP[1], 'the report leads with the worst move');
  assert.ok(threat.damagingMoves.every(m => m.percentOfMaxHP[0]! <= m.percentOfMaxHP[1]!));
  assert.ok(threat.otherPlausibleMoves.every(m => m.category === 'Status' || m.move === 'Belly Drum'),
    'non-damaging possibilities are named rather than silently dropped');
});

test('incoming damage tracks a known KO risk and the defender current HP', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  const healthy = incomingThreats(b.state, b.me(), 'p1')!;
  assert.equal(healthy.conditionalKO, 'none-sampled');
  b.feed(b.request(3, 12));
  const weak = incomingThreats(b.state, b.me(), 'p1')!;
  assert.equal(weak.conditionalKO, 'all-sampled-rolls', 'at 12 HP every sampled Liquidation is lethal');
  assert.equal(weak.worstCasePercentOfMaxHP, healthy.worstCasePercentOfMaxHP, 'percentages are of max HP, so the damage itself is unchanged');
});

test('our own best damage uses private moves and names them canonically', () => {
  const b = battle([bronzong()], 'Azumarill');
  const best = outgoingBest(b.state, b.me(), 'p1')!;
  assert.equal(best.target, 'Azumarill');
  assert.equal(best.moves[0]!.move, 'Psychic Noise', 'Fairy resists Body Press, so the special move is stronger here');
  assert.ok(best.moves.every(m => /^[A-Z]/.test(m.move)), 'request move IDs are resolved to display names');
  assert.equal(best.bestCasePercentOfMaxHP, best.moves[0]!.percentOfMaxHP[1]);
  assert.equal(outgoingBest(b.state, b.state.sides.p1.team[0]!, 'p1')!.sampledSets, best.sampledSets);
});

test('turn order is settled by speed only when no sampled opposing move can jump us', () => {
  // Amoonguss generates no priority move, so being faster settles the order outright.
  const clean = battle([dragapult()], 'Amoonguss');
  const settled = turnOrder(clean.state, clean.me(), 'Shadow Ball')!;
  const shared = speedSummary(clean.state);
  assert.deepEqual(shared.opponentPriorityBracket, [0, 0]);
  assert.equal(settled.order, 'ours-first');
  assert.equal(shared.ifEqualPriority, 'ours-first');
  assert.deepEqual(settled.opponentMovesThatOutprioritiseUs, []);
  assert.ok(shared.ours! > shared.opponentRange![1]!);
  // Aqua Jet can resolve before us, so speed alone no longer settles anything.
  const jumped = battle([dragapult()], 'Azumarill');
  const open = turnOrder(jumped.state, jumped.me(), 'Shadow Ball')!;
  assert.equal(open.order, 'uncertain');
  assert.equal(speedSummary(jumped.state).ifEqualPriority, 'ours-first', 'the speed deduction is still reported');
  assert.deepEqual(open.opponentMovesThatOutprioritiseUs.map(m => m.move), ['Aqua Jet']);
  // Being slower is decided even when the opponent also has faster-priority options.
  const slow = battle([bronzong()], 'Wo-Chien');
  assert.equal(turnOrder(slow.state, slow.me(), 'Body Press')!.order, 'theirs-first');
  // Gale Wings depends only on HP, which is public, so at full HP its Flying move is known to jump the queue.
  const gale = battle([ours('Talonflame', 80, ['Brave Bird', 'Roost'], 'Gale Wings', 'Leftovers', 'Flying')], 'Amoonguss');
  assert.equal(turnOrder(gale.state, gale.me(), 'Brave Bird')!.ourPriority, 1);
  assert.equal(turnOrder(gale.state, gale.me(), 'Brave Bird')!.order, 'ours-first');
});

test('Trick Room reverses the deduced order without changing the speeds reported', () => {
  const b = battle([dragapult()], 'Amoonguss');
  const before = speedSummary(b.state);
  assert.equal(turnOrder(b.state, b.me(), 'Shadow Ball')!.order, 'ours-first');
  b.feed('|-fieldstart|move: Trick Room');
  const after = speedSummary(b.state);
  assert.equal(turnOrder(b.state, b.me(), 'Shadow Ball')!.order, 'theirs-first');
  assert.equal(after.ifEqualPriority, 'theirs-first');
  assert.equal(after.trickRoom, true);
  assert.equal(after.ours, before.ours);
  assert.deepEqual(after.opponentRange, before.opponentRange);
  assert.equal(after.relation, 'faster-than-all-samples', 'effective speed is unchanged; only the order flips');
});

test('move effects expose recovery, setup, status and forced switches', () => {
  assert.equal(moveEffect('Rest', 300)!.healPercentOfMaxHP, 100);
  assert.equal(moveEffect('Rest', 300)!.sleepsUserUntilCured, true);
  assert.equal(moveEffect('Roost', 300)!.healHPIfKnown, 150);
  assert.deepEqual(moveEffect('Dragon Dance', null)!.userBoosts, { atk: 1, spe: 1 });
  assert.deepEqual(moveEffect('Close Combat', null)!.userBoosts, { def: -1, spd: -1 });
  assert.equal(moveEffect('Spore', null)!.inflictsStatus, 'slp');
  assert.equal(moveEffect('Spikes', null)!.sideCondition, 'spikes');
  assert.equal(moveEffect('U-turn', null)!.switchesUserOut, true);
  assert.equal(moveEffect('Whirlwind', null)!.forcesTargetSwitch, true);
  assert.equal(moveEffect('Giga Drain', null)!.drainPercentOfDamageDealt, 50);
  assert.equal(moveEffect('Iron Defense', null)!.listedAccuracyPercent, 'cannot-miss');
  assert.equal(moveEffect('Body Press', null)!.listedAccuracyPercent, 100);
  assert.equal(moveEffect('Not A Move', null), null);
});

function features(b: ReturnType<typeof battle>, detail: 'full' | 'reduced' | 'minimal') {
  const request = b.payload(5, b.me().exactHP!.current) as unknown as ChoiceRequest;
  const legalActions: BattleAction[] = ([
    { id: 'move-1', kind: 'move', command: 'move 1', label: 'Body Press', uncertain: false },
    { id: 'move-3', kind: 'move', command: 'move 3', label: 'Rest', uncertain: false },
    { id: 'switch-2', kind: 'switch', command: 'switch 2', label: 'Switch to Dragapult, L78', uncertain: false },
  ]);
  return extractFeatures({ state: b.state, legalActions, request }, detail);
}

test('every action carries a comparable evaluation, including switches and status moves', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  const f = features(b, 'full');
  assert.notEqual(f.speedRelation!.relation, 'unknown', 'the payload no longer reports an unknown speed relation');
  assert.ok(f.incomingThreatIfWeStayIn, 'staying in is priced, not just attacking');
  const [attack, rest, swap] = f.actions as any[];
  assert.ok(attack.damageRange.percentOfMaxHP[1] > 0);
  assert.equal(attack.turnOrder.order, 'theirs-first');
  assert.equal(f.speedRelation!.ifEqualPriority, 'theirs-first');
  assert.equal(rest.damageRange, null);
  assert.equal(rest.effect.healPercentOfMaxHP, 100, 'recovery is visible where a damage range cannot exist');
  assert.equal(swap.switchIn.species, 'Dragapult');
  assert.ok(swap.switchIn.incomingThreat.worstCasePercentOfMaxHP > 0);
  assert.ok(swap.switchIn.ourBestDamageFromNextTurn.bestCasePercentOfMaxHP > 0);
  assert.equal(swap.switchIn.speedRelation.relation, 'faster-than-all-samples');
});

test('reduced detail shrinks the payload without dropping actions or damage', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  const sizes = (['full', 'reduced', 'minimal'] as const).map(d => JSON.stringify(features(b, d)).length);
  assert.ok(sizes[0]! > sizes[1]! && sizes[1]! > sizes[2]!, `sizes decrease: ${sizes.join(' > ')}`);
  for (const detail of ['full', 'reduced', 'minimal'] as const) {
    const f = features(b, detail);
    assert.equal(f.actions.length, 3, 'no detail level ever removes a legal action');
    assert.ok((f.actions[0] as any).damageRange.percentOfMaxHP[1] > 0, 'damage estimates survive every reduction');
    assert.equal(f.glossary.detail, detail);
  }
  assert.ok((features(b, 'minimal').actions[2] as any).switchIn.incomingThreat, 'emergency detail must preserve switch threats');
  assert.ok((features(b, 'reduced').actions[2] as any).switchIn.incomingThreat);
});

test('an itemless role is reported as missing item mass, not as a crash', () => {
  // Jumpluff and Thundurus generate Acrobatics sets, so the published statistics omit `items` for those roles.
  const jumpluff = inferOpponent(battle([bronzong()], 'Jumpluff', 87).foe()).summary.setPriors!;
  assert.deepEqual(jumpluff.items, {}, 'every Jumpluff role is itemless');
  assert.equal(jumpluff.noItemProbability, 1);
  const thundurus = battle([bronzong()], 'Thundurus', 87);
  const priors = inferOpponent(thundurus.foe()).summary.setPriors!;
  assert.ok(Object.keys(priors.items).length > 0, 'some Thundurus roles do carry an item');
  const listed = Object.values(priors.items).reduce((n, v) => n + v, 0);
  assert.ok(listed < 1 && Math.abs(listed + priors.noItemProbability - 1) < 0.01, 'the missing mass is stated, not implied away');
  for (const b of [battle([bronzong()], 'Jumpluff', 87), thundurus]) {
    assert.ok(JSON.stringify(features(b, 'full')).length > 0, 'features are produced rather than thrown');
  }
  // A species with an item on every role still sums to one.
  assert.equal(inferOpponent(battle([bronzong()], 'Azumarill').foe()).summary.setPriors!.noItemProbability, 0);
});

test('a Substitute is reported per move, by what it actually absorbs', () => {
  const b = battle([ours('Misdreavus', 90, ['Will-O-Wisp', 'Shadow Ball', 'Calm Mind', 'Psychic Noise'], 'Levitate', 'Eviolite', 'Fairy')], 'Regigigas', 78);
  const me = b.me(), foe = b.foe();
  assert.equal(substituteInteraction('Will-O-Wisp', me, foe), null, 'no Substitute, nothing to report');
  b.feed('|-start|p2a: Foe|Substitute');
  assert.equal(substituteInteraction('Will-O-Wisp', me, foe)!.effect, 'absorbed-entirely', 'a status move accomplishes nothing');
  assert.equal(substituteInteraction('Shadow Ball', me, foe)!.effect, 'damages-substitute-first');
  assert.equal(substituteInteraction('Psychic Noise', me, foe)!.effect, 'bypasses-substitute', 'sound moves carry the bypass flag');
  assert.equal(substituteInteraction('Taunt', me, foe)!.effect, 'bypasses-substitute');
  assert.equal(substituteInteraction('Calm Mind', me, foe), null, 'a move aimed at ourselves is unaffected');
  me.ability = 'Infiltrator';
  const bypassed = substituteInteraction('Will-O-Wisp', me, foe)!;
  assert.equal(bypassed.effect, 'bypasses-substitute', 'Infiltrator ignores it');
  assert.equal('why' in bypassed ? bypassed.why : null, 'Infiltrator', 'and the cause is named');
});

test('a Substitute preserves turn order and reports damage to the shield', () => {
  const b = battle([ours('Gyarados', 79, ['Waterfall', 'Dragon Dance'], 'Intimidate', 'Leftovers', 'Flying')], 'Regigigas', 78);
  const before = speedSummary(b.state);
  assert.notEqual(before.relation, 'unknown');
  b.feed('|-start|p2a: Foe|Substitute');
  const after = speedSummary(b.state);
  assert.equal(after.relation, before.relation, 'Substitute changes no speeds, so the relation is unchanged');
  assert.deepEqual(after.opponentRange, before.opponentRange);
  // Damage still declines, but now it says so rather than looking like safety.
  const f = extractFeatures({ state: b.state, request: b.payload(5, b.me().exactHP!.current) as unknown as ChoiceRequest,
    legalActions: [{ id: 'move-1', kind: 'move', command: 'move 1', label: 'Waterfall', uncertain: false }] }, 'full');
  assert.equal(f.estimatesUnavailable, null);
  assert.deepEqual((f.actions[0] as any).damageRange.hp, [0, 0]);
  assert.ok((f.actions[0] as any).damageRange.substituteDamage);
  assert.equal((f.actions[0] as any).damageUnavailable, undefined, 'a state-wide cause is stated once, not per action');
  assert.notEqual(f.speedRelation!.relation, 'unknown', 'turn order survives');
});

test('Slow Start halves speed only while its volatile is up', () => {
  const b = battle([ours('Misdreavus', 90, ['Shadow Ball'], 'Levitate', 'Eviolite', 'Fairy')], 'Regigigas', 78);
  const full = speedSummary(b.state).opponentRange![0]!;
  b.feed('|-start|p2a: Foe|Slow Start');
  const slowed = speedSummary(b.state).opponentRange![0]!;
  assert.equal(slowed, Math.floor(full / 2), 'the halving is applied while the volatile is present');
  b.feed('|-end|p2a: Foe|Slow Start');
  assert.equal(speedSummary(b.state).opponentRange![0], full, 'and dropped once it expires');
});

test('candidate sets carry real joint frequencies that sum to one before any evidence', () => {
  const b = battle([bronzong()], 'Azumarill');
  const all = inferOpponent(b.foe());
  const mass = all.candidates.reduce((n, c) => n + c.probability, 0);
  assert.ok(Math.abs(mass - 1) < 0.01, `a fresh Pokemon's sets cover the whole distribution, got ${mass}`);
  assert.equal(all.summary.candidateProbabilityMassBeforeEvidence, 1);
  assert.ok(all.summary.mostLikelyCandidates.length > 0);
  const renormalised = all.summary.mostLikelyCandidates.reduce((n, c) => n + c.probability, 0);
  assert.ok(renormalised > 0 && renormalised <= 1.001);
  // A revealed move narrows the pool, and the remaining mass reports how much of it survived.
  b.foe().revealedMoves = ['Belly Drum'];
  const narrowed = inferOpponent(b.foe());
  assert.ok(narrowed.candidates.length < all.candidates.length);
  const left = narrowed.summary.candidateProbabilityMassBeforeEvidence;
  assert.ok(left > 0 && left < 1, `Belly Drum sets are a minority of the distribution, got ${left}`);
  assert.ok(narrowed.candidates.every(c => c.moves.includes('bellydrum')));
});

test('merging sets for the calculator sums their probability', () => {
  const b = battle([bronzong()], 'Azumarill');
  const raw = inferOpponent(b.foe()).candidates;
  const merged = dedupeCandidates(raw);
  assert.ok(merged.length < raw.length, 'several joint sets share one defensive profile');
  const before = raw.reduce((n, c) => n + c.probability, 0);
  const after = merged.reduce((n, c) => n + c.probability, 0);
  assert.ok(Math.abs(before - after) < 1e-6, `mass is preserved: ${before} vs ${after}`);
});

test('a KO reports how much of the distribution it kills, and only when sets disagree', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  // At full HP nothing KOs, so the label alone says it and no probability is emitted.
  const safe = incomingThreats(b.state, b.me(), 'p1')!;
  assert.equal(safe.conditionalKO, 'none-sampled');
  assert.equal(safe.damagingMoves[0]!.koProbability, undefined, 'a unanimous verdict needs no probability');
  // At 12 HP every set kills regardless of the roll, which the label also says on its own.
  b.feed(b.request(3, 12));
  const doomed = incomingThreats(b.state, b.me(), 'p1')!;
  assert.equal(doomed.conditionalKO, 'all-sampled-rolls');
  assert.equal(doomed.damagingMoves[0]!.koProbability, undefined);
  // In between, Choice Band sets kill and Sitrus Berry sets do not, so the mass is what matters.
  b.feed(b.request(5, 100));
  const split = incomingThreats(b.state, b.me(), 'p1')!;
  const liquidation = split.damagingMoves.find(m => m.move === 'Liquidation')!;
  assert.equal(liquidation.conditionalKO, 'some-sampled-rolls');
  assert.ok(liquidation.koProbability, 'a split verdict reports the probability mass');
  const { regardlessOfRoll, onSomeRoll } = liquidation.koProbability!;
  assert.ok(regardlessOfRoll > 0 && regardlessOfRoll < 1, `partial mass, got ${regardlessOfRoll}`);
  assert.ok(onSomeRoll >= regardlessOfRoll, 'killing on some roll is at least as likely as killing on every roll');
});

test('a forced switch says staying in is not on offer, so its nulls cannot read as safety', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  const healthy = b.payload(7, b.me().exactHP!.current) as unknown as ChoiceRequest;
  const switchOnly: BattleAction[] = [{ id: 'switch-2', kind: 'switch', command: 'switch 2', label: 'Switch to Dragapult, L78', uncertain: false }];
  // While our Pokémon is alive and acting, staying in is priced and the relation is real.
  const alive = extractFeatures({ state: b.state, request: healthy, legalActions: switchOnly }, 'full');
  assert.equal(alive.stayingInIsNotAnOption, null);
  assert.ok(alive.incomingThreatIfWeStayIn, 'the cost of staying is stated');
  assert.notEqual(alive.speedRelation, null);
  // After a faint the active slot still holds the fainted Pokémon, so both go null with a reason beside them.
  b.feed('|-damage|p1a: Bronzong|0 fnt');
  b.feed('|faint|p1a: Bronzong');
  const forced = extractFeatures({ state: b.state, request: { ...healthy, forceSwitch: [true] }, legalActions: switchOnly }, 'full');
  assert.match(forced.stayingInIsNotAnOption!, /Bronzong has fainted/);
  assert.match(forced.stayingInIsNotAnOption!, /none of them costs a turn/);
  assert.equal(forced.speedRelation, null, 'a relation computed from a fainted Pokemon would be meaningless');
  assert.equal(forced.incomingThreatIfWeStayIn, null);
  assert.equal(forced.turnsOurActiveHasBeenIn, null);
  assert.equal(forced.ourActiveJustSwitchedIn, false);
  // The per-switch matchup still carries real numbers, which is what the choice should turn on.
  const target = forced.actions[0] as any;
  assert.ok(target.switchIn.incomingThreat, 'the replacement is still evaluated');
  assert.ok(target.switchIn.ourBestDamageFromNextTurn);
  assert.notEqual(target.switchIn.speedRelation.relation, 'unknown');
});

test('undoing a switch has a visible cost', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  const request = b.payload(7, b.me().exactHP!.current) as unknown as ChoiceRequest;
  const actions: BattleAction[] = [{ id: 'move-1', kind: 'move', command: 'move 1', label: 'Body Press', uncertain: false }];
  const settled = extractFeatures({ state: b.state, request, legalActions: actions }, 'full');
  assert.equal(settled.ourActiveJustSwitchedIn, true, 'the lead has only just arrived');
  b.feed('|turn|2');
  b.feed('|turn|3');
  const later = extractFeatures({ state: b.state, request, legalActions: actions }, 'full');
  assert.equal(later.turnsOurActiveHasBeenIn, 3);
  assert.equal(later.ourActiveJustSwitchedIn, false);
  // A fresh switch resets it, so switching straight back out is visibly undoing the last move.
  b.feed('|switch|p1a: Dragapult|Dragapult, L78, M|265/265');
  const swapped = extractFeatures({ state: b.state, request, legalActions: actions }, 'full');
  assert.equal(swapped.turnsOurActiveHasBeenIn, 1);
  assert.equal(swapped.ourActiveJustSwitchedIn, true);
  // A state that never recorded an entry turn — a reconnect, or an older log — reads as unknown, not NaN.
  delete (b.me() as { activeSinceTurn?: number | null }).activeSinceTurn;
  const unknown = extractFeatures({ state: b.state, request, legalActions: actions }, 'full');
  assert.equal(unknown.turnsOurActiveHasBeenIn, null);
  assert.equal(unknown.ourActiveJustSwitchedIn, false);
});

test('the glossary describes what the payload contains, and compacts below full detail', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  const request = b.payload(9, b.me().exactHP!.current) as unknown as ChoiceRequest;
  const moveOnly: BattleAction[] = [{ id: 'move-1', kind: 'move', command: 'move 1', label: 'Body Press', uncertain: false }];
  const withSwitch: BattleAction[] = [...moveOnly, { id: 'switch-2', kind: 'switch', command: 'switch 2', label: 'Switch to Dragapult, L78', uncertain: false }];
  const noSwitches = extractFeatures({ state: b.state, request, legalActions: moveOnly }, 'full').glossary as Record<string, string>;
  assert.equal(noSwitches.switching, undefined, 'nothing to say about switching when none is offered');
  assert.ok(noSwitches.damage, 'what is present is still explained');
  const switching = extractFeatures({ state: b.state, request, legalActions: withSwitch }, 'full').glossary as Record<string, string>;
  assert.ok(switching.switching, 'offering a switch brings its definition with it');
  assert.match(switching.switching!, /forfeits this turn/);
  // Below full detail the caveats that change how a number is read survive; the rest goes.
  for (const detail of ['reduced', 'minimal'] as const) {
    const g = extractFeatures({ state: b.state, request, legalActions: withSwitch }, detail).glossary as Record<string, string>;
    assert.equal(g.detail, detail);
    assert.ok(g.essential, detail);
    for (const phrase of ['noncritical single hit', 'never what the opponent will choose',
      'never that there is no danger', 'forfeits this turn', 'not exhaustive']) {
      assert.ok(g.essential!.includes(phrase), `${detail} keeps: ${phrase}`);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(g)) < Buffer.byteLength(JSON.stringify(switching)) / 2,
      `${detail} glossary is materially smaller`);
  }
});
