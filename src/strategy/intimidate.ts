import type { PokemonState } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';

type Stat = 'atk' | 'spa' | 'spe';
export interface IntimidateResponse { boosts: Partial<Record<Stat, number>>; because?: string }

/** Abilities Intimidate cannot lower. Mirror Armor sends the drop back instead, which is the intimidator's cost. */
const unmoved = ['clearbody', 'whitesmoke', 'fullmetalbody', 'hypercutter', 'innerfocus', 'oblivious', 'owntempo', 'scrappy', 'mirrorarmor'];
const turned: Record<string, Partial<Record<Stat, number>>> = {
  // Defiant loses the stage and then gains two, so it comes out one stage ahead.
  defiant: { atk: 1 }, guarddog: { atk: 1 }, contrary: { atk: 1 }, simple: { atk: -2 },
  competitive: { atk: -1, spa: 2 }, rattled: { atk: -1, spe: 1 },
};

/**
 * What Intimidate does to the Pokémon it lands on. Most lose a stage of Attack, several are unmoved, and Defiant,
 * Guard Dog and Competitive turn it into a boost, which is exactly the case where switching in an intimidator
 * backfires. A Substitute or Clear Amulet stops it before the ability is consulted.
 */
export function intimidateResponse(ability: string, item: string, behindSubstitute: boolean): IntimidateResponse {
  if (behindSubstitute) return { boosts: {}, because: 'Substitute' };
  if (id(item) === 'clearamulet') return { boosts: {}, because: 'Clear Amulet' };
  const key = id(ability), name = dex.abilities.get(key).name || ability;
  if (unmoved.includes(key)) return { boosts: {}, because: name };
  return turned[key] ? { boosts: turned[key]!, because: name } : { boosts: { atk: -1 } };
}

export const intimidates = (p: PokemonState) => !p.abilitySuppressed && id(p.ability) === 'intimidate';
export const behindSubstitute = (p: PokemonState) => Object.keys(p.volatiles).some(k => id(k) === 'substitute');

/** A copy of `p` with Intimidate's stage changes applied, clamped to the six-stage limit. */
export function intimidated(p: PokemonState, response: IntimidateResponse): PokemonState {
  if (!Object.keys(response.boosts).length) return p;
  const q = structuredClone(p);
  for (const [stat, change] of Object.entries(response.boosts)) q.boosts[stat] = Math.max(-6, Math.min(6, (q.boosts[stat] ?? 0) + change));
  return q;
}
