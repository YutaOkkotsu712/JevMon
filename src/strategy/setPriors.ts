import data from '../data/gen9-randbats-stats.json' with { type: 'json' };
import type { PokemonState } from '../battle/BattleState.js';
import { canonicalSpecies, datasetSpeciesId, dex, id } from '../pokemon/data.js';
import { teammateFactor } from '../search/teamPrior.js';
// A role with no item (the Acrobatics sets) simply omits `items` in the published statistics.
interface Role { weight: number; abilities: Record<string, number>; items?: Record<string, number>; teraTypes: Record<string, number>; moves: Record<string, number> }
interface Entry { level: number; roles: Record<string, Role> }
type Key = 'abilities' | 'items' | 'teraTypes' | 'moves';
const entries = new Map(Object.entries(data).map(([name, entry]) => [id(name), entry as Entry]));
const statsKeys = new Set(entries.keys());
const round = (v: number) => Math.round(v * 1000) / 1000;
/** Roles whose generated move pool and Tera type can still produce what has been revealed. */
function compatible(p: PokemonState) {
  const entry = entries.get(datasetSpeciesId(p.species, statsKeys));
  if (!entry || p.transformedInto) return null;
  const roles = Object.entries(entry.roles).filter(([, r]) => p.revealedMoves.every(m => Object.keys(r.moves).some(v => id(v) === id(m))) &&
    (!p.terastallized || !p.teraType || Object.hasOwn(r.teraTypes, p.teraType)));
  const total = roles.reduce((n, [, r]) => n + r.weight, 0);
  if (!total) return null;
  // A move its teammates have shown is one the generator seldom gives it too (teamPrior.ts).
  const held = p.teammateMoves ?? [];
  const mix = (key: Key) => {
    const values = new Map<string, number>();
    for (const [, r] of roles) for (const [name, rate] of Object.entries(r[key] ?? {})) values.set(name, (values.get(name) ?? 0) + r.weight / total * rate);
    if (key === 'moves' && held.length) for (const [name, rate] of values) values.set(name, rate * teammateFactor(name, held));
    return [...values].sort((a, b) => b[1] - a[1]);
  };
  return { roles, total, mix };
}
export function setPriors(p: PokemonState) {
  const found = compatible(p);
  if (!found) return null;
  const record = (key: Key) => Object.fromEntries(found.mix(key).map(([k, v]) => [k, round(v)]));
  const items = found.mix('items');
  // Roles that generate no item leave the item frequencies short of one; state that mass rather than implying it away.
  const noItem = round(Math.min(1, Math.max(0, 1 - items.reduce((n, [, v]) => n + v, 0))));
  return { compatibleRolePriorWeights: Object.fromEntries(found.roles.map(([name, r]) => [name, round(r.weight / found.total)])),
    moves: record('moves'), items: record('items'), noItemProbability: noItem,
    abilities: record('abilities'), teraTypes: record('teraTypes') };
}
export interface PlausibleMove { move: string; revealed: boolean; priorProbability: number | null }
/** Revealed moves first, then the most frequent generated moves. Frequencies are marginal, not an action distribution. */
export function plausibleMoves(p: PokemonState, limit = 10): PlausibleMove[] {
  const found = compatible(p);
  const rates = new Map((found?.mix('moves') ?? []).map(([name, rate]) => [id(name), rate]));
  const out = new Map<string, PlausibleMove>();
  for (const name of p.transformedInto ? p.copiedMoves : p.revealedMoves) {
    const move = dex.moves.get(name);
    const rate = rates.get(move.id);
    if (move.exists) out.set(move.id, { move: move.name, revealed: true, priorProbability: rate === undefined ? null : round(rate) });
  }
  // Random Battle sets have four moves. Once all four have been seen, a role's wider
  // movepool is no longer evidence that the opponent might carry a fifth attack.
  if (!p.transformedInto && out.size < 4) for (const [key, rate] of rates) {
    if (out.size >= limit) break;
    const move = dex.moves.get(key);
    if (move.exists && !out.has(move.id)) out.set(move.id, { move: move.name, revealed: false, priorProbability: round(rate) });
  }
  return [...out.values()];
}
