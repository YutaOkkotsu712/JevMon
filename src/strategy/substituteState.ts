import type { PokemonState } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
export const hasSubstitute = (p: PokemonState) => Object.keys(p.volatiles).some(k => id(k) === 'substitute');
export function hitsSubstitute(attacker: PokemonState, target: PokemonState, moveName: string, ability?: string) {
  const move = dex.moves.get(moveName);
  return hasSubstitute(target) && !move.flags.bypasssub &&
    !(!attacker.abilitySuppressed && id(attacker.ability ?? ability) === 'infiltrator') &&
    ['normal','allAdjacent','allAdjacentFoes','randomNormal','any'].includes(move.target);
}
export function substituteHP(p: PokemonState, maxHP: number): [number, number] {
  // Unknown/replayed/transferred Substitutes cannot be assumed fresh.
  return p.substitute?.hp ?? [1, Math.max(1, Math.floor(maxHP / 4))];
}
