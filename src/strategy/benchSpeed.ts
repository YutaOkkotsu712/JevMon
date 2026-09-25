import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { canonicalSpecies, id } from '../pokemon/data.js';
import { effectiveSpeed } from './speed.js';
import { inferOpponent, unrevealedSpeedPool } from './inference.js';

/**
 * Which of their remaining Pokémon we outspeed, now and after a Speed boost. A Dragon Dance on a Pokémon that can take
 * the hit in front of it is worth what it does to the rest of their team as well: the boost stays for the next
 * Pokémon, which may be one that outspeeds us now. The search sees that by playing the game forward; this is the same
 * fact for the provider.
 *
 * Revealed Pokémon count as outsped only when we beat the fastest of their possible sets, Choice Scarf included. The
 * slots not yet seen are the share of the Random Battle pool, weighted by set frequency, that we outspeed; a tie is not
 * outspeeding. Trick Room reverses the question, so it is not answered under it.
 */
export function benchSpeed(s: BattleState, me: PokemonState, side: SideId, speedStages: number) {
  if (s.field.trickRoom || speedStages === 0) return null;
  const foeSide: SideId = side === 'p1' ? 'p2' : 'p1', theirs = s.sides[foeSide];
  const stage = Math.max(-6, Math.min(6, (me.boosts.spe ?? 0) + speedStages));
  const now = effectiveSpeed(s, me, side), after = effectiveSpeed(s, { ...me, boosts: { ...me.boosts, spe: stage } }, side);
  if (now === null || after === null || now === after) return null;
  const bench = theirs.team.filter(p => !p.fainted && p.id !== theirs.activeId);
  const fastest = (p: PokemonState) => {
    const sets = inferOpponent(p).candidates;
    const speeds = (sets.length ? sets : [undefined]).map(c => effectiveSpeed(s, p, foeSide, c));
    return speeds.some(v => v === null) ? null : Math.max(...(speeds as number[]));
  };
  const revealed = bench.map(p => ({ species: p.species, top: fastest(p) })).filter(x => x.top !== null) as { species: string; top: number }[];
  const unseen = Math.max(0, (theirs.teamSize ?? 6) - theirs.team.length);
  const seen = new Set(theirs.team.map(p => id(canonicalSpecies(p.species))));
  // Their Tailwind doubles whoever comes in next as well.
  const tailwind = Object.keys(theirs.conditions).some(k => id(k) === 'tailwind') ? 2 : 1;
  const share = (ours: number) => {
    const pool = unrevealedSpeedPool().filter(x => !seen.has(id(x.species)));
    const outsped = pool.reduce((n, x) => n + x.speeds.reduce((m, v) => m + (ours > v.spe * tailwind ? v.probability : 0), 0), 0);
    return pool.length ? Math.round(outsped / pool.length * 100) : null;
  };
  const gained = revealed.filter(x => after > x.top && !(now > x.top)).map(x => x.species);
  const lost = revealed.filter(x => now > x.top && !(after > x.top)).map(x => x.species);
  const [poolNow, poolAfter] = unseen ? [share(now), share(after)] : [null, null];
  if (!gained.length && !lost.length && poolNow === poolAfter) return null;
  return {
    ...(gained.length ? { nowOutspeedsFromTheirBench: gained } : {}),
    ...(lost.length ? { nowSlowerThanOnTheirBench: lost } : {}),
    ...(revealed.length ? { theirBenchOutspedAfter: revealed.filter(x => after > x.top).map(x => x.species) } : {}),
    ...(unseen && poolNow !== null ? { unrevealedSlots: unseen, shareOfUnrevealedPoolOutspedPercent: { now: poolNow, after: poolAfter } } : {}),
  };
}
