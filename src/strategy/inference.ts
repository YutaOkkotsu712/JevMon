import { setPriors } from './setPriors.js';
import pools from '../data/gen9-sets.json' with { type: 'json' };
import joint from '../data/gen9-joint-sets.json' with { type: 'json' };
import type { PokemonState } from '../battle/BattleState.js';
import { canonicalSpecies, datasetSpeciesId, dex, id } from '../pokemon/data.js';
import { calcStat } from '@smogon/calc';

import type { Candidate } from './setTypes.js';
export type { Candidate } from './setTypes.js';
export { levelOf } from './calcCore.js';
import { levelOf } from './calcCore.js';
interface Role { role: string; movepool: string[]; abilities: string[]; teraTypes: string[] }
const poolData = pools as Record<string, { level: number; sets: Role[] }>;
const jointSets: Record<string, Candidate[]> = Object.fromEntries(
  Object.entries(joint.species).map(([name, sets]) => [name, sets.map((s, i) => ({ ...s, key: `${name}:${i}` }))]));
const datasetKeys = new Set([...Object.keys(poolData), ...Object.keys(jointSets)]);
const mass = (candidates: Candidate[]) => Math.round(candidates.reduce((n, c) => n + c.probability, 0) * 1000) / 1000;
const unique = (xs: string[]) => [...new Set(xs)];

let speedPool: { species: string; speeds: { spe: number; probability: number }[] }[] | null = null;
/**
 * Every Random Battle species with the unboosted Speed of each of its sets at its generated level, Choice Scarf
 * included, weighted by how often the set is generated. Built once. Weather and terrain abilities, Unburden and field
 * effects are left out, which is what "a Pokémon not yet seen, arriving fresh" is.
 */
export function unrevealedSpeedPool() {
  if (speedPool) return speedPool;
  speedPool = Object.entries(jointSets).flatMap(([name, sets]) => {
    const species = dex.species.get(name), level = poolData[name]?.level;
    if (!species.exists || !level || !sets.length) return [];
    const total = sets.reduce((n, c) => n + c.probability, 0) || 1;
    return [{ species: species.name, speeds: sets.map(c => ({
      spe: Math.floor(calcStat(9, 'spe', species.baseStats.spe, c.ivs.spe, c.evs.spe, level, 'Serious') * (id(c.item) === 'choicescarf' ? 1.5 : 1)),
      probability: c.probability / total })) }];
  });
  return speedPool;
}

/**
 * The sets that explain the most of what a Pokémon has revealed, for when none explains all of it. inferOpponent fails
 * closed then, so the payload makes no claim, but the search still needs a Pokémon in the slot.
 */
export function bestFitCandidates(p: PokemonState): Candidate[] {
  const seen = p.revealedMoves.map(id);
  const all = (jointSets[datasetSpeciesId(p.species, datasetKeys)] ?? [])
    .filter(c => !p.terastallized || !p.teraType || c.teraType === p.teraType);
  const fit = (c: Candidate) => seen.filter(m => c.moves.includes(m)).length;
  const best = Math.max(0, ...all.map(fit));
  return all.filter(c => fit(c) === best);
}

export function inferOpponent(p: PokemonState) {
  const speciesId = datasetSpeciesId(p.species, datasetKeys), pool = poolData[speciesId];
  // Current abilities/items can be changed by battle effects. Never eliminate an original set using them.
  const moves = p.revealedMoves.map(id);
  // A transformed Pokémon still has its own set — its HP, level and item — and its own moves are the ones revealed
  // before it transformed; the moves it copied are kept apart, so they never eliminate its sets.
  const disabled = Object.keys(p.volatiles).some(k => ['Mimic', 'Sketch'].includes(k));
  const roles = disabled ? [] : (pool?.sets ?? []).filter(r => moves.every(m => r.movepool.some(v => id(v) === m)) &&
    (!p.terastallized || !p.teraType || r.teraTypes.includes(p.teraType)));
  const compatible = disabled ? [] : (jointSets[speciesId] ?? []).filter(c => moves.every(m => c.moves.includes(m)) &&
    (!p.terastallized || !p.teraType || c.teraType === p.teraType));
  const excluded = new Set(p.inference?.excluded ?? []);
  const candidates = compatible.filter(c => !excluded.has(c.key!));
  const speed = candidates.map(c => calcStat(9, 'spe', dex.species.get(canonicalSpecies(p.species)).baseStats.spe, c.ivs.spe, c.evs.spe, levelOf(p), 'Serious'));
  return {
    candidates,
    summary: {
      status: disabled ? 'unsupported-transformation' : !pool ? 'no-species-data' : !roles.length ? 'no-compatible-role' : 'candidate-pools',
      roles: unique(roles.map(r => r.role)),
      possibleUnrevealedMoves: moves.length >= 4 ? [] : unique(roles.flatMap(r => r.movepool)).filter(m => !moves.includes(id(m))),
      possibleOriginalAbilities: unique(roles.flatMap(r => r.abilities)),
      possibleTeraTypes: unique(roles.flatMap(r => r.teraTypes)),
      setPriors: setPriors(p),
      sampledOriginalItems: unique(candidates.map(c => c.item)),
      sampledCandidateCount: candidates.length,
      // Generation frequency of the sets still standing, renormalised over what the evidence allows.
      candidateProbabilityMassBeforeEvidence: mass(candidates),
      mostLikelyCandidates: candidates.slice(0, 3).map(c => ({ item: c.item, ability: c.ability, teraType: c.teraType,
        unrevealedMoves: c.moves.filter(m => !moves.includes(m)),
        probability: candidates.length ? Math.round(c.probability / mass(candidates) * 1000) / 1000 : 0 })),
      baseSpeedRange: speed.length ? [Math.min(...speed), Math.max(...speed)] : null,
      evidence: p.inference?.observations ?? [],
      evidenceContradictions: p.inference?.contradictions ?? 0,
      evidenceConflict: compatible.length > 0 && candidates.length === 0,
      exhaustive: false,
    },
  };
}
