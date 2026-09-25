import { afterEntry } from './entry.js';
import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { inferOpponent } from './inference.js';
import { plausibleMoves, type PlausibleMove } from './setPriors.js';
import { accumulate, dedupeCandidates, scenario, supportedMove } from './calcCore.js';
import type { Candidate } from './setTypes.js';
import { dex } from '../pokemon/data.js';
import { hitChancePercent } from '../pokemon/mechanics.js';
import { choiceLock } from './stalling.js';
import { absorbedBy } from './abilities.js';
import { behindSubstitute, intimidated, intimidateResponse, intimidates } from './intimidate.js';
const active = (s: BattleState, side: SideId) => s.sides[side].team.find(p => p.id === s.sides[side].activeId);
const other = (side: SideId): SideId => (side === 'p1' ? 'p2' : 'p1');
/** Sampled-set damage for one attacking move: the widest envelope over the sets still compatible with the evidence. */
function envelope(s: BattleState, attacker: PokemonState, defender: PokemonState, attackerSide: SideId, move: string,
  attackerSets: (Candidate | undefined)[], defenderSets: (Candidate | undefined)[], defenderTera?: string,
  attackerFor?: (set: Candidate | undefined) => PokemonState) {
  const rolls = [];
  const subs: NonNullable<ReturnType<typeof scenario>>[] = [];
  let maxHP = 0, attempted = 0;
  for (const a of attackerSets) for (const d of defenderSets) {
    attempted += (a?.probability ?? 1) * (d?.probability ?? 1);
    const r = scenario(s, attackerFor ? attackerFor(a) : attacker, defender, attackerSide, move, a, d, undefined, defenderTera);
    // Exactly one side is hidden, so its set carries the probability and the known side contributes one.
    if (r?.substitute) subs.push(r);
    if (r) { rolls.push({ ...r, probability: (a?.probability ?? 1) * (d?.probability ?? 1) }); maxHP = r.defenderMaxHP; }
  }
  const result = accumulate(rolls, defender, maxHP, attempted);
  return result ? { ...result, ...(subs.length ? { substitute: { damageHP: [Math.min(...subs.map(r => Math.min(r.substitute!.damageHP[0], r.substitute!.hpBefore[0]))), Math.max(...subs.map(r => Math.min(r.substitute!.damageHP[1], r.substitute!.hpBefore[1])))], breaksOnSomeModeledRoll: subs.some(r => r.substitute!.breaks !== 'no-rolls'), holderHPDamageThisHit: 0 } } : {}) } : null;
}
interface Estimate { mechanicsNotes?: string[]; move: string; percentOfMaxHP: [number, number]; conditionalKO: string; substitute?: { damageHP: number[]; breaksOnSomeModeledRoll: boolean; holderHPDamageThisHit: number }; koProbability?: { regardlessOfRoll: number; onSomeRoll: number } }
interface Threat extends Estimate { revealed: boolean; priorProbability: number | null; takesNothingBecauseOfOurAbility?: string; accuracyPercent?: number }
/** A knockout at every roll is only certain from a move that cannot miss; otherwise it is named with its accuracy. */
export function certainty(damaging: Threat[]): { knockoutIsCertain?: boolean; knockoutNeedsItToHit?: { move: string; accuracyPercent: number } } {
  const kos = damaging.filter(x => x.conditionalKO === 'all-sampled-rolls');
  if (!kos.length) return {};
  if (kos.some(x => x.accuracyPercent === undefined)) return { knockoutIsCertain: true };
  const likeliest = kos.reduce((a, b) => ((b.accuracyPercent ?? 0) > (a.accuracyPercent ?? 0) ? b : a));
  return { knockoutIsCertain: false, knockoutNeedsItToHit: { move: likeliest.move, accuracyPercent: likeliest.accuracyPercent! } };
}
const worstFirst = (a: Estimate, b: Estimate) => b.percentOfMaxHP[1] - a.percentOfMaxHP[1];
const strongestKO = (xs: Estimate[]) => xs.some(x => x.conditionalKO === 'all-sampled-rolls') ? 'all-sampled-rolls'
  : xs.some(x => x.conditionalKO === 'some-sampled-rolls') ? 'some-sampled-rolls' : 'none-sampled';
/**
 * How the opposing active Pokémon hits a target that is arriving rather than already out: a switch-in with
 * Intimidate lands it before the opposing move, so that hit comes from the lowered Attack, or from a raised one
 * where the set's ability turns it into a boost. Each sampled set answers for itself.
 */
function arrival(s: BattleState, target: PokemonState, targetSide: SideId, foe: PokemonState, sets: Candidate[]) {
  const coming = s.sides[targetSide].activeId !== target.id;
  const arriving = coming && intimidates(target);
  const responses = new Map(arriving ? sets.map(c => [c, intimidateResponse(foe.abilitySuppressed ? '' : foe.ability ?? c.ability,
    foe.item ?? c.item, behindSubstitute(foe))] as const) : []);
  const adjusted = new Map([...responses].map(([c, r]) => [c, intimidated(foe, r)] as const));
  // A Pokémon switching in takes the switch-turn hit as it arrives, which is exactly when Stakeout doubles it.
  const attackerFor = coming ? (c: Candidate | undefined) => ({ ...((c && adjusted.get(c)) || foe), stakeoutActive: true }) : undefined;
  return { responses, adjusted, attackerFor };
}

/**
 * One named opposing attack against `target`, over the sampled sets. A switch is usually made to absorb the
 * attack aimed at the Pokémon leaving, since the opponent chooses before it sees the switch, so this prices a
 * switch-in against that one move rather than against the worst the opponent could pick if it anticipated us.
 */
export function hitFrom(s: BattleState, target: PokemonState, targetSide: SideId, moveName: string) {
  target = afterEntry(s, target, targetSide);
  const foe = active(s, other(targetSide));
  if (!foe || foe.fainted || target.fainted || !supportedMove(moveName)) return null;
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  if (!sets.length) return null;
  const result = envelope(s, foe, target, other(targetSide), moveName, sets, [undefined], undefined, arrival(s, target, targetSide, foe, sets).attackerFor);
  return result ? { move: dex.moves.get(moveName).name, percentOfMaxHP: result.percentOfMaxHP, conditionalKO: result.conditionalKO } : null;
}

/**
 * What the opposing active Pokémon could do to `target` this turn: its revealed moves plus the most frequently
 * generated moves for its compatible roles, each over the sampled sets. Bounded work; conditional bounds only.
 */
export function incomingThreats(s: BattleState, target: PokemonState, targetSide: SideId, limit = 3, targetTera?: string) {
  target = afterEntry(s, target, targetSide);
  const foeSide = other(targetSide), foe = active(s, foeSide);
  if (!foe || foe.fainted) return null;
  if (target.fainted) return { attacker: foe.species, sampledSets: 0, worstCasePercentOfMaxHP: 0, conditionalKO: 'all-sampled-rolls', knockedOutByHazards: true, protectedBySubstituteThisHit: false, damagingMoves: [], otherPlausibleMoves: [], knockoutIsCertain: true as boolean, knockoutNeedsItToHit: undefined as { move: string; accuracyPercent: number } | undefined }; 
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  if (!sets.length) return null;
  const { responses, adjusted, attackerFor } = arrival(s, target, targetSide, foe, sets);
  const damaging: Threat[] = [];
  const others: (PlausibleMove & { category: string })[] = [];
  // A lock that is certain — a known Choice item, or the first turn of Outrage — leaves only the one move to price.
  const lock = choiceLock(foe);
  const plausible = plausibleMoves(foe);
  const locked = lock && lock.probability >= 1
    ? plausible.filter(m => dex.moves.get(m.move).id === dex.moves.get(lock.lockedInto).id) : null;
  const moves = locked ? (locked.length ? locked : [{ move: lock!.lockedInto, revealed: true, priorProbability: 1 }]) : plausible;
  for (const m of moves) {
    const result = supportedMove(m.move) ? envelope(s, foe, target, foeSide, m.move, sets, [undefined], targetTera, attackerFor) : null;
    // Only claimed where the calculator actually produced nothing, so an attacker's Mold Breaker,
    // which reads straight through an absorbing ability, cannot turn this into a false promise.
    const nothing = result?.percentOfMaxHP[1] === 0 && !result.substitute;
    const absorbed = nothing && !target.abilitySuppressed ? absorbedBy(target.ability ?? '', m.move) : null;
    // Damage and knockout labels assume the move lands; a move that can miss says how often it does.
    const accuracy = result ? hitChancePercent(m.move, s.field.weather, foe, target) : 100;
    if (result) damaging.push({ move: m.move, revealed: m.revealed, priorProbability: m.priorProbability,
      ...(accuracy < 100 ? { accuracyPercent: accuracy } : {}),
      ...(result.mechanicsNotes ? { mechanicsNotes: result.mechanicsNotes } : {}), percentOfMaxHP: result.percentOfMaxHP, conditionalKO: result.conditionalKO,
      ...(result.substitute ? { substitute: result.substitute } : {}),
      ...(absorbed ? { takesNothingBecauseOfOurAbility: absorbed } : {}),
      ...(result.koProbability ? { koProbability: result.koProbability } : {}) });
    else others.push({ ...m, category: dex.moves.get(m.move).category });
  }
  if (!damaging.length && !others.length) return null;
  damaging.sort(worstFirst);
  // Their Attack stage after our Intimidate, over the sampled sets, so the lowered numbers explain themselves.
  const stages = new Map<string, { theirAttackStage: number; probability: number; because?: string }>();
  const total = sets.reduce((n, c) => n + c.probability, 0);
  for (const [c, r] of responses) {
    const stage = adjusted.get(c)!.boosts.atk ?? 0, key = `${stage}|${r.because ?? ''}`;
    const row = stages.get(key) ?? { theirAttackStage: stage, probability: 0, ...(r.because ? { because: r.because } : {}) };
    row.probability += total > 0 ? c.probability / total : 0;
    stages.set(key, row);
  }
  return { attacker: foe.species, sampledSets: sets.length,
    ...(stages.size ? { ourIntimidateOnEntry: [...stages.values()].map(r => ({ ...r, probability: Math.round(r.probability * 1000) / 1000 }))
      .sort((a, b) => b.probability - a.probability) } : {}),
    worstCasePercentOfMaxHP: damaging[0]?.percentOfMaxHP[1] ?? null,
    ...(damaging.some(m => m.substitute) && damaging.every(m=>m.percentOfMaxHP[1]===0) ? { protectedBySubstituteThisHit: true, futureSafetyUnknown: 'The Substitute may break on this hit; zero holder damage is not a forecast for the following turn.' } : {}),
    conditionalKO: damaging.length ? strongestKO(damaging) : 'none-sampled',
    ...certainty(damaging),
    damagingMoves: damaging.slice(0, limit),
    otherPlausibleMoves: others.slice(0, limit + 1).map(m => ({ move: m.move, category: m.category, revealed: m.revealed, priorProbability: m.priorProbability })) };
}
/** Our own best sampled-set damage from `attacker` onto the opposing active, using our private move list. */
export function outgoingBest(s: BattleState, attacker: PokemonState, attackerSide: SideId, limit = 2) {
  attacker = afterEntry(s, attacker, attackerSide);
  const foe = active(s, other(attackerSide));
  if (attacker.fainted) return null;
  if (!foe || foe.fainted || attacker.fainted) return null;
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  if (!sets.length) return null;
  const results: Estimate[] = [];
  for (const name of attacker.knownMoves.length ? attacker.knownMoves : attacker.revealedMoves) {
    const move = dex.moves.get(name);
    if (!move.exists || !supportedMove(move.name)) continue;
    const result = envelope(s, attacker, foe, attackerSide, move.name, [undefined], sets);
    if (result) results.push({ move: move.name, percentOfMaxHP: result.percentOfMaxHP,
      conditionalKO: result.conditionalKO, ...(result.koProbability ? { koProbability: result.koProbability } : {}) });
  }
  if (!results.length) return null;
  results.sort(worstFirst);
  return { target: foe.species, sampledSets: sets.length, bestCasePercentOfMaxHP: results[0]!.percentOfMaxHP[1],
    conditionalKO: strongestKO(results), moves: results.slice(0, limit) };
}
