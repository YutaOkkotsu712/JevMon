import { afterTerastallizing } from './forme.js';
import { damageRange } from './damage.js';
import { residuals } from './residual.js';
import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { incomingThreats, outgoingBest } from './threat.js';
import { speedSummary, turnOrder } from './speed.js';
import { boostedStat, selfStageChanges } from '../pokemon/mechanics.js';
import { ignoresBoosts, breaksMoulds } from './abilities.js';
import { inferOpponent } from './inference.js';
import { benchSpeed } from './benchSpeed.js';

const clone = (p: PokemonState, changes: Partial<PokemonState>): PokemonState => ({ ...structuredClone(p), ...changes });
const worst = (v: number | number[] | null | undefined) => (Array.isArray(v) ? v[1]! : v ?? null);

/**
 * What a move's own stat change buys, rather than only what it moves. The randbats win condition is a
 * Pokémon that sets up and then outruns and removes what is left, so the question worth answering is whether
 * these stages produce that — and the same projection shows what a self-lowering move costs the next hit.
 * Evaluated against the opponent currently on the field, one step deep, with no account of what the
 * opponent does in the meantime.
 */
export function setupProjection(s: BattleState, me: PokemonState, side: SideId, boosts: Record<string, number>,
  costsPercentOfMaxHP = 0, dealsNoDamage = false, moveName?: string) {
  const stages = Object.entries(selfStageChanges(me, boosts));
  if (!stages.length) return null;
  const raised = Object.fromEntries(stages.map(([stat, stage]) =>
    [stat, Math.max(-6, Math.min(6, (me.boosts[stat] ?? 0) + stage!))]));
  if (moveName?.toLowerCase().replace(/[^a-z0-9]/g,'') === 'bellydrum' || costsPercentOfMaxHP === 50 && boosts.atk === 6) raised.atk = stages.find(([stat])=>stat==='atk')![1] > 0 ? 6 : -6;
  // Belly Drum and Fillet Away buy their boost with health, which changes what the user then survives.
  const spent = costsPercentOfMaxHP > 0 && me.exactHP
    ? { exactHP: { current: Math.max(1, me.exactHP.current - Math.floor(me.exactHP.max * costsPercentOfMaxHP / 100)), max: me.exactHP.max },
        hpPercent: Math.max(0, (me.hpPercent ?? 100) - costsPercentOfMaxHP) }
    : {};
  const after = clone(me, { boosts: { ...me.boosts, ...raised }, ...spent });
  const before = outgoingBest(s, me, side, 1), boosted = outgoingBest(s, after, side, 1);
  const speedBefore = speedSummary(s, me), speedAfter = speedSummary(s, after);
  if (!boosted && speedAfter.relation === 'unknown') return null;
  // Stat changes are lost when their holder faints, and a stat move deals no damage to prevent that. So if
  // the incoming attack still knocks us out once the boost is counted, none of the rest of this happens.
  // Only a move that buys a gain and deals nothing is wasted by fainting. A self-penalty on an attack is
  // not a loss worth reporting, and the attack itself still lands.
  const buysAGain = dealsNoDamage && stages.some(([, stage]) => stage! > 0);
  const afterThreat = incomingThreats(s, after, side, 1);
  const beforeThreat = incomingThreats(s, me, side, 1);
  const setupOrder = moveName ? turnOrder(s, me, moveName)?.order : undefined;
  // A slower defensive setup cannot reduce the hit that lands before it; speed boosts affect next turn.
  const setupThreat = setupOrder === 'theirs-first' ? beforeThreat : setupOrder === 'uncertain'
    ? ((beforeThreat?.worstCasePercentOfMaxHP ?? 0) > (afterThreat?.worstCasePercentOfMaxHP ?? 0) ? beforeThreat : afterThreat) : afterThreat;
  const knockedOut = buysAGain && setupThreat?.conditionalKO === 'all-sampled-rolls';
  const mayBeKnockedOut = buysAGain && setupThreat?.conditionalKO === 'some-sampled-rolls';
  const residual = residuals(s, after, side)?.perTurnPercentOfMaxHP;
  const chip = Array.isArray(residual) ? residual[0]! : residual ?? 0;
  const rawRemaining = (after.hpPercent ?? 100) - (setupThreat?.worstCasePercentOfMaxHP ?? 0);
  const remaining = setupThreat?.conditionalKO === 'none-sampled' && rawRemaining <= 0 && after.exactHP
    ? 100 / after.exactHP.max : rawRemaining;
  const nextTurnHP = setupThreat?.worstCasePercentOfMaxHP == null ? null : Math.round(Math.max(0, Math.min(100,remaining+chip))*10)/10;
  const projectedState = structuredClone(s);
  const ourIndex = projectedState.sides[side].team.findIndex(p=>p.id===me.id);
  if(ourIndex>=0) projectedState.sides[side].team[ourIndex]=after;
  const damagedAfter = nextTurnHP !== null && nextTurnHP > 0 && after.exactHP ? clone(after, { hpPercent: nextTurnHP, exactHP: { max: after.exactHP.max, current: Math.max(1,Math.floor(after.exactHP.max*nextTurnHP/100)) } }) : null;
  const afterSetupHit = dealsNoDamage && damagedAfter ? outgoingBest(s, damagedAfter, side, 1) : null;
  const nextUse = !dealsNoDamage && moveName ? damageRange(projectedState,moveName) : null;
  // Unaware reads through stat changes entirely, so setting up against it buys nothing offensively —
  // unless we break moulds, which reads straight back through the Unaware.
  const foe = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const active = foe.team.find(p => p.id === foe.activeId);
  const candidates = breaksMoulds(me) ? [] : active ? inferOpponent(active).candidates : [];
  const mass = candidates.reduce((n, c) => n + c.probability, 0);
  const unaware = candidates.filter(c => ignoresBoosts(active?.ability ?? c.ability));
  return {
    effectiveStageChanges: Object.fromEntries(stages),
    stagesAfter: raised,
    incomingPercentBeforeChange: beforeThreat?.worstCasePercentOfMaxHP ?? null,
    incomingPercentAfterChange: afterThreat?.worstCasePercentOfMaxHP ?? null,
    ...(stages.some(([,n])=>n<0) ? { selfDropCost: 'These drops weaken later turns until switching; compare a switch or a move without the drops. They do not erase the damage dealt now.' } : {}),
    ...(nextUse ? { sameMoveDamagePercentOnNextUse: nextUse.percentOfMaxHP } : {}),
    ...(afterSetupHit ? { bestDamageAfterModeledSetupHit: afterSetupHit.bestCasePercentOfMaxHP } : {}),
    ...(dealsNoDamage ? { setupTurnOrder: setupOrder ?? 'unknown', worstModeledHPAfterSetupTurn: nextTurnHP, nextTurnOrderAtEqualPriority: speedAfter.relation==='unknown'?'unknown':speedAfter.ifEqualPriority, nextTurnStillDependsOnOpponentPriorityAndActions: true } : {}),
    // Stated first, because everything after it is conditional on surviving to use it.
    ...(knockedOut ? { wastedBecauseWeAreKnockedOutFirst: 'if the opponent uses the modeled KO attack, we faint before benefiting on a later turn; stat changes are lost with the Pokémon' } : {}),
    ...(unaware.length && mass > 0
      ? { ignoredByUnawareWithProbability: Math.round(unaware.reduce((n, c) => n + c.probability, 0) / mass * 1000) / 1000 }
      : {}),
    ...(boosted ? { ourBestDamagePercentAfter: boosted.bestCasePercentOfMaxHP,
      ...(before ? { wasBefore: before.bestCasePercentOfMaxHP } : {}),
      nowKnocksOutTheActive: boosted.conditionalKO === 'all-sampled-rolls' && before?.conditionalKO !== 'all-sampled-rolls' } : {}),
    ...(speedAfter.relation !== speedBefore.relation ? { speedRelationBecomes: speedAfter.relation } : {}),
    // The boost stays for whatever they send in next, which is part of what a Speed boost buys.
    ...(raised.spe !== undefined && raised.spe !== (me.boosts.spe ?? 0)
      ? { theirRemainingPokemon: benchSpeed(s, me, side, raised.spe - (me.boosts.spe ?? 0)) ?? undefined } : {}),
    outrunsTheActiveAfterwards: speedAfter.relation !== 'unknown' && speedAfter.ifEqualPriority === 'ours-first',
    ...(costsPercentOfMaxHP > 0 ? { leavesUsAtPercentOfMaxHP: Math.max(0, Math.round(((me.hpPercent ?? 100) - costsPercentOfMaxHP) * 10) / 10) } : {}),
    ...(buysAGain ? { survivesToUseIt: setupThreat?.worstCasePercentOfMaxHP == null || mayBeKnockedOut ? null : !knockedOut && (nextTurnHP === null || nextTurnHP > 0) } : {}),
  };
}

/**
 * What landing a status is worth, beyond the fact of landing it. A burn halves physical damage and a
 * paralysis halves speed, both of which can decide the matchup, and neither of which is visible from the
 * status name alone. Compared against the same opponent with no status.
 */
export function statusProjection(s: BattleState, target: PokemonState, ourSide: SideId, me: PokemonState, status: string, moveName?: string) {
  if (!['brn', 'par'].includes(status) || target.status) return null;
  // Unlike a stat change, a status survives its user: landing it and then fainting still leaves it behind.
  // It is only wasted when we are knocked out before acting, which is a question of turn order.
  const doomed = incomingThreats(s, me, ourSide, 1)?.conditionalKO === 'all-sampled-rolls';
  const theirSide = ourSide === 'p1' ? 'p2' : 'p1';
  const before = incomingThreats(s, me, ourSide, 1);
  // The opposing side's active is the one taking the status, so re-evaluate the threat it poses.
  const afflicted = clone(target, { status });
  const swapped: BattleState = structuredClone(s);
  const slot = swapped.sides[theirSide].team.findIndex(p => p.id === target.id);
  if (slot < 0) return null;
  swapped.sides[theirSide].team[slot] = afflicted;
  const after = incomingThreats(swapped, me, ourSide, 1);
  const result: Record<string, unknown> = {};
  if (before && after && before.worstCasePercentOfMaxHP !== null && after.worstCasePercentOfMaxHP !== null) {
    result.worstIncomingPercentBecomes = after.worstCasePercentOfMaxHP;
    result.wasBefore = before.worstCasePercentOfMaxHP;
    if (before.conditionalKO === 'all-sampled-rolls' && after.conditionalKO !== 'all-sampled-rolls') {
      result.stopsItFromKnockingUsOut = true;
    }
  }
  if (doomed && moveName && turnOrder(s, me, moveName)?.order === 'theirs-first') {
    result.neverGoesOff = 'if the opponent uses the modeled KO attack, we move second and faint before applying status';
  }
  if (status === 'par') {
    const relation = speedSummary(swapped, me).relation;
    if (relation !== speedSummary(s, me).relation) result.speedRelationBecomes = relation;
    result.fullParalysisChancePercent = 25;
  }
  return Object.keys(result).length ? result : null;
}

/** What our own Tera changes about the damage we take, which is the half of Tera that is easy to miss. */
export function defensiveTera(s: BattleState, me: PokemonState, side: SideId, teraType: string) {
  if (!teraType || me.terastallized) return null;
  // Stellar keeps the original typing on defence; Terapagos gains Stellar HP and loses Tera Shell with it.
  const before = incomingThreats(s, me, side, Infinity);
  const after = incomingThreats(s, afterTerastallizing(me, teraType), side, Infinity, teraType === 'Stellar' ? undefined : teraType);
  if (!before || !after || before.worstCasePercentOfMaxHP === null || after.worstCasePercentOfMaxHP === null) return null;
  // Judged move by move, not only on the worst hit: Tera Ground made a 15% Beartic immune to Regieleki's revealed Volt
  // Switch and its Thunderbolt, but an unrevealed Explosion stayed the worst hit at the same 53.6%, so the Tera read as
  // changing nothing and was skipped, and Volt Switch knocked Beartic out before its Earthquake. The mirror case: Tera
  // Steel on an 18% Latias resisted that Explosion, so the worst hit fell from 70.8% to 35.2%, still a knockout, while
  // the revealed Thunderbolt went from 15% to a knockout and landed before Draco Meteor.
  const kills = (ko: string) => ko === 'all-sampled-rolls' || ko === 'some-sampled-rolls';
  const beforeKO = new Map(before.damagingMoves.map(m => [m.move, kills(m.conditionalKO)]));
  const afterKO = new Map(after.damagingMoves.map(m => [m.move, kills(m.conditionalKO)]));
  const stopped = before.damagingMoves.filter(m => kills(m.conditionalKO) && !afterKO.get(m.move)).map(m => m.move);
  const started = after.damagingMoves.filter(m => kills(m.conditionalKO) && !beforeKO.get(m.move)).map(m => m.move);
  // Worse is reported as well as better: Tera Fighting Lurantis took a doubled Psychic hit from the Girafarig it
  // Terastallised to finish, because the new type is in place before the opposing move lands.
  if (Math.abs(after.worstCasePercentOfMaxHP - before.worstCasePercentOfMaxHP) < 5 && !stopped.length && !started.length) return null;
  const ko = (t: typeof before) => t.conditionalKO === 'all-sampled-rolls';
  // A Tera that does not stop this hit can still stop the next one. Diancie at full HP survived Palafin's Jet Punch
  // either way, so "stopsItFromKnockingUsOut: false" was all it said; Tera Fairy halved the hit, so it took three Jet
  // Punches instead of two, time for two Diamond Storms, and without it Diancie fell to the second.
  const hits = (worst: number) => (me.hpPercent && worst > 0 ? Math.ceil(me.hpPercent / worst) : null);
  const hitsBefore = hits(before.worstCasePercentOfMaxHP), hitsAfter = hits(after.worstCasePercentOfMaxHP);
  return { teraType, worstIncomingPercentBecomes: after.worstCasePercentOfMaxHP,
    wasBefore: before.worstCasePercentOfMaxHP,
    ...(hitsBefore !== null && hitsAfter !== null && hitsBefore !== hitsAfter
      ? { hitsItTakesToKnockUsOutBecomes: hitsAfter, wasHitsBefore: hitsBefore } : {}),
    ...(after.worstCasePercentOfMaxHP > before.worstCasePercentOfMaxHP
      ? { makesUsWeakerToTheirAttack: true, ...(ko(after) && !ko(before) ? { startsKnockingUsOut: true } : {}) } : {}),
    stopsItFromKnockingUsOut: ko(before) && !ko(after),
    ...(stopped.length && !(ko(before) && !ko(after)) ? { stopsTheseFromKnockingUsOut: stopped } : {}),
    ...(started.length ? { letsTheseKnockUsOut: started } : {}) };
}
export { boostedStat, worst };

/**
 * Setting weather is a setup move for whatever the user's own moves do in it. Hydro Steam in sun is the
 * clearest case: the weather is what the move is for, and nothing about a weather move says so. Projects
 * our best damage and what we take once it is up, against the Pokémon currently out.
 */
export function weatherProjection(s: BattleState, me: PokemonState, side: SideId, weather: string) {
  if (!weather || s.field.weather === weather) return null;
  const after: BattleState = structuredClone(s);
  after.field.weather = weather;
  const before = outgoingBest(s, me, side, 1), boosted = outgoingBest(after, me, side, 1);
  const takenBefore = incomingThreats(s, me, side, 1), takenAfter = incomingThreats(after, me, side, 1);
  if (!before || !boosted) return null;
  const gain = Math.round((boosted.bestCasePercentOfMaxHP - before.bestCasePercentOfMaxHP) * 10) / 10;
  const takenGain = takenAfter?.worstCasePercentOfMaxHP !== null && takenAfter && takenBefore?.worstCasePercentOfMaxHP !== null && takenBefore
    ? Math.round((takenAfter.worstCasePercentOfMaxHP! - takenBefore.worstCasePercentOfMaxHP!) * 10) / 10
    : null;
  if (gain === 0 && (takenGain === null || takenGain === 0)) return null;
  return { sets: weather,
    ourBestDamagePercentAfter: boosted.bestCasePercentOfMaxHP, wasBefore: before.bestCasePercentOfMaxHP,
    ourBestMoveBecomes: boosted.moves[0]?.move,
    ...(gain !== 0 ? { damageGainedPercentagePoints: gain } : {}),
    ...(takenGain !== null && takenGain !== 0 ? { whatWeTakeChangesBy: takenGain } : {}),
    nowKnocksOutTheActive: boosted.conditionalKO === 'all-sampled-rolls' && before.conditionalKO !== 'all-sampled-rolls' };
}
