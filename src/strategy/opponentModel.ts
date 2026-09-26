import { createHash } from 'node:crypto';
import type { BattleState, SideId } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { plausibleMoves } from './setPriors.js';
import { choiceLock } from './stalling.js';

export type Behaviour = 'attack' | 'recover' | 'setup' | 'switch' | 'other';
export interface ChoiceContext { actor: string; facing: string; hpBand: number; status: string | null; boosted: boolean; matchupKey?: string }
export interface ActionObservation extends ChoiceContext { turn: number; side: SideId; kind: Behaviour; destination?: string }
const band = (hp: number | null) => hp === null ? -1 : hp <= 35 ? 0 : hp <= 70 ? 1 : 2;
export function choiceContext(s: BattleState, side: SideId): ChoiceContext | null {
  const ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const p = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!p || !foe || p.fainted || foe.fainted || ours.identityUncertain || theirs.identityUncertain || p.transformedInto) return null;
  return { actor: p.id, facing: foe.id, hpBand: band(p.hpPercent), status: p.status,
    boosted: Object.values(p.boosts).some(x => x > 0),
    // Hashed: every logged snapshot carries up to 80 of these, and the field alone runs to hundreds of bytes.
    matchupKey: createHash('sha1').update(JSON.stringify([p.species, foe.species, p.terastallized && p.teraType, foe.terastallized && foe.teraType,
      p.item, foe.item, p.boosts, foe.boosts, s.field])).digest('hex').slice(0, 12) };
}
export function behaviourOf(moveName: string): Behaviour {
  const m = dex.moves.get(moveName);
  if (m.category !== 'Status') return 'attack';
  if (m.heal || ['rest', 'strengthsap', 'wish', 'painsplit'].includes(m.id)) return 'recover';
  if ((m.target === 'self' && m.boosts) || ['bellydrum', 'tidyup', 'geomancy', 'noretreat', 'clangoroussoul', 'filletaway'].includes(m.id)) return 'setup';
  return 'other';
}
/** Called moves, forced replacements and known locks are not preference evidence. */
export function recordChoice(s: BattleState, side: SideId, kind: Behaviour, destination?: string) {
  const c = s.turnContext?.[side], p = s.sides[side].team.find(p => p.id === c?.actor);
  if (!c || !p || s.turn < 1 || s.actionHistory?.some(x => x.turn === s.turn && x.side === side)) return;
  if (kind !== 'switch' && s.sides[side].activeId !== c.actor) return;
  if (kind !== 'switch' && (choiceLock(p)?.probability === 1 || Object.keys(p.volatiles).some(k => ['encore', 'mustrecharge'].includes(id(k))))) return;
  s.actionHistory = [...(s.actionHistory ?? []), { ...c, turn: s.turn, side, kind, ...(destination ? { destination } : {}) }].slice(-80);
}
/** Availability is a prior, not a choice prediction. Evidence decays and is conditioned on
 * matchup, HP, boosts and status, with eight prior observations to avoid overreacting. */
export function opponentModel(s: BattleState, ourSide: SideId) {
  const side = ourSide === 'p1' ? 'p2' : 'p1', c = choiceContext(s, side);
  const team = s.sides[side], foe = team.team.find(p => p.id === team.activeId);
  if (!c || !foe) return null;
  const counts: Record<Behaviour, number> = { attack: 0, recover: 0, setup: 0, switch: 0, other: 0 };
  const lock = choiceLock(foe);
  for (const m of plausibleMoves(foe)) {
    if ((foe.ppSpent?.[id(m.move)] ?? 0) >= dex.moves.get(m.move).pp * 8 / 5) continue;
    if (lock?.probability === 1 && id(m.move) !== id(lock.lockedInto)) continue;
    const kind = behaviourOf(m.move);
    counts[kind] += (m.priorProbability ?? 1) * (kind === 'recover' && (foe.hpPercent ?? 0) >= 90 ? 0.25 : 1);
  }
  const canSwitch = team.team.some(p => !p.fainted && p.id !== foe.id) || (team.teamSize ?? 6) > team.team.length;
  const totalMoves = Object.values(counts).reduce((a, b) => a + b, 0);
  counts.switch = canSwitch ? Math.max(0.25, totalMoves * 0.25) : 0;
  if (!totalMoves) counts.other = 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const prior = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, n / total])) as Record<Behaviour, number>;
  const observed: Record<Behaviour, number> = { attack: 0, recover: 0, setup: 0, switch: 0, other: 0 };
  const destinations = new Map<string, number>();
  let evidence = 0;
  for (const o of s.actionHistory ?? []) {
    if (o.side !== side || o.turn >= s.turn || o.actor !== c.actor || !prior[o.kind]) continue;
    const w = Math.exp(-(s.turn - o.turn) / 18) * (o.facing === c.facing ? 1 : 0.15) *
      (o.hpBand === c.hpBand ? 1 : 0.25) * (o.status === c.status ? 1 : 0.5) * (o.boosted === c.boosted ? 1 : 0.5) *
      (o.matchupKey === c.matchupKey ? 1 : 0.25);
    observed[o.kind] += w; evidence += w;
    if (o.destination && team.team.some(p => p.id === o.destination && !p.fainted && p.id !== foe.id)) {
      destinations.set(o.destination, (destinations.get(o.destination) ?? 0) + w);
    }
  }
  const probabilities = Object.fromEntries(Object.keys(prior).map(k => {
    const key = k as Behaviour;
    return [key, (prior[key] * 8 + observed[key]) / (8 + evidence)];
  })) as Record<Behaviour, number>;
  return { probabilities, evidence: Math.round(evidence * 100) / 100,
    likelySwitches: [...destinations].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([pokemon, weight]) => ({ pokemon, weight })),
    uncertain: true as const };
}
