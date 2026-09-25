import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { buildPokemon, dedupeCandidates, hpInterval, scenario } from './calcCore.js';
import { inferOpponent } from './inference.js';
import { plausibleMoves } from './setPriors.js';
import { incomingThreats } from './threat.js';
import { dex, id } from '../pokemon/data.js';
import { pokemonTypes } from '../pokemon/mechanics.js';

const pair = (lo: number, hi: number): [number, number] => [Math.max(0, Math.round(lo)), Math.max(0, Math.round(hi))];
const percent = (hp: [number, number], max: number): [number, number] =>
  [Math.round(hp[0] / max * 1000) / 10, Math.round(hp[1] / max * 1000) / 10];

/** Their max HP over the surviving sets, which these moves need and the ordinary damage path never exposes. */
function theirMaxHP(foe: PokemonState): [number, number] | null {
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  const values: number[] = [];
  for (const c of sets.length ? sets : [undefined]) {
    try { values.push(buildPokemon(foe, c).maxHP()); } catch { /* an unbuildable set says nothing */ }
  }
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

/**
 * Moves whose damage is not a function of stats at all, and which the calculator therefore reports as zero
 * or refuses outright. Each one is real damage behind a condition, so the condition is stated with the
 * number rather than the move being dropped: a Counter that connects is often the biggest hit available,
 * and one that does not is a wasted turn at priority -5.
 */
export function conditionalDamage(s: BattleState, me: PokemonState, side: SideId, moveName: string) {
  const move = dex.moves.get(moveName);
  const key = move.exists ? move.id : '';
  if (!['counter', 'mirrorcoat', 'painsplit'].includes(key)) return null;
  const theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  const ourMax = me.exactHP?.max;
  if (!foe || foe.fainted || !ourMax) return null;
  const foeMax = theirMaxHP(foe);
  if (!foeMax) return null;

  if (key === 'painsplit') {
    const ourHP = me.exactHP!.current;
    // Their HP is an interval, so both halves of the split are too.
    const lo = hpInterval(foe, foeMax[0])[0], hi = hpInterval(foe, foeMax[1])[1];
    // The average is capped by each side's own max HP, so splitting with a bigger Pokémon is not free healing.
    const cap = (v: number) => Math.min(ourMax, Math.floor(v));
    const after = pair(cap((ourHP + lo) / 2), cap((ourHP + hi) / 2));
    return { move: move.name,
      condition: 'both Pokémon end on the average of their current HP, so it is a heal only while we are the lower of the two',
      ourHPBefore: ourHP, ourHPAfterHP: after, ourHPAfterPercentOfMaxHP: percent(after, ourMax),
      weGainHP: pair(after[0] - ourHP, after[1] - ourHP),
      theyLoseHP: pair(lo - Math.min(foeMax[0], after[1]), hi - Math.min(foeMax[1], after[0])),
      worthlessIfWeAreTheHealthierOne: after[1] <= ourHP };
  }

  // Counter and Mirror Coat return twice the damage of the hit they absorb, and only that hit.
  const physical = key === 'counter';
  const threat = incomingThreats(s, me, side, 8);
  const matching = (threat?.damagingMoves ?? []).filter(m => dex.moves.get(m.move).category === (physical ? 'Physical' : 'Special'));
  if (!matching.length) {
    return { move: move.name, condition: `returns twice the ${physical ? 'physical' : 'special'} damage taken this turn`,
      noSampledMoveOfThatKind: true,
      why: `no sampled move of ${foe.species} is ${physical ? 'physical' : 'special'}, so this has nothing to return and fails` };
  }
  const best = matching.reduce((a, b) => (b.percentOfMaxHP[1] > a.percentOfMaxHP[1] ? b : a));
  const takenHP = pair(best.percentOfMaxHP[0] / 100 * ourMax, best.percentOfMaxHP[1] / 100 * ourMax);
  const returned = pair(takenHP[0] * 2, takenHP[1] * 2);
  const chance = matching.reduce((n, m) => n + (m.priorProbability ?? 0), 0);
  return { move: move.name,
    condition: `returns twice the ${physical ? 'physical' : 'special'} damage taken this turn, at priority -5, and fails outright if that hit does not land or knocks us out first`,
    againstTheirBest: best.move, wouldReturnHP: returned,
    percentOfTheirMaxHP: [percent(returned, foeMax[1])[0], percent(returned, foeMax[0])[1]] as [number, number],
    theirSampledMovesOfThatKind: matching.length,
    sampledProbabilityTheyUseOneOfThose: Math.min(1, Math.round(chance * 1000) / 1000),
    notAPredictionOfTheirChoice: true };
}

/**
 * Sucker Punch hits at +1 priority for full damage, but only if the target attacks this turn. Its damage is
 * ordinary and now goes through the normal path; what needs saying is the condition, and how much of the
 * target's sampled movepool is an attack at all — a set that is mostly status is a set this misses.
 */
export function suckerOutlook(s: BattleState, side: SideId, moveName: string) {
  // Thunderclap is Sucker Punch's Electric twin: the same priority, and the same failure against anything but an attack.
  if (!['suckerpunch', 'thunderclap'].includes(id(moveName))) return null;
  const theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!foe || foe.fainted) return null;
  const moves = plausibleMoves(foe);
  if (!moves.length) return null;
  const damaging = moves.filter(m => dex.moves.get(m.move).category !== 'Status');
  const mass = moves.reduce((n, m) => n + (m.priorProbability ?? 0), 0);
  const hit = damaging.reduce((n, m) => n + (m.priorProbability ?? 0), 0);
  return {
    failsUnless: 'the target uses a damaging move this turn; a status move, a switch, or the target already having moved all make it fail',
    theirSampledDamagingMoves: damaging.map(m => m.move).slice(0, 6),
    theirSampledStatusMoves: moves.filter(m => dex.moves.get(m.move).category === 'Status').map(m => m.move).slice(0, 4),
    shareOfTheirSampledMovesThatAreAttacks: mass > 0 ? Math.round(hit / mass * 1000) / 1000 : null,
    notAPredictionOfTheirChoice: true,
  };
}

/**
 * Salt Cure's hit is small; its point is what follows. Every end of turn until the target switches it loses an eighth
 * of its max HP, a quarter for Water and Steel types, and no Special Defense boost, recovery move or Rest removes it.
 * Garganacl was the answer to a Calm Mind, Rest and Sleep Talk Suicune, and the payload priced it as a 10% hit.
 */
export function saltCureOutlook(foe: PokemonState | undefined) {
  if (!foe || foe.fainted) return null;
  if (Object.keys(foe.volatiles).some(k => id(k) === 'saltcure')) return { alreadySaltCured: true };
  if (!foe.abilitySuppressed && id(foe.ability) === 'magicguard') return { magicGuardBlocksTheChip: true };
  const heavy = pokemonTypes(foe).some(t => t === 'Water' || t === 'Steel');
  return { thenEachTurnPercentOfTheirMaxHP: heavy ? 25 : 12.5, untilTheySwitch: true, noBoostRecoveryOrRestRemovesIt: true };
}

/** Gen 9 Encore runs for three turns including the one it lands on. */
const ENCORE_TURNS = 3;
/** Moves that cannot be Encored at all, so the move simply fails against a target whose last one was these. */
const unEncorable = new Set(['encore', 'struggle', 'transform', 'mimic', 'sketch', 'mirrormove', 'sleeptalk']);

/**
 * Being Encored is a trap with exactly one exit. The legal action set collapses to the locked move and the
 * switches, which on its own reads as an ordinary short turn rather than as a Pokémon that has lost control
 * of its own moves — Garganacl spent four turns Protecting into a Comfey because nothing said so.
 */
export function encoreLock(s: BattleState, me: PokemonState, side: SideId) {
  const entry = Object.entries(me.volatiles).find(([k]) => id(k) === 'encore');
  if (!entry) return null;
  const since = entry[1].sinceTurn;
  const elapsed = Number.isFinite(since) ? Math.max(0, s.turn - since) : null;
  const locked = me.lastMoveUsed;
  const move = locked ? dex.moves.get(locked) : null;
  const threat = incomingThreats(s, me, side, 1);
  return {
    lockedInto: move?.exists ? move.name : locked,
    ...(elapsed === null ? {} : { turnsItHasRun: elapsed + 1, atMostThisManyMoreTurns: Math.max(0, ENCORE_TURNS - elapsed - 1) }),
    theOnlyWayOutIsSwitching: true,
    why: 'Encore replaces every other move until it ends; the moves missing from this turn are not choices we can make',
    ...(move?.exists ? { lockedMoveDealsDamage: move.category !== 'Status' } : {}),
    ...(threat?.worstCasePercentOfMaxHP === null || threat === null ? {} : {
      worstIncomingPerTurnPercentOfMaxHP: threat.worstCasePercentOfMaxHP,
      knockedOutIfWeStay: threat.conditionalKO === 'all-sampled-rolls' }),
  };
}

/**
 * Encore used by us is three turns of the opponent doing whatever it just did. That is enormous when it just
 * used a status move or something we are immune to, and close to useless when it just attacked, so the move
 * it would lock in is the whole decision.
 */
export function encorePlan(s: BattleState, me: PokemonState, side: SideId, moveName: string) {
  if (id(moveName) !== 'encore') return null;
  const theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!foe || foe.fainted) return null;
  const last = foe.lastMoveUsed;
  if (!last) return { failsBecause: `${foe.species} has not used a move yet, so there is nothing to lock in` };
  const move = dex.moves.get(last);
  if (!move.exists) return null;
  if (unEncorable.has(move.id)) return { failsBecause: `${move.name} cannot be Encored, so this fails` };
  if (Object.keys(foe.volatiles).some(k => id(k) === 'encore')) return { failsBecause: `${foe.species} is already Encored` };
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  // What it would be doing to us for those turns, which is the whole value of locking it in.
  let worst = 0;
  if (move.category !== 'Status') {
    for (const set of sets.length ? sets : [undefined]) {
      const r = scenario(s, foe, me, side === 'p1' ? 'p2' : 'p1', move.name, set);
      if (r) worst = Math.max(worst, r.max / Math.max(1, r.defenderMaxHP) * 100);
    }
  }
  return {
    wouldLockThemInto: move.name, forUpToTurns: ENCORE_TURNS,
    thatMoveIsA: move.category === 'Status' ? 'status move' : `${move.category.toLowerCase()} attack`,
    ...(move.category === 'Status'
      ? { theyDealNoDamageWhileItHolds: true }
      : { itWouldKeepDealingPercentOfOurMaxHP: Math.round(worst * 10) / 10 }),
    itBypassesASubstitute: true,
    reflectedByMagicBounce: true,
  };
}
