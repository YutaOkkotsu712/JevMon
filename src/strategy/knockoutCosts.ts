import type { PokemonState } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { plausibleMoves } from './setPriors.js';
import { sampled } from './sampled.js';
import type { Order } from './speed.js';

const bondNote = 'Destiny Bond lasts until its user next tries to move and fails if used twice in a row, so a turn that does not knock it out — a status move, a switch, or a Sucker Punch into the bond — defuses it. Take the trade only when our Pokémon is worth less than theirs or is going down anyway.';

/**
 * What landing a knockout costs us, which a damage number cannot say. Froslass, faster and at 55%, used Destiny Bond as
 * Houndoom's Dark Pulse knocked it out, and Houndoom fainted with it; nothing had said the knockout could be a trade.
 *
 * A bond already up is met by any hit that lands before its user moves again. One not yet used is a risk only when
 * the opponent can move first, carries it, and did not use it last turn, since a second use in a row fails.
 */
export function knockoutCosts(foe: PokemonState, moveName: string, order: Order | undefined) {
  const out: Record<string, unknown> = {};
  const up = Object.keys(foe.volatiles).some(k => id(k) === 'destinybond');
  if (up && order !== 'theirs-first') {
    out.destinyBond = { active: true, ourPokemonFaintsToo: order === 'ours-first' ? 'certainly: we move first and the bond is still up' : 'if we move before it does', note: bondNote };
  } else if (!up && order !== 'ours-first' && id(foe.lastMoveUsed ?? '') !== 'destinybond') {
    const bond = plausibleMoves(foe, 20).find(m => id(m.move) === 'destinybond');
    if (bond) out.destinyBond = { active: false, revealed: bond.revealed,
      ...(bond.priorProbability === null ? {} : { carriedPercent: Math.round(bond.priorProbability * 100) }),
      ourPokemonFaintsToo: 'if it moves first and uses Destiny Bond this turn', note: bondNote };
  }
  // Aftermath answers a contact knockout with a quarter of the attacker's max HP.
  if (dex.moves.get(moveName).flags.contact) {
    const aftermath = sampled(foe, 'abilities', ['aftermath'])[0];
    if (aftermath) out.aftermath = { costsUsPercentOfMaxHP: 25, ...(aftermath.known ? { known: true } : { probability: aftermath.probability }) };
  }
  return Object.keys(out).length ? out : null;
}
