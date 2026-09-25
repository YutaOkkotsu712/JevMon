import type { BattleState, SideId } from '../battle/BattleState.js';
import { dex } from '../pokemon/data.js';
import { typeEffectiveness } from '../pokemon/mechanics.js';
import { inferOpponent } from './inference.js';

/**
 * The share of their active's sets whose Tera type is immune to this move, while their Tera is still unspent. Tera
 * happens before any move, whatever the Speed order. For a crash move that is half our max HP: Talonflame went Tera
 * Ground into Electivire's Supercell Slam, and the crash knocked Electivire out (2687152284). The payload listed the
 * possible Tera types and the crash rule, but never put the two together.
 */
export function teraImmunityShare(s: BattleState, ourSide: SideId, moveName: string) {
  const move = dex.moves.get(moveName);
  if (!move.exists || move.category === 'Status') return null;
  const theirs = s.sides[ourSide === 'p1' ? 'p2' : 'p1'];
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!foe || foe.fainted || foe.terastallized || theirs.team.some(p => p.terastallized)) return null;
  const sets = inferOpponent(foe).candidates;
  const total = sets.reduce((n, c) => n + c.probability, 0);
  if (!sets.length || !(total > 0)) return null;
  const immune = sets.filter(c => typeEffectiveness(move.type, [c.teraType]) === 0);
  const share = immune.reduce((n, c) => n + c.probability, 0) / total;
  if (!(share > 0)) return null;
  return { teraTypes: [...new Set(immune.map(c => c.teraType))], shareOfTheirSetsPercent: Math.round(share * 100) };
}
