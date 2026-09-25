import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { grounded, hazardExposure, pokemonTypes } from '../pokemon/mechanics.js';
import { dex, id } from '../pokemon/data.js';
import { buildPokemon } from './calcCore.js';
import { inferOpponent } from './inference.js';

const copiedStats = ['atk', 'def', 'spa', 'spd', 'spe'] as const;
/**
 * Imposter on arrival: Ditto becomes a copy of whatever it faces. It keeps its own HP, level and item, and takes the
 * target's species, its types from before any Tera, its stats other than HP, its stat stages, its ability and its moves.
 * Against a Veluza at +2 from Fillet Away, our Choice Scarf Ditto was the one Pokémon that could outspeed and knock it
 * out; seen as a plain Ditto, slow and moveless, it was sent in last, after three others fell. Our own Pokémon's stats
 * and moves are known exactly; an opponent's come from its most likely set. Transform fails into a Substitute, into a
 * Pokémon already transformed, and between Ogerpon or Terapagos and a Terastallized side.
 */
function imposterCopy(s: BattleState, q: PokemonState, side: SideId) {
  const theirs = s.sides[side === 'p1' ? 'p2' : 'p1'], target = theirs.team.find(p => p.id === theirs.activeId);
  if (!target || target.fainted || target.transformedInto || Object.keys(target.volatiles).some(k => id(k) === 'substitute')) return;
  if (['Ogerpon', 'Terapagos'].includes(dex.species.get(target.species).baseSpecies) && (target.terastallized || q.terastallized)) return;
  const known = copiedStats.every(k => (target.stats?.[k] ?? 0) > 0);
  const set = known ? undefined : [...inferOpponent(target).candidates].sort((a, b) => b.probability - a.probability)[0];
  if (!known && !set) return;
  const stats = known ? target.stats : buildPokemon(target, set).rawStats;
  const moves = target.knownMoves.length ? target.knownMoves : [...new Set([...target.revealedMoves, ...(set?.moves ?? [])].map(m => dex.moves.get(m).name))].slice(0, 4);
  q.transformedInto = target.species;
  q.stats = Object.fromEntries(copiedStats.map(k => [k, stats[k]]));
  q.boosts = { ...target.boosts };
  q.copiedMoves = [...moves]; q.knownMoves = [...moves];
  q.ability = target.ability ?? set?.ability ?? null; q.abilitySuppressed = false; q.baseAbility = 'Imposter';
}

/** Project a known bench Pokémon through entry hazards without changing retained battle state. */
export function afterEntry(s: BattleState, p: PokemonState, side: SideId): PokemonState {
  if (p.entryProjected || s.sides[side].activeId === p.id || p.fainted) return p;
  const q = structuredClone(p); q.entryProjected = true;
  const ability = q.abilitySuppressed ? '' : id(q.ability), item = ability === 'klutz' ? '' : id(q.item);
  // Heavy-Duty Boots stops every hazard, but not what the Pokémon's own ability does on arrival.
  const boots = item === 'heavydutyboots';
  const h = hazardExposure(q, s.sides[side]), onGround = grounded(q), types = pokemonTypes(q);
  if (!boots && ability !== 'magicguard') {
    const parts = [h.stealthRockPercentBeforePrevention ?? 0, onGround ? h.spikesPercentIfGrounded : 0];
    if (q.exactHP) {
      q.exactHP.current = Math.max(0, q.exactHP.current - parts.reduce((n, v) => n + (v > 0 ? Math.max(1, Math.floor(q.exactHP!.max * v / 100)) : 0), 0));
      q.hpPercent = 100 * q.exactHP.current / q.exactHP.max;
    } else if (q.hpPercent !== null) q.hpPercent = Math.max(0, q.hpPercent - parts.reduce((a,b)=>a+b,0));
  }
  q.fainted = q.hpPercent === 0;
  if (q.fainted) return q;
  // Boosts that fire on arrival. The calculator is kept from adding them, so an arriving Pokémon gets them here.
  if (ability.startsWith('embodyaspect') && q.terastallized) {
    const stat = ({ embodyaspectteal: 'spe', embodyaspecthearthflame: 'atk', embodyaspectwellspring: 'spd', embodyaspectcornerstone: 'def' } as Record<string, string>)[ability];
    if (stat) q.boosts = { ...q.boosts, [stat]: Math.min(6, (q.boosts[stat] ?? 0) + 1) };
  }
  if (ability === 'download') {
    // Download raises Attack against the lower Defence, otherwise Special Attack, read from the Pokémon it faces.
    const theirs = s.sides[side === 'p1' ? 'p2' : 'p1'], foe = theirs.team.find(p => p.id === theirs.activeId);
    const base = foe && !foe.fainted ? dex.species.get(foe.species).baseStats : null;
    if (base) { const stat = base.def < base.spd ? 'atk' : 'spa'; q.boosts = { ...q.boosts, [stat]: Math.min(6, (q.boosts[stat] ?? 0) + 1) }; }
  }
  if (!boots && onGround && h.stickyWeb && !['clearbody','whitesmoke','fullmetalbody'].includes(ability) && item !== 'clearamulet') {
    const previousSpeedStage = q.boosts.spe ?? 0;
    q.boosts.spe = Math.max(-6, Math.min(6, (q.boosts.spe ?? 0) + (ability === 'contrary' ? 1 : ability === 'simple' ? -2 : -1)));
    if (ability === 'defiant' && q.boosts.spe < previousSpeedStage) q.boosts.atk = Math.min(6,(q.boosts.atk ?? 0)+2);
    if (ability === 'competitive' && q.boosts.spe < previousSpeedStage) q.boosts.spa = Math.min(6,(q.boosts.spa ?? 0)+2);
  }
  if (!boots && onGround && h.toxicSpikesLayers && !q.status && !types.some(t=>['Poison','Steel'].includes(t)) &&
      !['immunity','pastelveil','purifyingsalt','comatose'].includes(ability) && s.field.terrain !== 'Misty Terrain' &&
      !(ability === 'leafguard' && ['SunnyDay','DesolateLand'].includes(s.field.weather ?? ''))) {
    q.status = h.toxicSpikesLayers >= 2 ? 'tox' : 'psn'; q.toxicTurns = 0;
  }
  // Imposter acts after the hazards, so its copied stages replace a Sticky Web drop. Every Random Battle Ditto has it.
  if (ability === 'imposter' || (!q.ability && q.species === 'Ditto')) imposterCopy(s, q, side);
  return q;
}
