import { afterEntry } from './entry.js';
import { Generations } from '@smogon/calc';
// Pinned calculator version: use the same rounding and modifiers as damage calculations.
import { getFinalSpeed } from '@smogon/calc/dist/mechanics/util.js';
import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import type { Candidate } from './setTypes.js';
import { buildField, buildPokemon, supportedSpeed } from './calcCore.js';
import { dex, id } from '../pokemon/data.js';
import { grounded } from '../pokemon/mechanics.js';
import { inferOpponent } from './inference.js';
import { plausibleMoves } from './setPriors.js';
export function effectiveSpeed(s: BattleState, p: PokemonState, side: SideId, c?: Candidate): number | null {
  p = afterEntry(s, p, side);
  if (p.fainted) return null;
  if (!supportedSpeed(s, p)) return null;
  const ability = p.abilitySuppressed ? '' : id(p.ability ?? c?.ability);
  // Unburden doubles Speed while the item is gone, from the moment it is lost until the Pokémon leaves the field. Every
  // loss is announced, so it is knowable: an item still held means no boost, and a loss seen during this stay means
  // double. Treating it as unknowable hid a Hawlucha that had just eaten its White Herb, and our own Hitmonlee.
  let unburden = 1;
  if (ability === 'unburden') {
    const item = p.item === '' ? '' : p.item ?? c?.item ?? null;
    if (item === null) return null;
    if (item === '') {
      const active = s.sides[side].activeId === p.id;
      if (!active) unburden = 1;
      else if (typeof p.itemLostOnTurn !== 'number' || typeof p.activeSinceTurn !== 'number') return null;
      else if (p.itemLostOnTurn >= p.activeSinceTurn) unburden = 2;
    }
  }
  // Air Lock and Cloud Nine only matter to Speed through the weather abilities they switch off, so they decline only
  // for those; declining for everyone left every Rayquaza game without a single Speed comparison. Neutralizing Gas
  // switches off every ability, which the calculator does not model, so it still declines.
  const onField = (names: string[]) => Object.values(s.sides).some(v => v.team.some(m => m.id === v.activeId && names.includes(id(m.ability))));
  if (onField(['neutralizinggas'])) return null;
  if (onField(['airlock', 'cloudnine']) && ['swiftswim', 'chlorophyll', 'sandrush', 'slushrush'].includes(ability)) return null;
  try { const field = buildField(s, side); return getFinalSpeed(Generations.get(9), buildPokemon(p, c), field, field.attackerSide) * unburden; }
  catch { return null; }
}
export function movePriority(s: BattleState, p: PokemonState, moveName: string, c?: Candidate): number | null {
  const move = dex.moves.get(moveName), ability = p.abilitySuppressed ? '' : id(p.ability ?? c?.ability), item = id(p.item ?? c?.item);
  if (!move.exists || ['quickclaw', 'custapberry', 'laggingtail', 'fullincense'].includes(item) || ['quickdraw', 'stall'].includes(ability)) return null;
  if (ability === 'myceliummight' && move.category === 'Status') return null;
  // Gale Wings needs full HP, and HP is public: Showdown only ever shows 100% for a Pokémon that is truly full.
  if (ability === 'galewings' && move.type === 'Flying') return p.hpPercent === null ? null : move.priority + (p.hpPercent === 100 ? 1 : 0);
  if (['afteryou', 'quash', 'instruct', 'mefirst', 'focuspunch', 'shelltrap', 'beakblast', 'pursuit'].includes(move.id)) return null;
  // Grassy Glide's +1 is conditional, but on nothing hidden: the terrain and the user's grounding are both
  // public, so treating it as unknown threw away the read rather than being careful about it.
  if (move.id === 'grassyglide') return s.field.terrain === 'Grassy Terrain' && grounded(p) ? 1 : 0;
  return move.priority + (ability === 'prankster' && move.category === 'Status' ? 1 : ability === 'triage' && move.flags.heal ? 3 : 0);
}
export type Order = 'ours-first' | 'theirs-first' | 'uncertain';
/** Everything about turn order that does not depend on which of our moves we pick. */
function context(s: BattleState, ourPokemon?: PokemonState) {
  if (!s.mySide) return null;
  const enemySide = s.mySide === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[s.mySide], theirs = s.sides[enemySide];
  const me = ourPokemon ?? ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe) return null;
  const candidates = inferOpponent(foe).candidates, foeMoves = plausibleMoves(foe);
  const ourSpeed = effectiveSpeed(s, me, s.mySide);
  const speeds = candidates.map(c => effectiveSpeed(s, foe, enemySide, c));
  const usable = speeds.filter((v): v is number => v !== null);
  const range: [number, number] | null = usable.length && usable.length === speeds.length ? [Math.min(...usable), Math.max(...usable)] : null;
  const priorities = candidates.flatMap(c => foeMoves.map(m => movePriority(s, foe, m.move, c)));
  const known = priorities.filter((v): v is number => v !== null);
  const bracket: [number, number] | null = known.length && known.length === priorities.length ? [Math.min(...known), Math.max(...known)] : null;
  // Trick Room reverses which of two equal-priority moves resolves first; it never changes the speeds themselves.
  const slowerWins = s.field.trickRoom;
  let ifEqualPriority: Order = 'uncertain';
  if (ourSpeed !== null && range) {
    if (ourSpeed > range[1]) ifEqualPriority = slowerWins ? 'theirs-first' : 'ours-first';
    else if (ourSpeed < range[0]) ifEqualPriority = slowerWins ? 'ours-first' : 'theirs-first';
  }
  return { me, foe, enemySide, foeMoves, ourSpeed, range, bracket, known, ifEqualPriority };
}
/** Effective speed against the sampled opposing spreads, plus the priority brackets those samples allow. */
export function speedSummary(s: BattleState, ourPokemon?: PokemonState) {
  const c = context(s, ourPokemon);
  if (!c || c.ourSpeed === null || !c.range) return { relation: 'unknown' as const };
  return { relation: c.ourSpeed > c.range[1] ? 'faster-than-all-samples' : c.ourSpeed < c.range[0] ? 'slower-than-all-samples' : 'overlapping-or-speed-tie',
    ours: c.ourSpeed, opponentRange: c.range, opponentPriorityBracket: c.bracket,
    ifEqualPriority: c.ifEqualPriority, trickRoom: s.field.trickRoom };
}
/**
 * Who acts first if we pick this move, deduced rather than assumed. We are first only when no sampled opposing
 * move outranks us and we win any equal-priority race; the opposite settles the opponent. A single
 * faster-priority option leaves the order open, and those moves are named instead of being ignored.
 */
export function turnOrder(s: BattleState, me: PokemonState, moveName: string) {
  const c = context(s, me);
  if (!c || c.foe.fainted || me.fainted) return null;
  const ourPriority = movePriority(s, me, moveName);
  let order: Order = 'uncertain', reason = 'unmodelled priority, speed or sampling';
  if (ourPriority !== null && c.bracket) {
    const above = c.known.some(v => v > ourPriority), below = c.known.some(v => v < ourPriority), equal = c.known.includes(ourPriority);
    if (!above && (!equal || c.ifEqualPriority === 'ours-first')) {
      order = 'ours-first'; reason = equal ? 'no sampled opposing move outranks us and we win the equal-priority race' : 'every sampled opposing move is outranked by ours';
    } else if (!below && (!equal || c.ifEqualPriority === 'theirs-first')) {
      order = 'theirs-first'; reason = equal ? 'no sampled opposing move is outranked by ours and we lose the equal-priority race' : 'every sampled opposing move outranks ours';
    } else reason = above && below ? 'sampled opposing moves sit both above and below our priority'
      : above ? 'a sampled opposing move outranks our priority' : 'the equal-priority race is a tie or the sampled speeds overlap';
  }
  const jumpers = ourPriority === null ? [] : c.foeMoves
    .map(m => ({ move: m.move, priority: movePriority(s, c.foe, m.move), priorProbability: m.priorProbability }))
    .filter((m): m is { move: string; priority: number; priorProbability: number | null } => m.priority !== null && m.priority > ourPriority);
  return { order, reason, ourPriority, opponentMovesThatOutprioritiseUs: jumpers.slice(0, 3) };
}
