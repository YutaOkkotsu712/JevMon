import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { pokemonTypes } from '../pokemon/mechanics.js';
import { damageRange } from './damage.js';
import { plausibleMoves } from './setPriors.js';
import { sampled } from './sampled.js';
import { speedSummary } from './speed.js';
import { effectViability } from './viability.js';

/** Moves Encore fails on, and moves that make it fail by being what we last used. */
const unencorable = new Set(['encore', 'transform', 'mimic', 'mirrormove', 'sketch', 'sleeptalk', 'struggle', 'assist', 'copycat', 'metronome', 'mefirst', 'naturepower']);

/**
 * Their Encore landing before our move this turn. It replaces whatever we pick with the move we used last, for three
 * turns, so choosing a different move does not avoid it; only a switch does. Sableye's Prankster Encore locked Snorlax
 * into Rest at full HP and then Cobalion into Aura Sphere, which Sableye is immune to (2687149125). Nothing told Jev
 * until it had already happened.
 *
 * Only when Encore is plausible for them, it goes first (Prankster, which fails on a Dark type, or outright Speed),
 * we have a last move that Encore can hold, and that move would be a wasted turn: it fails, is a status move, or does
 * under a fifth of their HP.
 */
export function encoreThreat(s: BattleState, me: PokemonState, side: SideId) {
  const theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!foe || foe.fainted || me.fainted || !me.lastMoveUsed || s.field.trickRoom) return null;
  if (Object.keys(me.volatiles).some(k => id(k) === 'encore')) return null;
  const last = dex.moves.get(me.lastMoveUsed);
  if (!last.exists || unencorable.has(last.id)) return null;
  if (!me.abilitySuppressed && id(me.ability) === 'aromaveil') return null;
  const encore = foe.revealedMoves.some(m => id(m) === 'encore') ? 1
    : plausibleMoves(foe).find(m => id(m.move) === 'encore')?.priorProbability ?? 0;
  if (encore < 0.2) return null;
  const prankster = pokemonTypes(me).includes('Dark') ? [] : sampled(foe, 'abilities', ['prankster']);
  const pranksterChance = prankster[0] ? (prankster[0].known ? 1 : prankster[0].probability ?? 0) : 0;
  const outspeeds = speedSummary(s, me).relation === 'slower-than-all-samples';
  if (!outspeeds && pranksterChance < 0.5) return null;
  const viability = effectViability(s, last.name, me, side, foe);
  const damage = last.category === 'Status' ? null : damageRange(s, last.name);
  // A lock into a real attack costs little. They used Encore on 11% of the logged turns this could fire, but on 38%
  // of those where the move it would hold was useless, so only a bad lock is worth the payload.
  const useless = !!viability?.certain.length || last.category === 'Status' || (!!damage && damage.percentOfMaxHP[1] < 20);
  if (!useless) return null;
  return {
    encoreChancePercent: Math.round(encore * 100),
    movesFirstBecause: outspeeds ? 'it outspeeds us' : `Prankster (${Math.round(pranksterChance * 100)}% of its sets)`,
    locksUsInto: last.name,
    forTurns: 3,
    ...(viability?.certain.length ? { thatMoveNowFails: viability.certain } : {}),
    ...(damage ? { thatMoveDoesPercent: damage.percentOfMaxHP, ...(damage.percentOfMaxHP[1] === 0 ? { itIsImmune: true } : {}) }
      : last.category === 'Status' ? { thatMoveIsAStatusMove: true } : {}),
    onlyASwitchAvoidsIt: true,
  };
}
