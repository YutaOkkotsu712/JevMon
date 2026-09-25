import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { protectMoves } from '../battle/BattleTracker.js';
import { dex, id } from '../pokemon/data.js';
import { residuals } from './residual.js';
import { incomingThreats } from './threat.js';
import { inferOpponent } from './inference.js';
import { plausibleMoves } from './setPriors.js';
import { sampled } from './sampled.js';

/** Random battles generate moves with full PP Ups, so a move's usable PP is eight fifths of its base. */
const maxPP = (basePP: number) => Math.floor(basePP * 8 / 5);
const abilityOf = (p: PokemonState) => (p.abilitySuppressed ? '' : id(p.ability));

/**
 * What is left of the opposing Pokémon's revealed moves, counted from the times each has been seen used.
 * A move called by another spends no PP and is not counted, but turns we did not see are not counted either,
 * so these are upper bounds on what remains. Full PP Ups are assumed, which is how random battles generate.
 */
export function opponentPP(s: BattleState, foe: PokemonState, ourActive: PokemonState | undefined) {
  // A state rebuilt before these counts existed, or by a reconnect, reads as nothing seen rather than failing.
  const uses = foe.moveUses ?? {};
  // Pressure makes every move aimed at us cost two, which is what makes stalling one out realistic.
  const pressure = !!ourActive && abilityOf(ourActive) === 'pressure';
  const moves = foe.revealedMoves.map(name => {
    const move = dex.moves.get(name);
    if (!move.exists || !move.pp) return null;
    const max = maxPP(move.pp);
    const seen = uses[move.id] ?? 0;
    // Counted at each use where the log has it; older states fall back to our current Pokémon's Pressure.
    const spent = foe.ppSpent?.[move.id] ?? seen * (pressure && move.target !== 'self' ? 2 : 1);
    return { move: move.name, timesSeenUsed: seen, assumedMaxPP: max, atMostRemaining: Math.max(0, max - spent) };
  }).filter((m): m is NonNullable<typeof m> => m !== null);
  if (!moves.length) return null;
  const exhausted = moves.filter(m => m.atMostRemaining === 0).map(m => m.move);
  return { moves, ...(pressure ? { ourPressureDoublesTheirCost: true } : {}),
    ...(exhausted.length ? { possiblyOutOfPP: exhausted } : {}) };
}

/**
 * Protecting spends a turn to take no damage, which only gains ground when the end-of-turn balance favours
 * us. Consecutive use is the catch: the first protect always works, and each one after it is three times
 * likelier to fail. Feint, Shadow Force and a few others go through regardless, and the opponent still
 * spends the PP of whatever it was blocked doing, which is what makes stalling a move out possible.
 */
/**
 * Weakened turns left on a Slow Start, which halves Attack and Speed for five turns from entry. Regigigas carries
 * Protect and Substitute to spend those turns safely; against theirs, every turn we do not press is one it gets back.
 */
export function slowStartTurnsLeft(s: BattleState, p: PokemonState | undefined) {
  const entry = p && Object.entries(p.volatiles).find(([k]) => id(k) === 'slowstart')?.[1];
  return entry ? Math.max(1, entry.sinceTurn + 5 - s.turn) : null;
}

export function protectOutlook(s: BattleState, moveName: string, side: SideId, me: PokemonState, foe: PokemonState | undefined) {
  const move = dex.moves.get(moveName);
  if (!move.exists || !protectMoves.has(move.id)) return null;
  const already = me.consecutiveProtects ?? 0;
  const ours = residuals(s, me, side)?.perTurnPercentOfMaxHP;
  const theirs = foe && residuals(s, foe, side === 'p1' ? 'p2' : 'p1')?.perTurnPercentOfMaxHP;
  const low = (v: number | number[] | undefined) => (Array.isArray(v) ? v[0]! : v);
  const high = (v: number | number[] | undefined) => (Array.isArray(v) ? v[1]! : v);
  // Worst case for us: we heal the least we might, they heal the most they might.
  const swing = ours === undefined || theirs === undefined ? null : Math.round((low(ours)! - high(theirs)!) * 10) / 10;
  const wish = s.sides[side].slotConditions.wish;
  const usefulReasons: string[] = [];
  if (!['protect', 'detect'].includes(move.id)) usefulReasons.push('additional protection effect such as contact punishment or Endure');
  if (wish && wish.setOnTurn + 1 >= s.turn) usefulReasons.push('pending Wish');
  if (low(ours) !== undefined && low(ours)! > 0 && (me.hpPercent ?? 100) < 100) usefulReasons.push('passive healing');
  if (high(theirs) !== undefined && high(theirs)! < 0) usefulReasons.push('opposing residual damage');
  // A timer can make the next turn materially different even without an HP swing.
  if (s.field.weather || s.field.terrain || s.field.trickRoom ||
      Object.values(s.sides).some(x => Object.keys(x.conditions).length)) usefulReasons.push('field or side-condition timer');
  if ([me, foe].some(p => p && (p.status === 'slp' || Object.keys(p.volatiles).some(k =>
      /^(perish[0-3]|perishsong|yawn|encore|taunt|disable|healblock|throatchop)$/.test(id(k)))))) usefulReasons.push('status or volatile timer');
  if (!me.status && ['flameorb', 'toxicorb'].includes(id(me.item))) usefulReasons.push('status Orb activation');
  if (foe && opponentPP(s, foe, me)?.moves.some(m => m.atMostRemaining === 1)) usefulReasons.push('possible last opposing PP');
  // A protected turn is one of our Slow Start's five spent safely: it is what Regigigas carries Protect for.
  const ourSlowStart = slowStartTurnsLeft(s, me), theirSlowStart = slowStartTurnsLeft(s, foe);
  if (ourSlowStart) usefulReasons.push(`runs down our Slow Start: ${ourSlowStart} weakened turn${ourSlowStart === 1 ? '' : 's'} left`);
  // Unseen Fist strips the protect flag from contact moves, so Protect and every variant of it let them through.
  const fist = foe ? sampled(foe, 'abilities', ['unseenfist'])[0] : undefined;
  const through = fist ? plausibleMoves(foe!).filter(m => { const d = dex.moves.get(m.move); return d.category !== 'Status' && d.flags.contact; }) : [];
  return {
    ...(fist && through.length ? { theirContactMovesGoThrough: { ability: fist.name, probability: fist.probability,
      moves: through.map(m => m.move).slice(0, 6),
      stillBlocked: plausibleMoves(foe!).filter(m => { const d = dex.moves.get(m.move); return d.category !== 'Status' && !d.flags.contact; }).map(m => m.move).slice(0, 4) } } : {}),
    ...(usefulReasons.length ? { possiblePayoffs: usefulReasons } : {}),
    // Theirs is the reverse: a turn we protect is a weakened turn of theirs gone for nothing.
    ...(theirSlowStart ? { spendsTheirSlowStart: `their Slow Start has ${theirSlowStart} weakened turn${theirSlowStart === 1 ? '' : 's'} left, and protecting gives one away` } : {}),
    noIdentifiedPayoff: swing !== null && swing <= 0 && !usefulReasons.length,
    consecutiveProtectsAlready: already,
    successChance: Math.round(1 / 3 ** already * 1000) / 1000,
    endOfTurnSwingPercentOfMaxHP: swing,
    gainsGroundIfItWorks: swing === null ? null : swing > 0,
    opponentStillSpendsPPOnTheBlockedMove: true,
  };
}

const choiceItems = ['choiceband', 'choicespecs', 'choicescarf'];
/**
 * A Choice item locks its holder into the move it last used until it switches. That is the most exploitable
 * read available from public information alone: the opponent's next action is known, so an immunity or a
 * setup turn is free. The item is usually not known outright, so the probability comes from the candidate
 * sets still compatible, and a Pokémon that has not moved yet is not locked into anything.
 */
export function choiceLock(foe: PokemonState) {
  // Outrage and its kind lock just as surely for two or three turns: after the first, the next move is certain;
  // after the second, even odds; then the user is confused. No item is involved, so this comes first.
  if (foe.rampage && foe.rampage.turns < 3) {
    return { lockedInto: foe.rampage.move, certainty: 'rampage' as const, probability: foe.rampage.turns === 1 ? 1 : 0.5,
      sameMoveStreak: foe.rampage.turns, thenConfused: true };
  }
  const move = foe.lastMoveUsed;
  // A transformed Pokémon keeps its own item, and its last move is only recorded once it has moved in the new form.
  if (!move) return null;
  const known = foe.item !== null;
  if (known && !choiceItems.includes(id(foe.item))) return null;
  if (known) {
    return { lockedInto: move, certainty: 'item-is-known' as const, probability: 1,
      sameMoveStreak: foe.sameMoveStreak ?? 0 };
  }
  const candidates = inferOpponent(foe).candidates;
  const mass = candidates.reduce((n, c) => n + c.probability, 0);
  const choiced = candidates.filter(c => choiceItems.includes(id(c.item)));
  if (!choiced.length || mass <= 0) return null;
  const probability = Math.round(choiced.reduce((n, c) => n + c.probability, 0) / mass * 1000) / 1000;
  return { lockedInto: move, certainty: 'from-candidate-items' as const, probability,
    sameMoveStreak: foe.sameMoveStreak ?? 0,
    items: [...new Set(choiced.map(c => c.item))] };
}

/** Whether public restrictions still allow a previously revealed recovery move this turn. */
export function canUseRecoveryNow(foe: PokemonState, moveName: string) {
  if (Object.keys(foe.volatiles).some(k => ['taunt', 'healblock', 'mustrecharge'].includes(id(k)))) return false;
  if (Object.keys(foe.volatiles).some(k => id(k) === 'encore') && id(foe.lastMoveUsed) !== id(moveName)) return false;
  const lock = choiceLock(foe);
  return !lock || lock.probability < 1 || id(lock.lockedInto) === id(moveName);
}

/**
 * Recovery that has been set but not yet landed. A Wish heals whoever holds the slot when it resolves, so
 * it can be passed to a switch-in rather than spent on its caster; a Healing Wish or Lunar Dance restores
 * whatever comes in after its user faints. Both are invisible from the move list alone once they are set.
 */
export function pendingRecovery(s: BattleState, side: SideId) {
  const ours = s.sides[side];
  // A Wish lands at the end of the turn after it is used; one that healed a full-HP Pokémon leaves no message to clear it.
  const wish = ours.slotConditions?.wish && s.turn <= ours.slotConditions.wish.setOnTurn + 1 ? ours.slotConditions.wish : undefined;
  const healing = ours.slotConditions?.healingWish;
  if (!wish && !healing) return null;
  return {
    ...(wish ? { wish: { healsHP: wish.healsHP, ...(wish.healsHP === null ? { healsHalfOfTheSettersMaxHP: true } : {}), setBy: wish.from,
      landsAtEndOfTurn: wish.setOnTurn + 1,
      alreadyDue: s.turn > wish.setOnTurn,
      goesToWhoeverHoldsTheSlot: true } } : {}),
    ...(healing ? { fullRestoreWaiting: { move: healing.move, setBy: healing.from,
      appliesToWhicheverPokemonComesInNext: true } } : {}),
  };
}

/** What a delayed-recovery move would set up, said at the point of choosing it. */
export function delayedRecoveryMove(moveName: string, me: PokemonState) {
  const move = dex.moves.get(moveName);
  if (!move.exists) return null;
  if (move.id === 'wish') {
    const heals = me.exactHP ? Math.floor(me.exactHP.max / 2) : null;
    return { landsAtEndOfNextTurn: true, ...(heals === null ? {} : { healsHP: heals }),
      healsHalfOfTheCastersMaxHP: true,
      canBePassed: 'whoever holds this slot when it lands is healed, so switching after it keeps the healing' };
  }
  if (move.id === 'healingwish' || move.id === 'lunardance') {
    return { theUserFaints: true, fullyRestoresTheNextPokemonIn: true,
      ...(move.id === 'lunardance' ? { alsoRestoresPP: true } : {}) };
  }
  return null;
}

/**
 * What a Substitute actually buys, which the move list reduces to "creates a volatile". It costs health up
 * front, and the whole question is whether the shell survives what is coming: one that breaks immediately
 * has spent the health for a single blocked hit, while one that holds blocks status and stat changes
 * outright for as long as it stands. Shed Tail is the same trade at double the price, and hands the shell
 * to whatever comes in — which is the point of it, and is invisible from `switchesUserOut` alone.
 */
export function substitutePlan(s: BattleState, me: PokemonState, side: SideId, moveName: string) {
  const move = dex.moves.get(moveName);
  const shed = move.id === 'shedtail';
  if (!move.exists || (move.id !== 'substitute' && !shed)) return null;
  const max = me.exactHP?.max;
  if (!max) return null;
  const costPercent = shed ? 50 : 25;
  const shellHP = Math.floor(max / 4);
  const threat = incomingThreats(s, me, side, 1);
  const worstPercent = threat?.worstCasePercentOfMaxHP ?? null;
  const worstHP = worstPercent === null ? null : Math.ceil(worstPercent / 100 * max);
  return {
    substituteHP: shellHP,
    costsPercentOfMaxHP: costPercent,
    leavesUsAtPercentOfMaxHP: Math.max(0, Math.round(((me.hpPercent ?? 100) - costPercent) * 10) / 10),
    ...(worstHP === null ? {} : {
      theirBestSampledHitDeals: worstHP,
      shellSurvivesThatHit: worstHP < shellHP,
    }),
    blocksStatusAndStatChangesWhileItStands: true,
    ...(slowStartTurnsLeft(s, me) ? { runsDownOurSlowStart: slowStartTurnsLeft(s, me) } : {}),
    ...(shed ? { passedToThePokemonComingIn: true,
      why: 'the Pokémon switching in arrives already behind the shell, which is what makes it a setup move rather than a pivot' } : {}),
  };
}

/**
 * What the current pairing has actually done since it met: each side's HP change, and whether they have held their
 * ground while we lost ours. That shows a stall the per-turn numbers hide — their Roost, Leftovers, Rest or boosts, or
 * our lost turns, outpacing our damage turn after turn.
 */
export function matchupProgress(s: BattleState, me: PokemonState, foe: PokemonState) {
  const met = s.matchup, ourSide = s.mySide;
  if (!met || !ourSide) return null;
  const theirSide = ourSide === 'p1' ? 'p2' : 'p1';
  if (met[ourSide] !== me.id || met[theirSide] !== foe.id || s.turn - met.sinceTurn < 3) return null;
  const ourWas = met[`${ourSide}HP`], theirWas = met[`${theirSide}HP`];
  const ours = ourWas === null || me.hpPercent === null ? null : Math.round(me.hpPercent - ourWas);
  const theirs = theirWas === null || foe.hpPercent === null ? null : Math.round(foe.hpPercent - theirWas);
  return { turns: s.turn - met.sinceTurn, ourHPChange: ours, theirHPChange: theirs,
    ...(ours !== null && theirs !== null && theirs >= -5 && ours <= -10 ? { theyAreNotLosingGround: true } : {}) };
}
