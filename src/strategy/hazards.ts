import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { hazardExposure, pokemonTypes } from '../pokemon/mechanics.js';
import { inferOpponent } from './inference.js';
import { remainingPokemon } from '../battle/BattleState.js';
import { effectViability } from './viability.js';

const limits: Record<string, number> = { stealthrock: 1, spikes: 3, toxicspikes: 2, stickyweb: 1 };
/** The tracker keys hazards by their display name, while a move names its side condition by ID. */
const displayKey: Record<string, string> = { stealthrock: 'Stealth Rock', spikes: 'Spikes', toxicspikes: 'Toxic Spikes', stickyweb: 'Sticky Web' };
const removal = new Set(['defog', 'rapidspin', 'mortalspin', 'tidyup', 'courtchange']);

/**
 * What a hazard move is worth, rather than only that it sets something. Hazards are paid for once and
 * collected every time the opponent switches, so the value is in how many Pokémon are still left to come in
 * and what each of them takes. Only revealed Pokémon can be priced; the rest are counted, not estimated.
 */
const attackHazards: Record<string, string> = { ceaselessedge: 'spikes', stoneaxe: 'stealthrock' };
export function hazardValue(s: BattleState, moveName: string, ourSide: SideId) {
  const move = dex.moves.get(moveName);
  if (!move.exists) return null;
  const theirSide = ourSide === 'p1' ? 'p2' : 'p1';
  const them = s.sides[theirSide], us = s.sides[ourSide];
  // Ceaseless Edge lays Spikes and Stone Axe lays Stealth Rock as they hit; the payload showed Smeargle's Ceaseless Edge
  // as 2% chip and nothing else, including the turn Spikes were already at three layers and it added only that chip.
  const layer = move.sideCondition ? id(move.sideCondition) : attackHazards[move.id];
  if (layer && limits[layer]) {
    const name = layer;
    const key = displayKey[name]!;
    const already = them.hazards[key] ?? 0;
    if (already >= limits[name]!) return attackHazards[move.id]
      ? { sets: key, alreadyAtItsLimit: true, note: `${key} is already at its limit, so ${move.name} adds only its damage` } : null;
    // A hazard the opponent reflects is not an investment, it is a gift, so it is not priced as one.
    const active = them.team.find(p => p.id === them.activeId);
    const bounced = active && effectViability(s, moveName, active, theirSide, active)?.certain
      .some(reason => /Magic Bounce/.test(reason));
    if (bounced) return { sets: key, wouldBeReflectedOntoOurSideInstead: true };
    const left = remainingPokemon(them);
    if (left !== null && left <= 1) return { sets: key, opposingPokemonStillToComeIn: 0, noFutureEntryValue: true, note: 'Only the active opponent remains; setting this hazard has no future switch-in value.' };
    // Only Pokémon that have been seen can be priced; the rest are counted so the total is not overstated.
    const revealed = them.team.filter(p => !p.fainted && p.id !== them.activeId);
    const onEntry = revealed.map(p => {
      const exposure = hazardExposure(p, { ...them, hazards: { ...them.hazards, [key]: already + 1 } });
      const boots = inferOpponent(p).candidates.some(c => id(c.item) === 'heavydutyboots');
      const percent = name === 'stealthrock' ? exposure.stealthRockPercentBeforePrevention
        : name === 'spikes' ? exposure.spikesPercentIfGrounded : null;
      return { species: p.species, ...(percent === null ? {} : { percentOnEntry: Math.round(percent * 10) / 10 }),
        ...(boots ? { mayHoldHeavyDutyBoots: true } : {}) };
    });
    return { sets: key, layersAfterThis: already + 1,
      opposingPokemonStillToComeIn: left === null ? null : Math.max(0, left - 1),
      knownSwitchIns: revealed.length ? onEntry : undefined,
      note: 'Collected every time they switch in, so its worth grows with the turns left in the battle.' };
  }
  if (removal.has(move.id)) {
    const ours = Object.entries(us.hazards).filter(([, n]) => n > 0);
    const theirs = Object.entries(them.hazards).filter(([, n]) => n > 0);
    if (!ours.length && !theirs.length) return null;
    return move.id === 'courtchange'
      ? { swapsHazards: true, oursCleared: Object.fromEntries(ours), theirsGained: Object.fromEntries(theirs) }
      : { ...(ours.length ? { clearsFromOurSide: Object.fromEntries(ours) } : {}),
          ...(move.id === 'defog' && theirs.length ? { alsoClearsFromTheirs: Object.fromEntries(theirs) } : {}) };
  }
  return null;
}
