import type { PokemonState } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { grounded, pokemonTypes } from '../pokemon/mechanics.js';
import { plausibleMoves } from './setPriors.js';

/** Moves that take their user out even while it is trapped. */
const pivots = new Set(['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport', 'batonpass', 'shedtail', 'chillyreception']);

/**
 * Whether our active's trapping ability keeps the opposing Pokémon in. Gothitelle's Shadow Tag, Dugtrio's Arena Trap
 * and Magnezone's Magnet Pull were active on 35 logged decisions, and each time the payload still weighed the Pokémon
 * they might bring in. A Ghost type or Shed Shell escapes all three, a second Shadow Tag ignores the first, Arena Trap
 * holds only the grounded and Magnet Pull only Steel types. A pivot move still takes them out, so it is named.
 */
export function trappedByUs(me: PokemonState, foe: PokemonState) {
  if (me.abilitySuppressed || foe.fainted) return null;
  const ability = id(me.ability ?? '');
  if (!['shadowtag', 'arenatrap', 'magnetpull'].includes(ability)) return null;
  const types = pokemonTypes(foe);
  if (types.includes('Ghost') || id(foe.item ?? '') === 'shedshell') return null;
  if (ability === 'shadowtag' && id(foe.ability ?? '') === 'shadowtag') return null;
  if (ability === 'arenatrap' && !grounded(foe)) return null;
  if (ability === 'magnetpull' && !types.includes('Steel')) return null;
  const ways = plausibleMoves(foe).filter(m => pivots.has(id(m.move)) && (m.revealed || (m.priorProbability ?? 0) >= 0.2));
  return { because: `our ${dex.abilities.get(ability).name}`,
    ...(ways.length ? { exceptThrough: ways.map(m => m.revealed ? m.move : `${m.move} (in ${Math.round((m.priorProbability ?? 0) * 100)}% of sets)`) } : {}) };
}
