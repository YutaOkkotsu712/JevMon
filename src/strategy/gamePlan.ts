import { createHash } from 'node:crypto';
import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import type { DecisionInput } from '../decisions/DecisionProvider.js';
import type { Candidate } from './setTypes.js';
import { dex, id } from '../pokemon/data.js';
import { scenario } from './calcCore.js';
import { inferOpponent } from './inference.js';
import { afterEntry } from './entry.js';
import { afterTerastallizing } from './forme.js';
import { effectiveSpeed } from './speed.js';
import { residuals } from './residual.js';
import { hitChancePercent, healPercentNow } from '../pokemon/mechanics.js';
import { wakeChance } from './risk.js';
import { opponentModel } from './opponentModel.js';

const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, low = 0, high = 1) => Math.min(high, Math.max(low, n));
export interface MatchupPlan {
  foe: string; move: string; damage: [number, number]; incoming: [number, number];
  /** Coverage of bounded direct-attack races, NOT a calibrated battle win probability. */
  raceCoverage: [number, number]; hpNeeded: number; modelled: number;
}
export interface PokemonPlan {
  pokemon: string; species: string; hpAfterEntry: number; contribution: number;
  uniqueAnswers: string[]; matchups: MatchupPlan[];
  tera?: { type: string; gain: number; helpsAgainst: string[]; harmsAgainst: string[]; matchups: MatchupPlan[] };
}
export interface GamePlan {
  revision: string; turn: number; unseen: number; roles: PokemonPlan[];
  leadingCandidates: string[]; threats: string[]; teraAvailable: boolean;
  preferredTera: string | null; opponent: ReturnType<typeof opponentModel>;
  limitations: string;
}

/** Fixed quantiles bound cost while retaining probability weights. The original candidate
 * distribution is never mutated. A broad range of sets remains explicit uncertainty. */
function samples(sets: Candidate[], n = 4): { set: Candidate; weight: number }[] {
  const total = sets.reduce((v, c) => v + c.probability, 0);
  if (!(total > 0)) return [];
  if (sets.length <= n) return sets.map(set => ({ set, weight: set.probability / total }));
  const drawn = new Map<Candidate, number>();
  for (let i = 0; i < n; i++) {
    let x = total * (i + 0.5) / n;
    const set = sets.find(c => (x -= c.probability) <= 0) ?? sets.at(-1)!;
    drawn.set(set, (drawn.get(set) ?? 0) + 1 / n);
  }
  return [...drawn].map(([set, weight]) => ({ set, weight }));
}
/** Attacks that can be repeated until the race is won. Explosion and Final Gambit end their user: a trade, which made
 * Golem an answer to whatever its Explosion knocked out. */
function usable(p: PokemonState) {
  return (p.knownMoves.length ? p.knownMoves : p.revealedMoves).filter(m => {
    const move = dex.moves.get(m);
    return move.exists && move.category !== 'Status' && !move.selfdestruct && (p.movePP?.[move.id]?.remaining ?? 1) > 0 &&
      !(Object.keys(p.volatiles).some(k => id(k) === 'disable') && Object.values(p.volatiles).some(v => id(v.data) === move.id));
  });
}
function readiness(p: PokemonState) {
  if (p.status === 'par') return 0.75;
  if (p.status === 'frz') return 0.2;
  if (p.status === 'slp') {
    const moves = p.knownMoves.map(id);
    const talk = moves.includes('sleeptalk') && (p.movePP?.sleeptalk?.remaining ?? 1) > 0;
    return talk ? Math.max(wakeChance(p), 0.33) : wakeChance(p);
  }
  return 1;
}
/** Compare one fixed move across hidden sets, rather than letting us magically know which
 * move is best inside each world. Free entry includes hazards; voluntary entry costs are
 * priced separately by the action scorer. Opponent Tera/recovery/RNG can upset these races. */
function matchup(s: BattleState, me: PokemonState, foe: PokemonState, side: SideId,
  sets: { set: Candidate; weight: number }[], tera?: string): MatchupPlan | null {
  const q = tera ? afterTerastallizing(me, tera) : me;
  const mine = usable(q), opposingSide = side === 'p1' ? 'p2' : 'p1';
  if (!mine.length || q.hpPercent === null || foe.hpPercent === null || q.fainted) return null;
  const net = residuals(s, q, side)?.perTurnPercentOfMaxHP ?? 0;
  const chip = Math.max(0, -(Array.isArray(net) ? net[0]! : net));
  const incoming = sets.map(({ set, weight }) => {
    const moves = [...new Set([...foe.revealedMoves, ...set.moves])].filter(m => dex.moves.get(m).category !== 'Status' &&
      (foe.ppSpent?.[id(m)] ?? 0) < dex.moves.get(m).pp * 8 / 5);
    const hits = moves.flatMap(move => {
      const r = scenario(s, foe, q, opposingSide, move, set, undefined, undefined, tera);
      return r ? [{ move, min: r.min / r.defenderMaxHP * 100, max: r.max / r.defenderMaxHP * 100 }] : [];
    });
    return { set, weight, hits };
  });
  let best: MatchupPlan | null = null;
  for (const move of mine) {
    let low = 0, high = 0, modelled = 0, need = 0;
    const outs: number[] = [], ins: number[] = [];
    for (const { set, weight, hits } of incoming) {
      const r = scenario(s, q, foe, side, move, undefined, set, tera);
      if (!r || !hits.length) continue;
      const min = r.min / r.defenderMaxHP * 100, max = r.max / r.defenderMaxHP * 100;
      outs.push(min, max); ins.push(...hits.flatMap(h => [h.min, h.max])); modelled += weight;
      const a = effectiveSpeed(s, q, side), b = effectiveSpeed(s, foe, opposingSide, set);
      const required = (damage: number, worst: boolean) => {
        if (damage <= 0) return { needed: 1000, turns: 1000 };
        const turns = Math.max(r.endures ? 2 : 1, Math.ceil(foe.hpPercent! / damage));
        let needed = 0;
        for (const h of hits) {
          const priority = dex.moves.get(move).priority - dex.moves.get(h.move).priority;
          const faster = priority ? priority > 0 : a !== null && b !== null && a !== b
            ? s.field.trickRoom ? a < b : a > b : !worst;
          const attacks = turns - (faster ? 1 : 0);
          needed = Math.max(needed, attacks * (worst ? h.max : h.min) + Math.max(0, turns - 1) * chip);
        }
        return { needed, turns };
      };
      const pessimistic = required(min, true), optimistic = required(max, false);
      const pp = q.movePP?.[id(move)]?.remaining ?? 16;
      const accuracy = hitChancePercent(move, s.field.weather, q, foe) / 100;
      const heal = Math.max(0, ...[...foe.revealedMoves, ...set.moves].map(m => healPercentNow(m, s.field.weather) ?? 0));
      const healFirst = dex.moves.get(move).priority <= 0 && (a === null || b === null ||
        (s.field.trickRoom ? b <= a : b >= a));
      const stalling = heal >= max && foe.hpPercent > max ||
        heal > 0 && healFirst && foe.hpPercent <= max && Math.min(100, foe.hpPercent + heal) > max;
      const recoil = dex.moves.get(move).recoil;
      const recoilCost = recoil ? (foe.hpPercent / 100 * r.defenderMaxHP * recoil[0] / recoil[1]) / r.attackerMaxHP * 100 : 0;
      const enough = (x: { needed: number; turns: number }) => x.turns <= pp && x.turns <= 4 && q.hpPercent! > x.needed + recoilCost;
      if (!stalling && enough(pessimistic)) low += weight * accuracy ** pessimistic.turns * readiness(q) ** pessimistic.turns;
      if (enough(optimistic)) high += weight * accuracy ** optimistic.turns * readiness(q) ** optimistic.turns * (stalling ? 0.25 : 1);
      need += weight * Math.min(101, pessimistic.needed + recoilCost + 1);
    }
    if (!modelled) continue;
    const row: MatchupPlan = { foe: foe.id, move, damage: [round(Math.min(...outs)), round(Math.max(...outs))],
      incoming: [round(Math.min(...ins)), round(Math.max(...ins))],
      raceCoverage: [round(low), round(Math.max(low, high))], hpNeeded: round(need / modelled), modelled: round(modelled) };
    if (!best || row.raceCoverage[0] + row.raceCoverage[1] > best.raceCoverage[0] + best.raceCoverage[1] ||
        row.raceCoverage[0] + row.raceCoverage[1] === best.raceCoverage[0] + best.raceCoverage[1] && row.damage[0] > best.damage[0]) best = row;
  }
  return best;
}
const strength = (m: MatchupPlan) => 0.7 * m.raceCoverage[0] + 0.3 * m.raceCoverage[1];

/** No retained favourite or turn-only cache: every request is assessed from its complete
 * current snapshot, including same-turn updates, PP, hazards, Tera, status and new reveals. */
export function buildGamePlan(input: DecisionInput): GamePlan | null {
  const s = input.state, side = s.mySide;
  if (!side) return null;
  const ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  if (ours.identityUncertain || theirs.identityUncertain) return null;
  const foes = theirs.team.filter(p => !p.fainted && p.hpPercent !== null);
  const sets = new Map(foes.map(p => [p.id, samples(inferOpponent(p).candidates)]));
  const teraAvailable = !ours.team.some(p => p.terastallized) &&
    (input.request?.forceSwitch?.[0] || !input.request || !!input.request.active?.[0]?.canTerastallize);
  const roles: PokemonPlan[] = ours.team.filter(p => !p.fainted && p.hpPercent !== null).map(p => {
    const q = afterEntry(s, p, side);
    const matchups = foes.flatMap(foe => {
      const m = matchup(s, q, foe, side, sets.get(foe.id)!); return m ? [m] : [];
    });
    const withTera = teraAvailable && p.teraType && !q.fainted ? foes.flatMap(foe => {
      const m = matchup(s, q, foe, side, sets.get(foe.id)!, p.teraType!); return m ? [m] : [];
    }) : [];
    const delta = (m: MatchupPlan) => strength(m) - strength(matchups.find(x => x.foe === m.foe) ?? { ...m, raceCoverage: [0, 0] });
    return { pokemon: p.id, species: p.species, hpAfterEntry: round(q.hpPercent ?? 0),
      contribution: round(matchups.reduce((n, m) => n + strength(m), 0) / Math.max(1, foes.length)), uniqueAnswers: [], matchups,
      ...(withTera.length ? { tera: { type: p.teraType!, gain: round(withTera.reduce((n, m) => n + delta(m), 0) / Math.max(1, foes.length)),
        helpsAgainst: withTera.filter(m => delta(m) >= 0.15).map(m => m.foe),
        harmsAgainst: withTera.filter(m => delta(m) <= -0.15).map(m => m.foe), matchups: withTera } } : {}) };
  });
  const threats: string[] = [];
  for (const foe of foes) {
    const answers = roles.filter(p => (p.matchups.find(m => m.foe === foe.id)?.raceCoverage[0] ?? 0) >= 0.65);
    if (!answers.length) threats.push(foe.id);
    if (answers.length === 1) answers[0]!.uniqueAnswers.push(foe.id);
  }
  const ranked = [...roles].sort((a, b) => b.contribution - a.contribution);
  const tera = roles.filter(p => p.tera && p.tera.gain > 0.05).sort((a, b) => b.tera!.gain - a.tera!.gain);
  return { revision: createHash('sha256').update(JSON.stringify([s, input.request, input.legalActions])).digest('hex').slice(0, 12),
    turn: s.turn, unseen: Math.max(0, (theirs.teamSize ?? 6) - theirs.team.length), roles,
    leadingCandidates: ranked.filter(p => p.contribution > 0.3).slice(0, 2).map(p => p.pokemon), threats,
    teraAvailable: !!teraAvailable, preferredTera: tera[0]?.pokemon ?? null, opponent: opponentModel(s, side),
    limitations: 'Recomputed now. Free-entry direct-attack races over sampled sets, not win probabilities. Switching, recovery, future boosts, critical hits and unrevealed opposing Tera can change them. No teammate is mandatory to preserve.' };
}

/**
 * Compact current facts survive both payload tiers; no history of obsolete favourites. A matchup with no winning race
 * is left out, and so is a Tera that changes nothing: that is what their absence means, and the instruction says so.
 * The caveats live in that instruction too, rather than in every request. That took the plan from 2.0 KB to about
 * 1.1 KB at the median.
 */
export function compactGamePlan(p: GamePlan) {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { revision: p.revision, unseen: p.unseen, leadingCandidates: p.leadingCandidates, threats: p.threats,
    preferredTera: p.preferredTera, teraAvailable: p.teraAvailable,
    roles: p.roles.map(r => ({ pokemon: r.pokemon, species: r.species, hpAfterEntry: r2(r.hpAfterEntry),
      contribution: r2(r.contribution), ...(r.uniqueAnswers.length ? { uniqueAnswers: r.uniqueAnswers } : {}),
      matchups: r.matchups.filter(m => m.raceCoverage[1] > 0)
        .map(m => ({ foe: m.foe, move: m.move, raceCoverage: m.raceCoverage.map(r2), hpNeeded: r2(m.hpNeeded) })),
      ...(r.tera && (r.tera.gain || r.tera.helpsAgainst.length || r.tera.harmsAgainst.length)
        ? { tera: { type: r.tera.type, gain: r2(r.tera.gain), helpsAgainst: r.tera.helpsAgainst, harmsAgainst: r.tera.harmsAgainst } } : {}) })),
    ...(p.opponent ? { opponent: { probabilities: Object.fromEntries(Object.entries(p.opponent.probabilities).map(([k, v]) => [k, r2(v)])),
      evidence: p.opponent.evidence, likelySwitches: p.opponent.likelySwitches } } : {}) };
}
