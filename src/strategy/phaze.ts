import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { remainingPokemon } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { hasSubstitute } from './substituteState.js';
import { sampled } from './sampled.js';

/**
 * Why forcing their active out would not happen: no one left to bring in, Ingrain, Suction Cups or Guard Dog, or a
 * Substitute that takes an attacking phaze's hit. Roar and Whirlwind pass through a Substitute; Dragon Tail and Circle
 * Throw do not. Known causes are certain; a sampled ability is a possibility with its frequency.
 */
export function phazeStoppers(s: BattleState, target: PokemonState, targetSide: SideId, moveName: string) {
  const move = dex.moves.get(moveName);
  const certain: string[] = [], possible: { reason: string; probability: number | null }[] = [];
  if (!move.exists || !move.forceSwitch) return { certain, possible };
  const left = remainingPokemon(s.sides[targetSide]);
  if (left !== null && left <= 1) certain.push('they have no other Pokémon to bring in');
  if (Object.keys(target.volatiles).some(k => id(k) === 'ingrain')) certain.push('Ingrain roots it in place');
  for (const a of sampled(target, 'abilities', ['suctioncups', 'guarddog'])) {
    const reason = `${a.name} keeps it from being forced out`;
    if (a.known) certain.push(reason); else possible.push({ reason, probability: a.probability });
  }
  if (move.category !== 'Status' && hasSubstitute(target)) certain.push('its Substitute takes the hit, so it is not forced out');
  return { certain, possible };
}

/**
 * What a phaze buys, which `forcesTargetSwitch: true` alone never said. A Curse Snorlax at +1/+1 Body Slammed Piloswine
 * out over two turns of Earthquake while Roar sat unused (2687159529). Forcing it out wipes its stat changes, brings in a
 * Pokémon the opponent did not choose, and that Pokémon takes our hazards.
 *
 * Omitted when there is nothing to erase, no hazard to collect and nothing stopping it: then a phaze is only a scout.
 */
export function phazeOutlook(s: BattleState, ourSide: SideId, moveName: string) {
  const move = dex.moves.get(moveName);
  if (!move.exists || !move.forceSwitch) return null;
  const theirSide: SideId = ourSide === 'p1' ? 'p2' : 'p1', them = s.sides[theirSide];
  const foe = them.team.find(p => p.id === them.activeId);
  if (!foe || foe.fainted) return null;
  const stoppers = phazeStoppers(s, foe, theirSide, move.name);
  const erased = Object.fromEntries(Object.entries(foe.boosts).filter(([, n]) => (n ?? 0) !== 0));
  const hazards = Object.fromEntries(Object.entries(them.hazards).filter(([, n]) => n > 0));
  const breaksSubstitute = move.category === 'Status' && !!move.flags.bypasssub && hasSubstitute(foe);
  if (!stoppers.certain.length && !stoppers.possible.length && !Object.keys(erased).length && !Object.keys(hazards).length && !breaksSubstitute) return null;
  if (stoppers.certain.length) return { noDrag: stoppers.certain,
    ...(move.category === 'Status' ? { fails: true } : { onlyItsDamageLands: true }) };
  const bench = them.team.filter(p => !p.fainted && p.id !== them.activeId).map(p => p.species);
  const unrevealed = Math.max(0, (them.teamSize ?? 6) - them.team.length);
  return {
    ...(Object.keys(erased).length ? { erasesTheirStatChanges: erased } : {}),
    ...(breaksSubstitute ? { endsTheirSubstitute: true } : {}),
    dragsInAtRandom: { revealed: bench, ...(unrevealed ? { unrevealed } : {}) },
    ...(Object.keys(hazards).length ? { theReplacementEntersInto: hazards } : {}),
    ...(stoppers.possible.length ? { mightNotDrag: stoppers.possible } : {}),
  };
}
