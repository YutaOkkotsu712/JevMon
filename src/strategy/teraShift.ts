import { calcStat, type StatID } from '@smogon/calc';
import type { PokemonState } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { fittedSpread, levelOf } from './calcCore.js';
import type { Candidate } from './setTypes.js';

/** Tera Shift happens before entry hazards. Project it without changing the server's retained roster. */
export function afterTeraShift(p: PokemonState, candidate?: Candidate): PokemonState {
  if (id(p.species) !== 'terapagos' || p.fainted || p.transformedInto || p.terastallized ||
      id(p.ability ?? candidate?.ability) !== 'terashift') return p;
  try {
    const level = levelOf(p), spread = candidate ?? fittedSpread(p);
    const evs = { ...spread.evs }, ivs = { ...spread.ivs };
    // The special random set uses zero Attack IVs/EVs. Prefer that exact spread when it fits; fitting the old
    // rounded stat alone also admits 1 IV, which would invent one Attack point after this form change.
    if (!candidate && p.stats.atk === calcStat(9, 'atk', dex.species.get('Terapagos').baseStats.atk, 0, 0, level, 'Serious')) {
      evs.atk = 0; ivs.atk = 0;
    }
    const base = dex.species.get('Terapagos-Terastal').baseStats;
    const stats = Object.fromEntries((Object.keys(base) as StatID[]).map(k =>
      [k, calcStat(9, k, base[k], ivs[k], evs[k], level, 'Serious')]));
    const oldMax = p.exactHP?.max ?? calcStat(9, 'hp', dex.species.get('Terapagos').baseStats.hp, ivs.hp, evs.hp, level, 'Serious');
    const oldHP = p.exactHP?.current ?? Math.max(1, Math.round(oldMax * (p.hpPercent ?? 100) / 100));
    // Showdown preserves missing HP, not the percentage, when a permanent form changes max HP.
    const max = stats.hp!, current = Math.max(1, max - (oldMax - oldHP));
    return { ...structuredClone(p), species: 'Terapagos-Terastal', details: p.details.replace(/^Terapagos(?=,|$)/, 'Terapagos-Terastal'),
      ability: 'Tera Shell', baseAbility: 'Tera Shell', abilitySuppressed: false,
      stats: Object.fromEntries(Object.entries(stats).filter(([k]) => k !== 'hp')),
      exactHP: { current, max }, hpPercent: current / max * 100 };
  } catch { return p; }
}
