import type { PokemonState } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { setPriors } from './setPriors.js';
import { inferOpponent } from './inference.js';

/** A sampled ability or item is a possibility, never a fact, so it is reported with its generation frequency. */
export function sampled(target: PokemonState, kind: 'abilities' | 'items', names: string[]) {
  // A revealed ability or item settles the question outright, in both directions: it makes a match certain
  // and it rules the others out. Guessing from the samples when we already know is worse than useless.
  const revealed = kind === 'abilities' ? (target.abilitySuppressed ? '' : target.ability) : target.item;
  if (revealed !== null && revealed !== undefined) {
    const match = names.find(name => id(revealed) === name);
    return match ? [{ name: dex[kind].get(match).name || match, probability: 1, known: true }] : [];
  }
  const priors = setPriors(target)?.[kind] ?? {};
  const candidates = inferOpponent(target).candidates;
  const found: { name: string; probability: number | null; known?: boolean }[] = [];
  for (const name of names) {
    const match = Object.keys(priors).find(v => id(v) === name) ??
      candidates.map(c => (kind === 'abilities' ? c.ability : c.item)).find(v => id(v) === name);
    if (match) found.push({ name: dex[kind].get(match).name || match, probability: priors[match] ?? null });
  }
  return found;
}
