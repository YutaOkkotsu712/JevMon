import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { calcStat, type StatID } from '@smogon/calc';
import { dex, id } from '../pokemon/data.js';
import { fittedSpread, levelOf } from './calcCore.js';
import { incomingThreats, outgoingBest } from './threat.js';
import { speedSummary } from './speed.js';
import { pokemonTypes } from '../pokemon/mechanics.js';

const stats: StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
type Species = ReturnType<typeof dex.species.get>;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/**
 * Some moves change the user's form, which changes its typing and its stats — Relic Song turning Meloetta
 * into its Pirouette form is the one that matters in random battles. That is easy to miss twice over: the
 * move looks like an ordinary attack, and the typing it grants can otherwise only be had by spending Tera,
 * which is available once per battle. So the projection says what the form becomes and what it keeps.
 *
 * The form reverts on switching out, and this looks one step ahead against the Pokémon currently out.
 */
/** Sibling formes of whatever this Pokémon currently is, including the ones its base species lists. */
function siblings(current: ReturnType<typeof dex.species.get>) {
  const base = dex.species.get(current.baseSpecies || current.name);
  return [...new Set([...(current.otherFormes ?? []), ...(base.otherFormes ?? [])])]
    .map(name => dex.species.get(name)).filter(f => f.exists && f.name !== current.name);
}
export function formeChange(s: BattleState, me: PokemonState, side: SideId, moveName: string) {
  const current = dex.species.get(me.species);
  if (!current.exists || me.transformedInto) return null;
  const target = siblings(current).find(f => f.requiredMove && id(f.requiredMove) === id(moveName));
  return target ? project(s, me, side, current, target, 'move') : null;
}

/**
 * Terapagos is the one Pokémon whose Terastallisation changes its form rather than only its type, and the
 * change costs it Tera Shell — the ability that halves every hit while it is at full health. Terastallising
 * can therefore turn a resisted hit into a full one, which is invisible if Tera is treated as a type change.
 */
/**
 * Zero to Hero transforms Palafin when it switches out, and it comes back far stronger — base Attack goes
 * from 70 to 160. That makes switching a benefit rather than a cost, which is the opposite of how every
 * other switch is priced here, and nothing about the move list or the ability name says so.
 *
 * The projection is against the Pokémon currently out, as a measure of the gain rather than a plan.
 */
export function switchOutForme(s: BattleState, me: PokemonState, side: SideId) {
  const current = dex.species.get(me.species);
  if (!current.exists || me.transformedInto || me.abilitySuppressed) return null;
  const target = siblings(current).find(f =>
    f.requiredAbility && id(f.requiredAbility) === 'zerotohero' && id(f.requiredAbility) === id(me.ability));
  if (!target) return null;
  const projected = project(s, me, side, current, target, 'switch');
  return projected && { ...projected, happensOnSwitchingOut: true };
}

export function teraFormeChange(s: BattleState, me: PokemonState, side: SideId) {
  const current = dex.species.get(me.species);
  if (!current.exists || me.transformedInto || me.terastallized) return null;
  const target = siblings(current).find(f => f.forme === 'Stellar');
  return target ? project(s, me, side, current, target, 'tera') : null;
}

/** `me` as the target form: its stats recomputed from the same spread, and its ability if it still had the default. */
function reformed(me: PokemonState, current: Species, target: Species) {
  let spread;
  try { spread = fittedSpread(me); } catch { return null; }
  const level = levelOf(me);
  const recomputed: Record<string, number> = {};
  for (const stat of stats) {
    recomputed[stat] = calcStat(9, stat, target.baseStats[stat], spread.ivs[stat], spread.evs[stat], level, 'Serious');
  }
  const maxHP = recomputed.hp!;
  // A forme brings its own ability. Only replace one the Pokémon still has by default, so an ability that
  // was acquired or revealed as something else is not overwritten.
  const currentDefault = Object.values(current.abilities)[0];
  const targetDefault = Object.values(target.abilities)[0];
  const abilityChanges = !!targetDefault && !!currentDefault && id(me.ability) === id(currentDefault) && targetDefault !== currentDefault;
  const after: PokemonState = { ...structuredClone(me),
    species: target.name, details: me.details.replace(current.name, target.name),
    ...(abilityChanges ? { ability: targetDefault } : {}),
    stats: Object.fromEntries(stats.filter(x => x !== 'hp').map(x => [x, recomputed[x]!])),
    ...(me.exactHP ? { exactHP: { current: Math.max(1, Math.round(me.exactHP.current / me.exactHP.max * maxHP)), max: maxHP } } : {}) };
  return { after, abilityChanges, currentDefault, targetDefault };
}

/** Embody Aspect raises one stat the moment Ogerpon Terastallises, chosen by its mask. */
const embodied: Record<string, { stat: string; name: string }> = {
  embodyaspectteal: { stat: 'spe', name: 'Speed' }, embodyaspecthearthflame: { stat: 'atk', name: 'Attack' },
  embodyaspectwellspring: { stat: 'spd', name: 'Special Defense' }, embodyaspectcornerstone: { stat: 'def', name: 'Defense' },
};

/**
 * `me` as it would be after Terastallising, for the two Pokémon whose Tera is more than a type change. Ogerpon
 * takes its Tera form and Embody Aspect raises a stat at once, so this very turn's damage or turn order uses it.
 * Terapagos becomes Terapagos-Stellar: 160 base HP and 130 Special Attack, but no Tera Shell. Anyone else is
 * returned unchanged, since the Tera type itself is passed to the calculator separately.
 */
export function afterTerastallizing(me: PokemonState, teraType: string): PokemonState {
  if (me.terastallized || me.transformedInto) return me;
  const current = dex.species.get(me.species);
  const target = current.exists ? siblings(current).find(f => f.forme === 'Stellar' ||
    (f.forme.endsWith('Tera') && [f.battleOnly].flat().includes(current.name))) : undefined;
  const after = target && reformed(me, current, target)?.after;
  if (!after) return me;
  after.terastallized = true; after.teraType = teraType;
  const aspect = !after.abilitySuppressed ? embodied[id(after.ability)] : undefined;
  if (aspect) after.boosts = { ...after.boosts, [aspect.stat]: Math.min(6, (after.boosts[aspect.stat] ?? 0) + 1) };
  return after;
}

/** What Terastallising raises beyond the type, when it raises anything: only Ogerpon's Embody Aspect does. */
export function teraAlsoRaises(me: PokemonState, teraType: string) {
  const after = afterTerastallizing(me, teraType);
  const aspect = after !== me && !after.abilitySuppressed ? embodied[id(after.ability)] : undefined;
  return aspect ? `${aspect.name} +1 from ${after.ability}, this turn` : null;
}

function project(s: BattleState, me: PokemonState, side: SideId,
  current: Species, target: Species, trigger: 'move' | 'tera' | 'switch') {
  const made = reformed(me, current, target);
  if (!made) return null;
  const { after, abilityChanges, currentDefault, targetDefault } = made;
  const before = { ...me };
  const shifts = Object.fromEntries(stats
    .map(stat => [stat, target.baseStats[stat] - current.baseStats[stat]] as const)
    .filter(([, delta]) => delta !== 0).map(([stat, delta]) => [stat, signed(delta)]));
  const wasTypes = pokemonTypes(before), becomesTypes = pokemonTypes(after);
  const damageBefore = outgoingBest(s, before, side, 1), damageAfter = outgoingBest(s, after, side, 1);
  const takenBefore = incomingThreats(s, before, side, 1), takenAfter = incomingThreats(s, after, side, 1);
  const speedBefore = speedSummary(s, before).relation, speedAfter = speedSummary(s, after).relation;
  return {
    becomes: target.name,
    types: becomesTypes, wasTypes,
    ...(abilityChanges ? { abilityBecomes: targetDefault, wasAbility: currentDefault } : {}),
    baseStatShifts: shifts,
    ...(damageAfter ? { ourBestDamagePercentAfter: damageAfter.bestCasePercentOfMaxHP,
      ...(damageBefore ? { wasBefore: damageBefore.bestCasePercentOfMaxHP } : {}) } : {}),
    ...(takenAfter?.worstCasePercentOfMaxHP !== null && takenAfter !== null
      ? { worstIncomingPercentAfter: takenAfter.worstCasePercentOfMaxHP,
          ...(takenBefore?.worstCasePercentOfMaxHP !== null && takenBefore ? { incomingWasBefore: takenBefore.worstCasePercentOfMaxHP } : {}) } : {}),
    ...(speedAfter !== speedBefore ? { speedRelationBecomes: speedAfter } : {}),
    // A move-driven change is the point easiest to miss: it reaches the new form without spending Tera,
    // and it is undone by switching. Terastallising into a form spends the Tera and is permanent.
    ...(trigger === 'move'
      ? { ...(me.terastallized ? {} : { reachesThisFormWithoutSpendingTera: true }), revertsOnSwitchingOut: true }
      : trigger === 'tera' ? { spendsOurTera: true, permanent: true }
      : { costsNothingButTheSwitchItself: true, permanent: true }),
  };
}
