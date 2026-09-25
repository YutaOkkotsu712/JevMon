import { revivalOptions, pivotPlan, teraDependents } from './teamTactics.js';
import { afterEntry } from './entry.js';
import { switchRelief } from './switchRelief.js';
import { dominatedMoves } from './dominance.js';
import { damageRange } from './damage.js';
import { inferOpponent } from './inference.js';
import { hitFrom, incomingThreats, outgoingBest } from './threat.js';
import { speedSummary, turnOrder } from './speed.js';
import type { DecisionInput } from '../decisions/DecisionProvider.js';
import type { BattleState, PokemonState, SideState } from '../battle/BattleState.js';
import { remainingPokemon } from '../battle/BattleState.js';
import { baseStab, boostedStat, fieldFactors, hazardExposure, healPercentNow, hitChancePercent, moveEffect, pokemonTypes, substituteInteraction, typeEffectiveness } from '../pokemon/mechanics.js';
import { supportedMove, unsupportedReason } from './calcCore.js';
import { effectViability } from './viability.js';
import { phazeOutlook } from './phaze.js';
import { encoreThreat } from './encoreThreat.js';
import { teraImmunityShare } from './teraImmunity.js';
import { cyclicSwitch } from './loopGuard.js';
import { residuals, survivalTurns } from './residual.js';
import { canUseRecoveryNow, opponentPP, protectOutlook, choiceLock, pendingRecovery, delayedRecoveryMove, substitutePlan, matchupProgress, slowStartTurnsLeft } from './stalling.js';
import { setupProjection, statusProjection, defensiveTera, weatherProjection } from './projection.js';
import { hazardValue } from './hazards.js';
import { endgame } from './endgame.js';
import { switchPunish, switchingPattern } from './prediction.js';
import { conditionalDamage, encoreLock, encorePlan, saltCureOutlook, suckerOutlook } from './conditional.js';
import { trappedByUs } from './trapping.js';
import { activatesTheirItem, asleepChanceOfMove, berryRecoveryAfterHit, flinchRisk, sleepTalkMoves, statusRisk, wakeChance } from './risk.js';
import { drainReversal, knockoutBoosts, pinchAbility, pinchAbilityRisk, reactiveAbilityRisks } from './abilities.js';
import { choiceTrickOutlook } from './itemSwap.js';
import { knockoutCosts } from './knockoutCosts.js';
import { restPlan } from './rest.js';
import { afterTerastallizing, formeChange, teraAlsoRaises, teraFormeChange, switchOutForme } from './forme.js';
import { dex, id } from '../pokemon/data.js';

/** Weather moves name their effect the way the dex stores it; the tracker names it the way the protocol does. */
const weatherNames: Record<string, string> = { sunnyday: 'SunnyDay', raindance: 'RainDance', sandstorm: 'Sandstorm', snowscape: 'Snow', snow: 'Snow', hail: 'Hail' };
const weatherName = (value: string) => weatherNames[value.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? value;
/**
 * Terastallising is available once in a battle, so the question is not whether it helps but whether it helps
 * enough to spend here. This states the difference it makes to this move, rather than leaving it to be found
 * by comparing two separate actions.
 */
function teraGain(s: BattleState, moveName: string, tera: string, withTera: NonNullable<ReturnType<typeof damageRange>>) {
  const without = damageRange(s, moveName);
  if (!without) return null;
  const gain = Math.round((withTera.percentOfMaxHP[1] - without.percentOfMaxHP[1]) * 10) / 10;
  return { teraType: tera, oncePerBattle: true,
    damagePercentWithout: without.percentOfMaxHP[1], damagePercentWith: withTera.percentOfMaxHP[1],
    percentagePointsGained: gain,
    turnsAKnockOutIntoOne: withTera.conditionalKO === 'all-sampled-rolls' && without.conditionalKO !== 'all-sampled-rolls' };
}
/** Payload detail, reduced only to stay inside our own request budget. Never silently drops actions. */
export type Detail = 'full' | 'reduced' | 'minimal';
const active = (side: SideState) => side.team.find(p => p.id === side.activeId);
/**
 * Terastallising is offered as a separate action per move, and most of each one restates the move it came
 * from: the same description, PP, effect and turn order, byte for byte. Saying what Tera *changes* and
 * pointing at the base action carries the same information in roughly half the space, which is space the
 * bench matchups and set inference need. Every legal action is still listed under its own id; nothing is
 * dropped, and any field that actually differs is written out in full.
 */
/**
 * Some fields belong to the turn rather than to any one action: the hazards our side is sitting under, what
 * our own Tera changes defensively, the warning that we faint before acting. Repeating them per action costs
 * hundreds of bytes and says nothing new, so one carried identically by every action that has it is stated
 * once. Only exact, whole-value matches are hoisted, and only from a fixed list of turn-level fields.
 */
function hoistSharedActionFields<T extends { id: string }>(actions: T[]) {
  // Deliberately an allowlist of things that describe the turn or our side rather than the choice. Anything
  // a move is actually picked on — turn order, damage, what a move would waste — stays attached to its own
  // action, because a decision input that has to be looked up elsewhere is one that gets ignored.
  const hoistable = new Set(['hazardExposure', 'defensiveTera', 'executionRisk', 'teraChangesOurForme']);
  const counts = new Map<string, { json: string; seen: number; distinct: boolean }>();
  for (const action of actions) {
    for (const [key, value] of Object.entries(action as Record<string, unknown>)) {
      if (!hoistable.has(key) || value === undefined) continue;
      const json = JSON.stringify(value);
      if (json.length < 40) continue;
      const found = counts.get(key);
      if (!found) counts.set(key, { json, seen: 1, distinct: false });
      else { found.seen++; if (found.json !== json) found.distinct = true; }
    }
  }
  const shared: Record<string, unknown> = {};
  for (const [key, entry] of counts) {
    if (entry.distinct || entry.seen < 2) continue;
    shared[key] = JSON.parse(entry.json);
  }
  const keys = new Set(Object.keys(shared));
  if (!keys.size) return { actions, shared: null };
  const stripped = actions.map(action => Object.fromEntries(
    Object.entries(action as Record<string, unknown>).filter(([k]) => !keys.has(k))) as unknown as T);
  return { actions: stripped, shared };
}
type TeraDelta = { sameAsWithoutTerastallising: string; fieldsThatNoLongerApply?: string[]; nothingModelledChangesByTerastallising?: true };
function collapseTeraVariants<T extends { id: string }>(actions: T[]): (T & Partial<TeraDelta>)[] {
  const byId = new Map(actions.map(a => [a.id, a as Record<string, unknown>]));
  const always = new Set(['id', 'kind', 'label', 'requestUncertain']);
  return actions.map(action => {
    const baseId = action.id.endsWith('-terastallize') ? action.id.slice(0, -'-terastallize'.length) : null;
    const base = baseId ? byId.get(baseId) : undefined;
    if (!base) return action;
    const self = action as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    let elided = 0;
    for (const key of Object.keys(self)) {
      if (!always.has(key) && JSON.stringify(self[key]) === JSON.stringify(base[key])) { elided++; continue; }
      changed[key] = self[key];
    }
    // A key present on the base and absent here is a real difference, so it is reported rather than implied.
    const removed = Object.keys(base).filter(k => !(k in self));
    if (!elided) return action;
    // An empty delta is a real answer, not a missing one: Terastallising here changes nothing we model, which
    // is worth saying outright so the one Tera available is not spent for an unstated gain.
    const differs = Object.keys(changed).some(k => !always.has(k));
    // The elided keys are the ones equal to the base action, so callers reading them get the base's value
    // by following the reference; the type keeps them visible rather than widening every consumer.
    return { ...changed, sameAsWithoutTerastallising: baseId,
      ...(differs ? {} : { nothingModelledChangesByTerastallising: true }),
      ...(removed.length ? { fieldsThatNoLongerApply: removed } : {}) } as unknown as T & TeraDelta;
  });
}
/** At minimal a switch matchup is worth its verdict, not the move-by-move working behind it. */
const compactThreat = (t: ReturnType<typeof incomingThreats>) => t && ({ attacker: t.attacker,
  worstCasePercentOfMaxHP: t.worstCasePercentOfMaxHP, conditionalKO: t.conditionalKO,
  damagingMovesConsidered: t.damagingMoves.length });
const evidenceMethod = 'speed entries come from equal-priority turn order observed on the field, including a turn where they moved first and ours never acted; ties are kept and speed modifiers and Trick Room are included. damage entries come from one noncritical single hit of the named move, with public HP rounding and censored overkill counted. before and after count sampled sets; contradiction means every set was ruled out, so none were removed.';
/** An observation's facts without the method note repeated on each; the move is kept for damage evidence. */
function compactEvidence(list: { kind: string; turn: number; before: number; after: number; contradiction?: boolean; note?: string }[]) {
  return list.map(o => ({ kind: o.kind, turn: o.turn,
    ...(o.kind === 'damage' && /^Observed (.+?):/.exec(o.note ?? '') ? { move: /^Observed (.+?):/.exec(o.note!)![1] } : {}),
    before: o.before, after: o.after, ...(o.contradiction ? { contradiction: true } : {}) }));
}
function compactPokemon(p: PokemonState) {
  return { slot: p.slot, species: p.species, transformedInto: p.transformedInto,
    types: pokemonTypes(p), hp: p.hpPercent, hpPrecision: p.hpPrecision, status: p.status,
    fainted: p.fainted, ...(p.substitute ? { substitute: p.substitute } : {}), boosts: p.boosts, moves: p.knownMoves.length ? p.knownMoves : p.revealedMoves,
    copiedMoves: p.copiedMoves, ability: p.ability, abilitySuppressed: p.abilitySuppressed, item: p.item,
    teraType: p.teraType, terastallized: p.terastallized, volatiles: p.volatiles };
}
const trim = <T>(values: T[], limit: number) => (values.length > limit ? values.slice(0, limit) : values);
// Only the move frequencies are long enough to be worth trimming; trimming items would
// leave the listed mass inconsistent with the stated `noItemProbability`.
function trimPriors(priors: NonNullable<ReturnType<typeof inferOpponent>['summary']['setPriors']>, limit: number) {
  return { ...priors, moves: Object.fromEntries(Object.entries(priors.moves).slice(0, limit)) };
}

export function extractFeatures(input: DecisionInput, detail: Detail = 'full') {
  const s = input.state, ours = s.mySide ? s.sides[s.mySide] : undefined;
  const theirs = s.mySide ? s.sides[s.mySide === 'p1' ? 'p2' : 'p1'] : undefined;
  const me = ours && active(ours), foe = theirs && active(theirs);
  const full = detail === 'full', minimal = detail === 'minimal';
  const threatLimit = full ? 3 : 2;
  // After a faint the active slot still holds the fainted Pokémon, so a relation computed from it is
  // meaningless and a null threat would read as safety. Say that staying in is not on offer instead.
  const forced = !!input.request?.forceSwitch?.[0] || !!me?.fainted;
  const relation = forced ? null : speedSummary(s);
  const dominance = dominatedMoves(input);
  // Hoisted above the actions so a switch can name what on their bench answers it: they may switch too,
  // and every per-switch matchup below is against the Pokémon currently out.
  const endgameSummary = s.mySide ? endgame(s, s.mySide) : null;
  const reviving = input.legalActions.some(a=>a.kind==='revive');
  const revival = s.mySide && (reviving || me?.knownMoves.some(m=>m.toLowerCase().replace(/[^a-z0-9]/g,'')==='revivalblessing')) ? revivalOptions(s,s.mySide) : [];
  const staying = forced || !me || !s.mySide ? null : incomingThreats(s, me, s.mySide, threatLimit);
  const pattern = !forced && me && s.mySide ? switchingPattern(s, me, s.mySide, me.knownMoves.length ? me.knownMoves : me.revealedMoves) : null;
  // The opponent picks its move before it sees our switch, so the attack aimed at our active is the one a switch
  // has to absorb. Pricing each switch-in against it is what finds the Pokémon that resists that attack.
  const aimed = staying?.damagingMoves.find(m => m.percentOfMaxHP[1] > 0)?.move;
  const switchTurn = (p: PokemonState) => {
    const hit = aimed && s.mySide ? hitFrom(s, p, s.mySide, aimed) : null;
    return hit ? { takesSwitchTurnAttack: hit.percentOfMaxHP, ...(hit.conditionalKO !== 'none-sampled' ? { switchTurnAttackKO: hit.conditionalKO } : {}) } : {};
  };
  // Only while Tera is still ours to spend, and only for teammates whose sets are built around it.
  const teraLeft = !forced && s.mySide && input.request?.active?.[0]?.canTerastallize ? teraDependents(s, s.mySide) : [];
  const offeredMoves = new Set(input.legalActions.filter(a => a.kind === 'move').map(a => a.label.split(' + Tera')[0]!));
  const lockedInto = offeredMoves.size === 1 ? [...offeredMoves][0]! : null;
  const lockItem = me?.item ? dex.items.get(me.item) : null;
  const ourLock = me && !forced && lockedInto && lockItem?.exists && ['choiceband', 'choicespecs', 'choicescarf'].includes(lockItem.id) &&
    me.lastMoveUsed && dex.moves.get(me.lastMoveUsed).id === dex.moves.get(lockedInto).id
    ? { move: lockedInto, item: lockItem.name, releasedBySwitching: true } : null;
  const theirRecoveryPP = me && foe ? opponentPP(s, foe, me)?.moves : undefined;
  const withSearch = <T extends { id: string }>(a: T) => {
    const v = input.search?.[a.id];
    return v ? { ...a, search: { share: v.visitShare, score: v.meanScore } } : a;
  };
  const actions = input.legalActions.map(action => {
    const slot = Number(action.command.split(' ')[1]);
    if (action.kind === 'revive') return { id:action.id,kind:action.kind,label:action.label,revivedTeammate:revival.find(p=>p.slot===slot),notASwitchIn:true };
    if (action.kind === 'move') {
      const requestMove = input.request?.active?.[0]?.moves[slot - 1];
      const move = dex.moves.get(requestMove?.id ?? action.label.split(' + Tera')[0]!);
      const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
      const variableType = ['weatherball', 'terablast', 'judgment', 'technoblast', 'revelationdance', 'ivycudgel', 'naturalgift'].includes(move.id);
      const moveType = variableType ? null : move.type;
      const targeted = ['normal', 'allAdjacent', 'allAdjacentFoes', 'randomNormal', 'any'].includes(move.target);
      const estimate = damageRange(s, move.name, tera);
      // The usual KO label uses the defender's HP now. A revealed faster Recover can move that target out of range
      // before this attack lands, which is why a slower recoil hit can be a losing answer to a healing loop.
      const recoveryBeforeHit = me && foe && estimate && move.category !== 'Status' &&
        turnOrder(s, tera ? afterTerastallizing(me, tera) : me, move.name)?.order === 'theirs-first'
        ? foe.revealedMoves.map(name => ({ move: dex.moves.get(name).name,
          heal: healPercentNow(name, s.field.weather) ?? 0 })).filter(x => x.heal > 0 && canUseRecoveryNow(foe, x.move) &&
            theirRecoveryPP?.find(pp => id(pp.move) === id(x.move))?.atMostRemaining !== 0)
          .sort((a, b) => b.heal - a.heal)[0] : undefined;
      const theirHPAfterRecovery = recoveryBeforeHit && foe?.hpPercent !== null && foe?.hpPercent !== undefined
        ? Math.min(100, foe.hpPercent + recoveryBeforeHit.heal) : null;
      // Type chart, STAB and field factors are the fallback for moves the calculator declines; a damage
      // envelope already contains them, so they are dropped first when the payload has to shrink.
      const components = full || !estimate;
      const substitute = me && foe ? substituteInteraction(move.name, me, foe) : null;
      const effect = moveEffect(move.name, me?.exactHP?.max ?? null, s.field.weather, me);
      const viability = me && s.mySide ? effectViability(s, move.name, me, s.mySide, foe) : null;
      return { id: action.id, kind: action.kind, label: action.label, requestUncertain: action.uncertain,
        ...(move.exists ? { moveType, listedCategory: move.category, listedBasePower: move.basePower, priority: move.priority,
          ...(components ? { description: move.shortDesc,
            baseSTAB: moveType && me ? baseStab(moveType, me, tera) : null,
            typeChartMultiplier: moveType && foe && targeted && move.category !== 'Status' ? typeEffectiveness(moveType, pokemonTypes(foe)) : null,
            fieldFactors: moveType && move.category !== 'Status' ? fieldFactors(moveType, move.id, s.field.weather, s.field.terrain) : null } : {}),
          damageRange: estimate,
          ...(recoveryBeforeHit && theirHPAfterRecovery !== null && estimate &&
            estimate.conditionalKO !== 'none-sampled' && estimate.percentOfMaxHP[1] + 1 < theirHPAfterRecovery
            ? { ifTheyRecoverBeforeThisHit: { move: recoveryBeforeHit.move,
              theirHPBeforeHitPercent: theirHPAfterRecovery, knockoutAfterRecovery: false,
              condition: 'only if the opponent uses its revealed recovery before this slower attack' } } : {}),
          // The knockout labels assume the move lands; a knockout from a move that can miss is priced with its odds.
          ...(() => {
            if (!estimate || estimate.conditionalKO === 'none-sampled' || !me || !foe) return {};
            const hit = hitChancePercent(move.name, s.field.weather, me, foe);
            if (hit >= 100) return {};
            const all = estimate.conditionalKO === 'all-sampled-rolls';
            const low = Math.round(hit * (all ? 1 : estimate.koProbability?.regardlessOfRoll ?? 0));
            const high = Math.round(hit * (all ? 1 : estimate.koProbability?.onSomeRoll ?? 1));
            return { knockoutOnlyIfItHits: { hitChancePercent: hit, knockoutChancePercent: low === high ? low : [low, high] } };
          })(),
          ...(dominance.has(action.id) ? { dominatedBy: dominance.get(action.id) } : {}),
          moveTypeUncertain: variableType,
          // An absent estimate must never read as an absence of danger. A state-wide cause is stated once in
          // estimatesUnavailable, so only a move-specific cause is repeated here.
          ...(estimate || move.category === 'Status' || (me && foe && unsupportedReason(s, me, foe)) ? {}
            : { damageUnavailable: supportedMove(move.name)
              ? 'no sampled set is compatible with the evidence'
              : 'this move is outside the supported damage model' }),
          // PP is what a stall turns on, and the private request is authoritative for our own.
          ...(typeof requestMove?.pp === 'number' ? { pp: { remaining: requestMove.pp, ...(requestMove.maxpp ? { max: requestMove.maxpp } : {}) } } : {}),
          effect,
          ...(move.hasCrashDamage && s.mySide ? { crashesIfTheyTerastallizeInto: teraImmunityShare(s, s.mySide, move.name) ?? undefined } : {}),
          ...(me && foe && s.mySide ? { choiceItemTrick: choiceTrickOutlook(s, me, foe, s.mySide,
            move.name, pattern?.fromThisOneTheyHaveGoneTo) ?? undefined } : {}),
          ...(me && s.mySide ? { protect: protectOutlook(s, move.name, s.mySide, me, foe) ?? undefined } : {}),
          // Damage the calculator cannot express, kept with the condition it depends on rather than dropped.
          ...(me && s.mySide ? { conditionalDamage: conditionalDamage(s, me, s.mySide, move.name) ?? undefined } : {}),
          ...(s.mySide ? { suckerPunch: suckerOutlook(s, s.mySide, move.name) ?? undefined } : {}),
          ...(move.id === 'saltcure' ? { saltCure: saltCureOutlook(foe) ?? undefined } : {}),
          ...(me && s.mySide ? { encore: encorePlan(s, me, s.mySide, move.name) ?? undefined } : {}),
          // A super-effective hit that fails to knock out can hand the target the game.
          ...(s.mySide && !minimal ? { activatesTheirItem: activatesTheirItem(s, s.mySide, move.name, tera || undefined, me) ?? undefined } : {}),
          ...(foe && estimate ? { berryRecoveryAfterHit: berryRecoveryAfterHit(s, foe, estimate.percentOfMaxHP) ?? undefined } : {}),
          ...(foe ? { triggersTheirAbility: reactiveAbilityRisks(foe, move.name,
            estimate === null || estimate.percentOfMaxHP[1] > 0) ?? undefined } : {}),
          ...(move.id === 'revivalblessing' ? { revivalBlessing: { candidates:revival, failsWithoutFaintedTeammate:revival.length===0, spendsTurnBeforeRevival:true, restoresHalfMaxHPOnBench:true, mustSurviveToExecute:true } } : {}),
          ...(me && s.mySide && move.selfSwitch && move.id !== 'revivalblessing' ? { pivot: pivotPlan(s,me,s.mySide,move.name) } : {}),
          ...(me ? { delayedRecovery: delayedRecoveryMove(move.name, me) ?? undefined } : {}),
          ...(me && s.mySide && move.id === 'rest' ? { rest: restPlan(s, me, s.mySide) } : {}),
          ...(me && s.mySide ? { substitute: substitutePlan(s, me, s.mySide, move.name) ?? undefined } : {}),
          // What this move buys beyond its listed effect: setup that wins the matchup, a status that
          // blunts theirs, hazards collected on every future switch, and Tera used to survive rather than hit.
          ...(me && s.mySide && effect?.userBoosts
            ? { afterItsStatChange: setupProjection(s, me, s.mySide, (effect.listedUserBoosts ?? effect.userBoosts) as Record<string, number>,
              typeof effect.costsPercentOfMaxHP === 'number' ? effect.costsPercentOfMaxHP : 0,
              move.category === 'Status', move.name) ?? undefined }
            : me && s.mySide && effect?.userBoostsOnlySometimes
              ? (() => {
                const { boosts, chancePercent } = effect.userBoostsOnlySometimes as { boosts: Record<string, number>; chancePercent: number };
                const after = setupProjection(s, me, s.mySide, boosts, 0, false, move.name);
                return after ? { afterItsStatChangeIfItHappens: { ...after, happensPercentOfTheTime: chancePercent } } : {};
              })() : {}),
          ...(me && foe && s.mySide && typeof effect?.inflictsStatus === 'string' && !minimal
            ? { ifTheStatusLands: statusProjection(s, foe, s.mySide, me, effect.inflictsStatus, move.name) ?? undefined } : {}),
          ...(s.mySide && !minimal ? { hazards: hazardValue(s, move.name, s.mySide) ?? undefined } : {}),
          ...(s.mySide && move.forceSwitch ? { phaze: phazeOutlook(s, s.mySide, move.name) ?? undefined } : {}),
          // Weather is setup for whatever our own moves do in it, which the move itself never says.
          ...(me && s.mySide && effect?.setsWeather && !minimal
            ? { afterThisWeather: weatherProjection(s, me, s.mySide, weatherName(String(effect.setsWeather))) ?? undefined } : {}),
          // Tera is available once, so what it actually buys on this move is worth stating outright.
          ...(tera && estimate ? { teraBuysUs: teraGain(s, move.name, tera, estimate) ?? undefined } : {}),
          ...(tera && me ? { teraAlsoRaises: teraAlsoRaises(me, tera) ?? undefined } : {}),
          ...(me && s.mySide && tera
            ? { defensiveTera: defensiveTera(s, me, s.mySide, tera) ?? undefined } : {}),
          // A move that changes our form changes our typing and stats without spending the one Tera we have.
          ...(me && s.mySide && !minimal
            ? { changesOurForme: formeChange(s, me, s.mySide, move.name) ?? undefined } : {}),
          // Terastallising changes Terapagos's form rather than only its type, which costs it Tera Shell.
          ...(me && s.mySide && tera && !minimal
            ? { teraChangesOurForme: teraFormeChange(s, me, s.mySide) ?? undefined } : {}),
          // Both are omitted rather than nulled: there is nothing to say about most moves.
          ...(substitute ? { targetSubstitute: substitute } : {}),
          ...(viability && (viability.certain.length || viability.possible.length)
            ? { wouldAccomplishNothing: { certain: viability.certain, possible: viability.possible } } : {}),
          ...(viability?.limited.length ? { effectLimited: viability.limited } : {}),
          ...(foe ? { drainHurtsUsInstead: drainReversal(foe, move.name, me) ?? undefined } : {}),
          // A knockout can cost us too: a Destiny Bond takes our Pokémon down with theirs, Aftermath a quarter of our HP.
          ...(foe && me && s.mySide && estimate && estimate.conditionalKO !== 'none-sampled'
            ? { knockoutCosts: knockoutCosts(foe, move.name, turnOrder(s, tera ? afterTerastallizing(me, tera) : me, move.name)?.order) ?? undefined } : {}),
          ...(me && s.mySide ? { turnOrder: turnOrder(s, tera ? afterTerastallizing(me, tera) : me, move.name) } : {}) } : { dataUnknown: true }) };
    }
    const p = ours?.team.find(p => p.slot === slot);
    if (!p || !ours || !s.mySide || action.kind !== 'switch') {
      return { id: action.id, kind: action.kind, label: action.label, requestUncertain: action.uncertain };
    }
    const arrived = afterEntry(s, p, s.mySide);
    const threatOnFirstMove = incomingThreats(s, p, s.mySide, forced ? Infinity : threatLimit);
    // After our Pokémon faints, the replacement enters between turns and may Tera before either
    // side's next move. The forced switch itself cannot spend Tera. Show that next-turn line only
    // when it changes the knockout forecast, so a Fire Hydreigon is not dismissed as an Ice KO.
    const teraNextTurn = forced && me?.fainted && !arrived.fainted && p.teraType &&
      !ours.team.some(member => member.terastallized)
      ? incomingThreats(s, p, s.mySide, Infinity, p.teraType) : null;
    const koRank = (value: string | undefined) => value === 'all-sampled-rolls' ? 2 : value === 'some-sampled-rolls' ? 1 : 0;
    const teraSaves = teraNextTurn && threatOnFirstMove && koRank(teraNextTurn.conditionalKO) < koRank(threatOnFirstMove.conditionalKO);
    const teraStops = teraNextTurn && threatOnFirstMove ? threatOnFirstMove.damagingMoves
      .filter(hit => hit.conditionalKO === 'all-sampled-rolls' &&
        teraNextTurn.damagingMoves.find(after => after.move === hit.move)?.conditionalKO !== 'all-sampled-rolls')
      .map(hit => hit.move) : [];
    const cycle = !forced && !action.uncertain ? cyclicSwitch(s, s.mySide, p) : null;
    const entry = !forced && !action.uncertain && !minimal ? incomingThreats(s, p, s.mySide, 1) : null;
    // Knocked out on entry means certainly: a knockout that needs a move to hit is named with its odds instead.
    const doomed = entry?.conditionalKO === 'all-sampled-rolls' && entry.knockoutIsCertain !== false;
    const doomedIfItHits = entry?.conditionalKO === 'all-sampled-rolls' && entry.knockoutIsCertain === false ? entry.knockoutNeedsItToHit : null;
    const leftOn = typeof p.lastActiveTurn === 'number' ? s.turn - p.lastActiveTurn : null;
    // If they switch as we do, this is what could arrive instead of the Pokémon these matchups assume.
    const beatenBy = endgameSummary?.ourPokemon.find(x => x.species === p.species)?.losesTo
      .filter(species => species !== foe?.species) ?? [];
    return { id: action.id, kind: action.kind, label: action.label, requestUncertain: action.uncertain,
      // All zeroes until a hazard is actually set, and at minimal that is one copy of nothing per action.
      ...(minimal && !Object.keys(ours.hazards).length ? {} : { hazardExposure: hazardExposure(p, ours) }),
      // Every switch forfeits the turn, so saying so per action would repeat the glossary; the field name
      // ourBestDamageFromNextTurn carries the timing, and the full reason for a cycle goes to the log.
      wasActiveTurnsAgo: leftOn,
      ...(action.uncertain ? { entryUncertain: 'server reports possible trapping; this switch may be rejected' } : {}),
      // The attack is named once at the top level; each switch carries only what it takes from it.
      ...(switchTurn(p)),
      ...(p.knownMoves.some(m => id(m) === 'saltcure') && saltCureOutlook(foe)?.thenEachTurnPercentOfTheirMaxHP
        ? { itsSaltCureChipsThemEachTurnPercent: saltCureOutlook(foe)!.thenEachTurnPercentOfTheirMaxHP } : {}),
      ...(forced ? { entryAttackThisTurn: me?.fainted ? false : null, ...(me?.fainted ? {} : { pivotTimingUnknown: 'A forced pivot can still take an opposing action later this turn.' }) } : {}),
      ...(cycle ? { wouldUndoLastSwitch: true } : {}),
      ...(beatenBy.length ? { theirBenchThatBeatsIt: beatenBy } : {}),
      ...(doomed ? { knockedOutOnEntry: true } : {}),
      ...(doomedIfItHits ? { knockedOutOnEntryIfItHits: doomedIfItHits } : {}),
      switchIn: { afterHazards: { hp: arrived.hpPercent, fainted: arrived.fainted, status: arrived.status }, slot: p.slot, species: p.species, types: pokemonTypes(arrived), hp: p.hpPercent, status: p.status,
        ...(teraNextTurn && teraSaves ? { ifTerastallizedOnFirstMoveAfterReplacement: {
          type: p.teraType, spendsOurOncePerBattleTera: true,
          incomingThreat: minimal ? compactThreat(teraNextTurn) : { ...teraNextTurn, damagingMoves: teraNextTurn.damagingMoves.slice(0, threatLimit),
            otherPlausibleMoves: teraNextTurn.otherPlausibleMoves.slice(0, threatLimit + 1) },
          ...(teraStops.length ? { stopsTheseModeledKnockouts: teraStops } : {}) } } : {}),
        // Sleep counts down only on the field. Cacturne, slept by Yawn and withdrawn, was sent back against a 26% Magearna
        // to Sucker Punch it and lost its first turn to sleep, as every freshly slept Pokémon does.
        ...(p.status === 'slp' ? { asleep: { turnsAlreadyLostToSleep: p.sleepTurns ?? 0, ...(p.sleepFromRest ? { fromRest: true } : {}),
          chanceItWakesOnItsFirstTurnBackPercent: Math.round(wakeChance(p) * 1000) / 10,
          ...(sleepTalkMoves(p) ? { actsThroughSleepTalk: true } : {}) } } : {}),
        // Imposter: the numbers below are the copy's, with the opponent's stats, stat stages and moves.
        ...(arrived.transformedInto && !p.transformedInto ? { transformsInto: arrived.transformedInto, copiedMoves: arrived.copiedMoves, copiedBoosts: arrived.boosts } : {}),
        incomingThreat: minimal ? compactThreat(threatOnFirstMove) : threatOnFirstMove
          ? { ...threatOnFirstMove, damagingMoves: threatOnFirstMove.damagingMoves.slice(0, threatLimit),
            otherPlausibleMoves: threatOnFirstMove.otherPlausibleMoves.slice(0, threatLimit + 1) } : null,
        ourBestDamageFromNextTurn: outgoingBest(s, p, s.mySide, full ? 2 : 1),
        speedRelation: speedSummary(s, p) } };
  }).map(withSearch);
  // The active Pokémon is already listed in `team`, so point at it rather than repeating the whole entry.
  const side = (v: SideState) => ({ activeIndex: v.team.findIndex(p => p.id === v.activeId),
    team: v.team.map(compactPokemon), remaining: remainingPokemon(v), hazards: v.hazards, conditions: v.conditions,
    identityUncertain: v.identityUncertain });
  // The Pokémon we are facing decides this turn; the bench decides later ones. Summarising the bench in a
  // line each is what buys the room to keep switch matchups and turn order at every detail level, which is
  // what a turn actually turns on.
  const opponentInference = theirs && !theirs.identityUncertain ? theirs.team.filter(p => !minimal || !p.fainted).map(p => {
    const { setPriors, possibleUnrevealedMoves, mostLikelyCandidates, ...summary } = inferOpponent(p).summary;
    if (p.id !== theirs.activeId) {
      // Deductions stay even on the bench: they are what was learned, and they cost almost nothing.
      return { slot: p.slot, species: p.species, status: summary.status, roles: summary.roles,
        sampledCandidateCount: summary.sampledCandidateCount,
        candidateProbabilityMassBeforeEvidence: summary.candidateProbabilityMassBeforeEvidence,
        evidence: compactEvidence(summary.evidence), evidenceContradictions: summary.evidenceContradictions,
        ...(full && setPriors ? { setPriors: trimPriors(setPriors, 6) } : {}) };
    }
    // For the Pokémon we are facing, the surviving joint sets say everything the coarser per-role
    // frequencies would, and say it exactly. `setPriors.moves` already covers the movepool.
    return { slot: p.slot, species: p.species, ...summary, evidence: compactEvidence(summary.evidence),
      candidatesExcludedByEvidence: p.inference?.excluded.length ?? 0,
      mostLikelyCandidates: trim(mostLikelyCandidates, full ? 3 : 2),
      possibleUnrevealedMoves: trim(possibleUnrevealedMoves, full ? 12 : 8) };
  }) : [];
  // Only on a move turn: on a forced replacement we are not choosing an attack, so there is nothing to aim.
  // Trapped by our ability, they can leave only through a pivot move, so their bench is not a live reply otherwise.
  const trapped = !forced && me && foe && s.mySide ? trappedByUs(me, foe) : null;
  const theySwitch = !forced && me && s.mySide && !minimal && !(trapped && !trapped.exceptThrough)
    ? switchPunish(s, me, s.mySide, me.knownMoves.length ? me.knownMoves : me.revealedMoves, full ? 3 : 2) : null;
  // What they have actually done with their switches, kept at every detail level: minimal drops ifTheySwitch, and a
  // switching opponent is exactly when the Pokémon our move lands on is not the one in front of us.
  const flinch = !forced && me && s.mySide ? flinchRisk(s, me, s.mySide) : null;
  // What the current pairing has actually done since it met, which shows a stall the per-turn numbers hide: their
  // Roost, Leftovers or our lost turns outpacing our damage, turn after turn.
  const soFar = !forced && me && foe ? matchupProgress(s, me, foe) : null;
  const entered = typeof me?.activeSinceTurn === 'number' && Number.isFinite(me.activeSinceTurn) ? me.activeSinceTurn : null;
  const ourBalance = me && s.mySide ? residuals(s, me, s.mySide)?.perTurnPercentOfMaxHP : undefined;
  // The pessimistic end of our own healing, so survival is a floor rather than a hope.
  const ourResidual = Array.isArray(ourBalance) ? ourBalance[0]! : ourBalance ?? 0;
  const decisionActions = actions.map(a => {
    const estimate = 'damageRange' in a ? a.damageRange : null;
    const superior = estimate && !estimate.substituteDamage ? actions.find(b => b.id !== a.id &&
      'damageRange' in b && b.damageRange && !b.damageRange.substituteDamage &&
      b.id.includes('terastallize') === a.id.includes('terastallize') &&
      b.damageRange.hp[0] > estimate.hp[1]) : undefined;
    // A comparison, not strict dominance: priority, self-drops and secondary effects remain real tradeoffs.
    const strongerThanPriority = estimate?.conditionalKO === 'none-sampled' && !estimate.substituteDamage &&
      'priority' in a && (a.priority ?? 0) > 0 ? actions.filter(b =>
        b.kind === 'move' && 'priority' in b && (b.priority ?? 0) < (a.priority ?? 0) &&
        b.id.includes('terastallize') === a.id.includes('terastallize') &&
        'damageRange' in b && b.damageRange && !b.damageRange.substituteDamage &&
        b.damageRange.hp[0] > estimate.hp[1])
      .sort((b, c) => (('damageRange' in c ? c.damageRange?.hp[0] : 0) ?? 0) -
        (('damageRange' in b ? b.damageRange?.hp[0] : 0) ?? 0))[0] : undefined;
    const priorityThreat = strongerThanPriority && a.id.includes('terastallize') && me && s.mySide
      ? incomingThreats(s, me, s.mySide, threatLimit, input.request?.active?.[0]?.canTerastallize) : staying;
    const order = 'turnOrder' in a ? a.turnOrder?.order : undefined;
    // Which of their attacks would knock us out first, named with whether each has been seen: a revealed Thunderbolt and
    // an Explosion carried by half their sets read the same without it. A Tera version counts what that Tera changes.
    const shield = 'defensiveTera' in a ? a.defensiveTera : undefined;
    const killers = !staying || a.kind !== 'move' || order !== 'theirs-first' || shield?.stopsItFromKnockingUsOut ? []
      : [...staying.damagingMoves.filter(m => m.conditionalKO === 'all-sampled-rolls' && !shield?.stopsTheseFromKnockingUsOut?.includes(m.move))
        .map(m => m.revealed ? `${m.move} (revealed)` : `${m.move} (unrevealed${m.priorProbability === null ? '' : `, in ${Math.round(m.priorProbability * 100)}% of sets`})`),
        ...(shield?.letsTheseKnockUsOut ?? []).map(m => `${m} (only with this Tera)`)];
    const cannotAct = !forced && killers.length > 0;
    return { ...a,
      ...(strongerThanPriority && 'damageRange' in strongerThanPriority ? { priorityTradeoff: {
        priorityDoesNotKO: true, strongerAction: strongerThanPriority.id,
        strongerDamagePercent: strongerThanPriority.damageRange!.percentOfMaxHP,
        strongestModeledIncomingPercent: priorityThreat?.worstCasePercentOfMaxHP ?? null,
        survivesModeledSingleHit: me?.hpPercent != null && priorityThreat?.worstCasePercentOfMaxHP != null
          ? me.hpPercent > priorityThreat.worstCasePercentOfMaxHP : null,
      } } : {}),
      ...(!minimal && superior && 'damageRange' in superior ? { strongerImmediateDamageAvailable: {
        action: superior.id, hp: superior.damageRange!.hp,
      } } : {}),
      ...(cannotAct ? { executionRisk: `If the opponent uses ${killers.join(' or ')}, we move second and faint before this move or any advertised benefit occurs. Not a prediction of their choice; survival effects may intervene.` } : {}),
    };
  });
  const hoisted = hoistSharedActionFields(decisionActions);
  const present = {
    switching: actions.some(a => 'switchIn' in a),
    threats: !!staying || actions.some(a => (a as { switchIn?: { incomingThreat?: unknown } }).switchIn?.incomingThreat),
    order: !!relation || actions.some(a => 'turnOrder' in a),
    wasted: actions.some(a => 'wouldAccomplishNothing' in a || 'effectLimited' in a || 'targetSubstitute' in a),
    stalling: actions.some(a => 'protect' in a || 'pp' in a) || !minimal,
    evidence: opponentInference.some(p => p.evidence.length > 0 || p.evidenceContradictions > 0),
    planning: !minimal,
    prediction: !!theySwitch,
    risk: !!(me && statusRisk(me, s.turn)) || !!(foe && statusRisk(foe, s.turn)) ||
      actions.some(a => 'conditionalDamage' in a || 'suckerPunch' in a || 'activatesTheirItem' in a || 'triggersTheirAbility' in a || 'encore' in a) ||
      !!(me && s.mySide && encoreLock(s, me, s.mySide)),
  };
  return { format: s.format, turn: s.turn, ourSide: ours ? side(ours) : null, opponent: theirs ? side(theirs) : null,
    field: s.field, effectStartTurns: s.effectStartTurns,
    actions: collapseTeraVariants(hoisted.actions),
    ...(hoisted.shared ? { sharedByEveryActionBelow: hoisted.shared } : {}),
    // Always present, so the shape does not change between request kinds. When staying in is not on offer
    // the reason sits beside these nulls, which is what stops a null from reading as an absence of danger.
    stayingInIsNotAnOption: reviving ? 'Select a fainted teammate to revive on the bench; this is not switching our active Pokémon.' : forced
      ? (me?.fainted
        ? `${me.species} has fainted, so every option here is a replacement and none of them costs a turn`
        : 'our Pokémon is already leaving the field; an opposing action may still be pending after this forced pivot')
      : null,
    speedRelation: relation,
    switching: { selectingRevival: reviving, forcedReplacement: forced && !reviving, legalSwitchCount: input.legalActions.filter(a => a.kind === 'switch').length, trapped: input.request?.active?.[0]?.trapped ?? null,
      ...(!forced && me && s.mySide ? { onSuccessfulSwitchOut: switchRelief(s, me, s.mySide) } : {}) },
    incomingThreatIfWeStayIn: staying,
    ...(teraLeft.length ? { teraIsAlsoNeededBy: teraLeft } : {}),
    ...(aimed && input.legalActions.some(a => a.kind === 'switch') ? { switchTurnAttack: aimed,
      ...(foe && asleepChanceOfMove(foe, aimed) !== null ? { whileAsleepItComesAtMostPercent: asleepChanceOfMove(foe, aimed) } : {}) } : {}),
    ...(foe && !foe.fainted && theirs && !theirs.identityUncertain ? { opponentBoostsOnKnockout: knockoutBoosts(foe) ?? undefined } : {}),
    // Only worth stating when effective speed could not be computed at all.
    ...(relation?.relation === 'unknown' ? { ourBoostedSpeedBeforeOtherModifiers: me?.stats.spe ? boostedStat(me.stats.spe, me.boosts.spe ?? 0) : null } : {}),
    // Switching forfeits this turn's action; staying in does not. Both take whatever is incoming.
    // A missing entry turn (a reconnect, or a state recorded before it was tracked) stays unknown, not NaN.
    turnsOurActiveHasBeenIn: forced ? null : entered === null ? null : Math.max(1, s.turn - entered),
    ourActiveJustSwitchedIn: !forced && entered !== null && s.turn - entered <= 1,
    // End-of-turn healing and chip decide whether a Pokémon climbs out of a damage range or slides into one.
    residualsPerTurn: minimal ? null : { ours: me && s.mySide ? residuals(s, me, s.mySide) : null,
      opponent: foe && theirs ? residuals(s, foe, s.mySide === 'p1' ? 'p2' : 'p1') : null },
    survivalIfWeStayIn: forced || !me || !staying || staying.protectedBySubstituteThisHit ? null
      : survivalTurns(me.hpPercent, staying.worstCasePercentOfMaxHP, ourResidual),
    opponentMovePP: foe && !minimal ? opponentPP(s, foe, me) : null,
    // An ability that changes damage once its holder is low moves the estimate as the battle goes on.
    pinchAbilities: minimal ? null : {
      ours: me ? pinchAbility(me) : null,
      opponent: foe ? pinchAbilityRisk(foe, inferOpponent(foe).candidates) : null,
    },
    // Zero to Hero makes switching out a gain rather than a cost, which every other field here assumes it is not.
    switchingOutTransformsOurActive: me && s.mySide && !minimal ? switchOutForme(s, me, s.mySide) : null,
    ...(trapped ? { theyCannotSwitchOut: trapped } : {}),
    // A Choice item makes the opponent's next action known, which is the most exploitable public read there is.
    opponentChoiceLock: foe ? choiceLock(foe) : null,
    // Our own lock is private but just as binding: it is why only one move is on offer, and switching releases it.
    ...(ourLock ? { ourChoiceLock: ourLock } : {}),
    // Recovery already set and waiting, which is what makes passing a Wish or a Healing Wish possible.
    recoveryWaitingOnOurSide: s.mySide ? pendingRecovery(s, s.mySide) : null,
    recoveryWaitingOnTheirSide: s.mySide ? pendingRecovery(s, s.mySide === 'p1' ? 'p2' : 'p1') : null,
    // Encore removes our moves without removing them from the battle, which a short action list hides.
    weAreEncored: me && s.mySide ? encoreLock(s, me, s.mySide) : null,
    ...(() => { const threat = me && s.mySide && !forced ? encoreThreat(s, me, s.mySide) : null; return threat ? { theyMayEncoreUsFirst: threat } : {}; })(),
    // The chance the move we pick simply does not happen, which every projection above assumes away.
    ourTurnMayBeLost: me ? statusRisk(me, s.turn) : null,
    ...(flinch ? { flinchRisk: flinch } : {}),
    ...(soFar ? { thisMatchupSoFar: soFar } : {}),
    // Slow Start halves Attack and Speed for five turns from entry: theirs is a window to hit now, ours a clock to run out.
    ...((() => { const ours = !forced ? slowStartTurnsLeft(s, me) : null, theirs = slowStartTurnsLeft(s, foe);
      return ours || theirs ? { slowStartTurnsLeft: { ...(ours ? { ours } : {}), ...(theirs ? { theirs } : {}) } } : {}; })()),
    theirTurnMayBeLost: foe ? statusRisk(foe, s.turn) : null,
    // Past the pair on the field: who on our side answers what is left of theirs.
    endgame: endgameSummary,
    // The Pokémon in front of us is not always the one our move lands on: they may switch as we attack.
    ifTheySwitch: theySwitch,
    ...(pattern ? { opponentSwitching: pattern } : {}),
    // Set whenever damage and threat estimates could not be computed at all this turn.
    estimatesUnavailable: me && foe ? unsupportedReason(s, me, foe) : 'no active Pokémon on both sides',
    // How the evidence was read, said once rather than on every observation: that note was the largest repeated text.
    ...(opponentInference.some(p => p.evidence.length) ? { evidenceMethod } : {}),
    opponentInference: minimal ? opponentInference.map(p => ({ species: p.species, sampledCandidateCount: p.sampledCandidateCount, evidenceContradictions: p.evidenceContradictions })) : opponentInference,
    omittedForBudget: minimal ? ['detailed opponent set summaries', 'residual and PP analysis', 'status/weather/form projections'] : [],
    glossary: glossary(detail, present),
    uncertainties: s.uncertainties };
}

type Present = { switching: boolean; threats: boolean; order: boolean; wasted: boolean; stalling: boolean; evidence: boolean; planning: boolean; prediction: boolean; risk: boolean };
/**
 * Explains what this payload actually contains; definitions for absent sections would waste the budget.
 * Below full detail it collapses to the caveats that change how a number should be read, because the
 * alternative is dropping switch matchups from a crowded turn, and those decide the turn.
 */
function glossary(detail: Detail, present: Present) {
  const when = (flag: boolean, entries: Record<string, string>) => (flag ? entries : {});
  if (detail !== 'full') {
    return { detail,
      essential: 'Every figure is conditional. Damage envelopes assume the current defender, no opposing action, switch or Tera, and a noncritical single hit; conditional KO is damage only, before Focus Sash, Sturdy, accuracy and healing. Set frequencies describe how sets are generated, never what the opponent will choose. A null estimate means it could not be computed, never that there is no danger — estimatesUnavailable and damageUnavailable give the reason. A switch forfeits this turn, so a switch target\'s damage is next turn at the earliest and is not comparable with a move\'s. Candidate coverage is near-complete, not exhaustive, and an absent warning is not a promise a move will work.',
      activeIndex: 'Each side\'s position in its own team array of the Pokémon on the field; -1 means none known.' };
  }
  return {
    detail,
    reading: 'activeIndex is each side\'s position in its own team array of the Pokémon on the field; -1 means none known. A null estimate means it could not be computed, never that there is no danger — estimatesUnavailable gives the state-wide cause, damageUnavailable a move-specific one.',
    source: 'Official Gen 9 Random Battle role pools plus the pkmn/randbats snapshots in src/data, the public feed behind Showdex and the Randbats Tooltip. Candidate sets are the complete combinations that dataset recorded over 600,000 generation draws: near-complete coverage, not guaranteed exhaustive.',
    probabilities: 'Every frequency describes how sets are generated, never what the opponent will choose to do with one. A candidate\'s probability is its share of recorded draws renormalised over the sets still compatible; candidateProbabilityMassBeforeEvidence is how much of the original distribution survives what has been revealed. setPriors is coarser — marginal per-role frequencies, so its moves are not independent and its items can sum to under one, with noItemProbability holding the rest.',
    damage: 'Conditional envelopes over candidate sets: current defender, no opposing action, switch or Tera, noncritical single hit, public HP rounding. Listed base power and priority are printed values; type chart, base STAB and field factors are components of the estimate and appear only when no envelope could be computed.',
    conditionalKO: 'Damage only, before Focus Sash, Sturdy, accuracy and healing, against the target\'s whole possible current-HP interval. koProbability appears only where candidate sets disagree: regardlessOfRoll is the mass killing on every roll, onSomeRoll the mass that can kill at all, renormalised over the sets the calculator could model — coveredProbabilityMass says when that was not all of them.',
    ...when(present.threats, { incomingThreat: 'What the opposing active Pokémon could do to that target, over its revealed moves plus the most frequent moves of its compatible roles. Worst case across sets, not a prediction. otherPlausibleMoves lists non-damaging and unmodelled possibilities with no estimate.' }),
    ...when(present.switching, { switching: 'Anything in sharedByEveryActionBelow was carried identically by every action that has it and is stated once instead of repeated; read it as present on each of them. An action carrying sameAsWithoutTerastallising is identical to the action it names except for the fields written out beside it, which are what Terastallising changes; fieldsThatNoLongerApply lists anything the base action had that this one does not, and nothingModelledChangesByTerastallising means Terastallising changes nothing we can measure here, so spending it buys no stated gain. It is a full, separately selectable action. A switch forfeits this turn: its ourBestDamageFromNextTurn is what that Pokémon could do only once it has survived a turn, so it is not comparable with a move\'s damageRange. incomingThreatIfWeStayIn is the comparison instead. wasActiveTurnsAgo says how recently a target was on the field; switchIn.asleep gives a sleeping target\'s chance of waking on its first turn back, since sleep counts down only on the field and a Pokémon withdrawn right after it fell asleep loses at least that turn. knockedOutOnEntry marks a replacement that every sampled set knocks out as it comes in: a sacrifice cost to weigh, which nothing skips for you. wouldUndoLastSwitch marks a switch made by a Pokémon that only just arrived and still faces the opponent it was sent in to answer: a second turn spent on a matchup already chosen, which is skipped in favour of the next-ranked action unless the opponent has changed or staying in is a certain knockout. turnsOurActiveHasBeenIn and ourActiveJustSwitchedIn say whether switching would immediately undo the last switch, spending a second turn to leave a position just entered. When stayingInIsNotAnOption is set no option costs a turn, and order and incoming damage are per switch target. Matchups include our Intimidate on arrival (ourIntimidateOnEntry) but no other entry ability or pursuit-style punishment. They are also against the Pokémon currently out, and the opponent may switch on the same turn: theirBenchThatBeatsIt names the revealed Pokémon that would win the matchup instead, taken from the same coarse read as endgame. Hazard exposure is separate and conditional on grounding, Boots, abilities and suppression.' }),
    ...when(present.order, { turnOrder: 'Effective speed includes speed modifiers; Trick Room reverses which of two equal-priority moves resolves first without changing speeds. A move is first only when no candidate opposing move outranks it and it wins any equal-priority race, and the reverse for the opponent; anything else is uncertain, with the moves that would resolve first named. A Substitute changes no speeds, so order is still computed behind one.' }),
    ...when(present.wasted, { wasted: 'wouldAccomplishNothing gives reasons a move does nothing, or nothing new: `certain` from established facts — the target\'s types and status, our HP and boosts, the field, the side conditions — and `possible` from a hidden set or a Pokémon not yet revealed, with its chance. effectLimited names a partial loss of value, such as Magic Guard blocking burn chip while the Attack drop still works. targetSubstitute appears when the opposing Pokémon is behind one and the move is aimed at it: absorbed-entirely means nothing reaches the holder, damages-substitute-first means the damage only breaks the Substitute, bypasses-substitute means it ignores it. Neither list is exhaustive, so silence is not a promise the move works.' }),
    ...when(present.stalling, { stalling: 'residualsPerTurn is the end-of-turn HP change as a percentage of max HP, which is what decides whether a Pokémon climbs out of a damage range; the opponent\'s item is often unknown, so theirs can be a range. survivalIfWeStayIn counts how many more turns our Pokémon lasts against the worst incoming damage once that healing is counted, using the pessimistic end of ours — a floor, not a prediction, and it assumes the opponent keeps using its hardest hitting sampled move. recoveryWaitingOnOurSide reports a Wish or Healing Wish already set: a Wish heals whoever holds the slot when it lands, so switching after casting it passes the healing to the Pokémon coming in, and a Healing Wish or Lunar Dance fully restores whatever comes in after its caster faints. Toxic damage grows by a sixteenth for every turn it has been in place, and residualsPerTurn counts the turns rather than assuming the first. opponentMovePP counts observed uses against full PP Ups: an upper bound on what remains, since turns we did not see are not counted. A Substitute move reports the shell\'s HP against their best sampled hit, because one that breaks at once has bought a single blocked hit while one that holds blocks status and stat changes outright; Shed Tail is the same trade at double the price and hands the shell to the Pokémon coming in. A protecting move reports successChance, which falls to a third of itself for each consecutive protect, and endOfTurnSwingPercentOfMaxHP, the worst-case net gain from spending a turn taking nothing; the opponent still spends the PP of whatever it was blocked doing.' }),
    ...when(present.planning, { planning: 'theirRemainingPokemon, on a Speed boost, names their revealed bench Pokémon the boost lets us outspeed and the share of the unseen Random Battle pool we outspeed before and after, since the boost stays for whatever comes in next. afterItsStatChangeIfItHappens is the same projection for a stat change that only sometimes happens, such as Diamond Storm\'s +2 Defense half the time, so it is a chance and not a plan. afterItsStatChange carries wastedBecauseWeAreKnockedOutFirst when every sampled attack knocks us out this turn, because stat changes are lost with the Pokémon and a stat move deals no damage to prevent that; a status instead survives its user, so it only fails when we move second into the same knockout. Otherwise it projects a move\'s own stat change one step — a Dragon Dance that wins the matchup, or a Draco Meteor that weakens the next hit — giving our best damage and speed relation once it lands, against the Pokémon currently out and with no account of what the opponent does meanwhile. ifTheStatusLands does the same for a status, since a burn halves physical damage and paralysis halves speed. defensiveTera reports what our own Tera changes about the damage we take, which is the half of Tera easiest to miss; stopsTheseFromKnockingUsOut names attacks it takes a knockout away from even when a rarer, unaffected hit stays the worst, and an executionRisk beside it then applies only to the attacks not named; letsTheseKnockUsOut names attacks the new type turns into a knockout, which outweighs a lower worst hit that still knocks us out. hitsItTakesToKnockUsOutBecomes and wasHitsBefore count their worst hit from our current HP: a Tera that does not stop this turn\'s hit can still buy the turn after it. switchingOutTransformsOurActive appears when our Pokémon transforms by leaving the field, which Zero to Hero does: switching is then a gain rather than the cost every other field treats it as, and the Pokémon returns permanently stronger. changesOurForme appears on a move that changes the user\'s form: it gives the typing and stats it becomes, and whether that reaches the new typing without spending the one Tera available, since the move otherwise looks like an ordinary attack. hazards price a hazard move by how many Pokémon are still to come in and what each revealed one takes on entry, collected every time they switch. takesNothingFromIt and takesNothingBecauseOfOurAbility are taken from the calculator\'s own verdict, so an attacker that reads through abilities cannot turn either into a false promise. pinchAbilities name an ability that changes damage once its holder is low, which moves an estimate taken now. endgame is a coarse read past the active pair: best move each way from full health, turns to knock out, faster side winning the race, ignoring switching, hazards, status and one-shot items, and only for Pokémon that have been revealed. opponentChoiceLock names the move a Choice item would have locked them into.' }),
    ...when(present.prediction, { ifTheySwitch: 'What each of our moves would do to the Pokémon they might bring in instead of to the one in front of us, which is the read behind choosing a move the current target shrugs off. intimidatesUsOnArrival: its Intimidate lowers our Attack first, already included in the damage. likelyToComeIn ranks their revealed bench by how much it threatens our active Pokémon less how much our best move hurts it — the trade a switch is made on, and a matchup ranking rather than a prediction of their choice. ourMoveDamage is against that Pokémon\'s current HP and excludes the entry hazards it would take on the way in, so it is a floor. Unrevealed Pokémon cannot be ranked and are absent, and they may also simply stay in, in which case the damageRange on each action is what applies. theyCannotSwitchOut means our trapping ability holds them in: the Pokémon in front of us is the one our move hits, unless it leaves through a move named in exceptThrough.' }),
    ...when(present.risk, { risk: 'ourTurnMayBeLost and theirTurnMayBeLost give the chance a Pokémon loses its turn outright to the status it carries, which every other projection assumes away. Sleep is the one that narrows: it costs one to three turns fixed when it landed, so the first attempt never wakes, each turn already lost rules out a shorter duration, and after three the next attempt always succeeds, while Rest is exactly two turns and no gamble at all. Paralysis is a flat quarter, freeze a thawing fifth, confusion a third. conditionalDamage carries the moves whose damage is not computed from stats — Counter and Mirror Coat return twice the hit they absorb and fail outright if it does not land, Pain Split averages both current HP and is worthless while we are the healthier one. suckerPunch reports the share of the target\'s sampled moves that are attacks at all, since it fails against a status move or a switch; that share describes the movepool, not their choice. activatesTheirItem warns that an attack pays the target for landing: a super-effective hit that does not knock out a Weakness Policy holder hands it +2 Attack and +2 Special Attack. weAreEncored means our own moves have been replaced by one of them for up to three turns: the moves missing from this turn are not choices we declined, and switching is the only way out. encore, on a move, gives what Encore would lock the opponent into — three turns of whatever it just did, which is worth most when that was a status move.' }),
    ...when(present.evidence, { evidence: 'Observed turn order and observed damage eliminate candidate sets that could not have produced them, recorded with the counts before and after. Ruling out every remaining set is a contradiction, not a deduction — the model was wrong or the true set was never recorded — so nothing is eliminated and evidenceContradictions counts it. Modified items and abilities override a candidate\'s originals.' }),
  };
}
