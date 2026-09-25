import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';

/** Showdown's sprite name: the base species, then the forme, as `keldeo-resolute` or `tauros-paldeaaqua`. */
export function spriteId(species: string) {
  const s = dex.species.get(species);
  if (!s.exists) return id(species);
  return id(s.baseSpecies) + (s.forme ? `-${id(s.forme)}` : '');
}
const pretty = (key: string) => key.replace(/^(move|ability|item): /i, '').replace(/([a-z])([A-Z])/g, '$1 $2');
/** Volatile effects worth a badge; the bookkeeping ones (choice lock, last move) are left out. */
const hidden = new Set(['choicelock', 'lockedmove', 'mustrecharge', 'twoturnmove', 'stall', 'protect']);
const mon = (p: PokemonState) => ({
  species: p.species, sprite: spriteId(p.transformedInto ?? p.species),
  hp: p.fainted ? 0 : Math.round((p.hpPercent ?? 0) * 10) / 10, fainted: p.fainted, status: p.status,
  boosts: Object.fromEntries(Object.entries(p.boosts).filter(([, v]) => v)),
  effects: Object.entries(p.volatiles).filter(([k]) => !hidden.has(id(k)))
    .map(([k, v]) => (id(k) === 'typechange' && v.data ? `type: ${v.data}` : pretty(k))),
  ...(p.terastallized && p.teraType ? { tera: p.teraType } : {}),
  // Our own side's come from the request as ids; the dex gives the name a person reads.
  ...(p.item ? { item: dex.items.get(p.item).name || p.item } : {}),
  ...(p.ability ? { ability: dex.abilities.get(p.ability).name || p.ability } : {}),
});

/**
 * Both sides as the arena shows them: the active Pokémon with its HP, status, stat stages, volatile effects and Tera,
 * the rest of the team, and each side's hazards and screens, plus the field. Our side comes first.
 */
export function arenaView(s: BattleState, room: string) {
  if (!s.mySide) return null;
  const view = (sideId: SideId) => {
    const v = s.sides[sideId];
    const active = v.team.find(p => p.id === v.activeId);
    return { side: sideId, name: v.name, rating: v.rating, teamSize: v.teamSize,
      active: active ? mon(active) : null,
      team: v.team.map(p => ({ species: p.species, sprite: spriteId(p.species), hp: p.fainted ? 0 : Math.round((p.hpPercent ?? 0) * 10) / 10,
        fainted: p.fainted, status: p.status, active: p.id === v.activeId })),
      hazards: v.hazards, conditions: Object.keys(v.conditions).map(pretty) };
  };
  const us = s.mySide, them: SideId = us === 'p1' ? 'p2' : 'p1';
  const outcome = !s.ended ? null : s.winner === null ? 'tie' : s.winner === s.sides[us].name ? 'win' : 'loss';
  return { room, turn: s.turn, ended: s.ended, winner: s.winner, outcome, field: s.field, us: view(us), them: view(them) };
}
export type ArenaView = NonNullable<ReturnType<typeof arenaView>>;
