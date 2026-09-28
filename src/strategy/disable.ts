import type { PokemonState } from '../battle/BattleState.js';
import { id } from '../pokemon/data.js';

/** The server names the disabled move; lastMoveUsed may already be something else (for example Bulk Up). */
export function disabledMove(p: PokemonState): string | null {
  const effect = Object.entries(p.volatiles).find(([k]) => id(k) === 'disable')?.[1];
  return effect?.data ? id(effect.data) : null;
}
