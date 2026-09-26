import { dex, id } from './data.js';
import type { PokemonState, SideState } from '../battle/BattleState.js';

/** Type chart only: move-specific effects, abilities and items are separate uncertainties. */
/** Whether ground-based effects — terrain, Spikes, Earthquake — reach this Pokémon at all. */
export const grounded = (p: PokemonState) => !pokemonTypes(p).includes('Flying') &&
  (p.abilitySuppressed || id(p.ability) !== 'levitate') && id(p.item) !== 'airballoon' && !Object.keys(p.volatiles).some(k => id(k) === 'magnetrise');

export function typeEffectiveness(attackType: string, defenderTypes: string[]): number | null {
  const attack = dex.types.get(attackType);
  if (!attack.exists || attack.name === 'Stellar' || !defenderTypes.length) return null;
  let multiplier = 1;
  for (const type of defenderTypes) {
    const defender = dex.types.get(type);
    if (!defender.exists) return null;
    const code = defender.damageTaken[attack.name];
    multiplier *= code === 3 ? 0 : code === 1 ? 2 : code === 2 ? 0.5 : 1;
  }
  return multiplier;
}
export function pokemonTypes(p: PokemonState): string[] {
  const species = dex.species.get(p.transformedInto ?? p.species);
  let types = species.exists ? [...species.types] as string[] : [];
  const changed = p.volatiles.typechange?.data;
  if (changed) types = changed.split('/');
  const added = p.volatiles.typeadd?.data;
  if (added && !types.includes(added)) types.push(added);
  if (p.terastallized && p.teraType && p.teraType !== 'Stellar') return [p.teraType];
  return types;
}
export function baseStab(moveType: string, p: PokemonState, teraType?: string): number | null {
  const original = dex.species.get(p.transformedInto ?? p.species);
  if (!original.exists) return null;
  const tera = teraType ?? (p.terastallized ? p.teraType : null);
  if (tera === 'Stellar' || (p.transformedInto && tera)) return null;
  const changed = p.volatiles.typechange?.data?.split('/');
  const types: string[] = changed ?? [...original.types];
  if (p.volatiles.typeadd?.data) types.push(p.volatiles.typeadd.data);
  const originalMatch = types.includes(moveType);
  if (tera === moveType) return originalMatch ? 2 : 1.5;
  return originalMatch ? 1.5 : 1;
}
export function hazardExposure(p: PokemonState, side: SideState) {
  const types = pokemonTypes(p);
  const rockMultiplier = typeEffectiveness('Rock', types);
  const rock = side.hazards['Stealth Rock'] ? rockMultiplier === null ? null : rockMultiplier * 12.5 : 0;
  const spikes = [0, 12.5, 100 / 6, 25][Math.min(3, side.hazards.Spikes ?? 0)]!;
  return { stealthRockPercentBeforePrevention: rock,
    spikesPercentIfGrounded: spikes,
    toxicSpikesLayers: side.hazards['Toxic Spikes'] ?? 0, stickyWeb: !!side.hazards['Sticky Web'],
    knownBoots: id(p.item) === 'heavydutyboots' };
}
export function boostedStat(value: number, stage: number): number {
  const s = Math.max(-6, Math.min(6, stage));
  return Math.floor(value * (s >= 0 ? (2 + s) / 2 : 2 / (2 - s)));
}

/** Conditional Gen 9 field factors, before grounding/suppression and other modifiers. */
export function fieldFactors(moveType: string, moveId: string, weather: string | null, terrain: string | null) {
  let weatherIfUnsuppressed = 1;
  if (weather === 'RainDance') weatherIfUnsuppressed = moveType === 'Water' ? 1.5 : moveType === 'Fire' ? 0.5 : 1;
  if (weather === 'SunnyDay') weatherIfUnsuppressed = moveType === 'Fire' ? 1.5 : moveType === 'Water' ? 0.5 : 1;
  const boost = terrain === 'Electric Terrain' ? 'Electric' : terrain === 'Grassy Terrain' ? 'Grass' : terrain === 'Psychic Terrain' ? 'Psychic' : null;
  return { weatherIfUnsuppressed, terrainIfAttackerGrounded: boost === moveType ? 1.3 : 1,
    terrainIfDefenderGrounded: (terrain === 'Misty Terrain' && moveType === 'Dragon') ||
      (terrain === 'Grassy Terrain' && ['earthquake', 'bulldoze', 'magnitude'].includes(moveId)) ? 0.5 : 1 };
}

/**
 * Effects the dex carries in code rather than in data, so they are invisible to anything reading the move.
 * Belly Drum is the one that matters most: without this it looks like a move that does nothing at all.
 */
const undescribed: Record<string, { boosts?: Record<string, number>; costsPercentOfMaxHP?: number; note?: string }> = {
  bellydrum: { boosts: { atk: 6 }, costsPercentOfMaxHP: 50, note: 'maximises Attack at the cost of half the user\'s max HP' },
  filletaway: { costsPercentOfMaxHP: 50 },
  takeheart: { boosts: { spa: 1, spd: 1 }, note: 'also cures the user\'s status' },
  tidyup: { boosts: { atk: 1, spe: 1 }, note: 'also clears hazards and Substitutes from both sides' },
  haze: { note: 'resets every stat change on both sides' },
  healbell: { note: 'cures the status of the whole team' },
  aromatherapy: { note: 'cures the status of the whole team' },
  trick: { note: 'swaps items with the target, which can hand a Choice item over or take one away' },
  switcheroo: { note: 'swaps items with the target, which can hand a Choice item over or take one away' },
  defog: { note: 'also lowers the target\'s evasion' },
  courtchange: { note: 'swaps every hazard and screen between the two sides' },
  // Damaging moves whose defining effect lives in code: the damage number alone misdescribes each of them.
  knockoff: { note: 'removes the target\'s held item for the rest of the battle if it survives the hit, and does 1.5x damage while it holds one; unremovable items and Sticky Hold keep theirs' },
  futuresight: { note: 'hits two turns from now, on whichever Pokémon is then in that slot, not this turn; fails if one is already pending there' },
  meteorbeam: { boosts: { spa: 1 } },
  // A rampage locks its user in and it cannot switch out; a switch-in immune to the move takes the whole lock for free.
  outrage: { note: 'locks the user into this move for two or three turns, unable to switch, then confuses it' },
  petaldance: { note: 'locks the user into this move for two or three turns, unable to switch, then confuses it' },
  thrash: { note: 'locks the user into this move for two or three turns, unable to switch, then confuses it' },
  ragingfury: { note: 'locks the user into this move for two or three turns, unable to switch, then confuses it' },
};
/**
 * The accuracy a move actually has for this user in this weather, when that differs from the listed figure.
 * Rain makes Hurricane, Thunder and the storm moves certain and sun drops Hurricane and Thunder to half; snow
 * makes Blizzard certain; Utility Umbrella shields its holder from rain and sun. No Guard, Compound Eyes,
 * Hustle and Wide Lens are the user's own modifiers. Stat stages and the target's side are not included.
 */
function accuracyNow(m: ReturnType<typeof dex.moves.get>, weather: string | null, user?: PokemonState): number | 'cannot-miss' | undefined {
  if (m.accuracy === true || m.ohko) return undefined;
  const ability = user && !user.abilitySuppressed ? id(user.ability) : '', item = user ? id(user.item) : '';
  if (ability === 'noguard') return 'cannot-miss';
  const w = item === 'utilityumbrella' && ['RainDance', 'PrimordialSea', 'SunnyDay', 'DesolateLand'].includes(weather ?? '') ? null : weather;
  const rain = ['RainDance', 'PrimordialSea'].includes(w ?? ''), sun = ['SunnyDay', 'DesolateLand'].includes(w ?? '');
  if (rain && ['hurricane', 'thunder', 'bleakwindstorm', 'wildboltstorm', 'sandsearstorm'].includes(m.id)) return 'cannot-miss';
  if (['Snow', 'Hail'].includes(w ?? '') && m.id === 'blizzard') return 'cannot-miss';
  let accuracy = sun && ['hurricane', 'thunder'].includes(m.id) ? 50 : m.accuracy;
  if (ability === 'compoundeyes') accuracy *= 5325 / 4096;
  if (ability === 'hustle' && m.category === 'Physical') accuracy *= 3277 / 4096;
  if (item === 'widelens') accuracy *= 4505 / 4096;
  const now = Math.min(100, Math.round(accuracy * 10) / 10);
  return now === m.accuracy ? undefined : now;
}

/**
 * The percent chance a move connects now, all things known: the weather, the user's ability and item, accuracy against
 * evasion stages, and the target's own evasion — Sand Veil in sand, Snow Cloak in snow, Bright Powder, Tangled Feet
 * while confused, Wonder Skin against status. No Guard on either side, and a Poison type's Toxic, never miss. Unknown
 * abilities and items are not guessed at; they only ever lower the figure.
 */
export function hitChancePercent(moveName: string, weather: string | null, user: PokemonState, target: PokemonState): number {
  const m = dex.moves.get(moveName);
  if (m.accuracy === true) return 100;
  const ability = (p: PokemonState) => (p.abilitySuppressed ? '' : id(p.ability));
  const theirs = ability(target), ours = ability(user);
  if (ours === 'noguard' || theirs === 'noguard') return 100;
  if (m.id === 'toxic' && pokemonTypes(user).includes('Poison')) return 100;
  const now = accuracyNow(m, weather, user);
  if (now === 'cannot-miss') return 100;
  let accuracy = now ?? m.accuracy;
  if (m.category === 'Status' && theirs === 'wonderskin' && accuracy > 50) accuracy = 50;
  // Keen Eye, Mind's Eye and Unaware read through a raised evasion; Unaware ignores the stages outright.
  const evasion = target.boosts.evasion ?? 0;
  const seen = ['keeneye', 'mindseye'].includes(ours) ? Math.min(0, evasion) : ours === 'unaware' ? 0 : evasion;
  const stage = Math.max(-6, Math.min(6, (user.boosts.accuracy ?? 0) - seen));
  accuracy *= stage >= 0 ? (3 + stage) / 3 : 3 / (3 - stage);
  const w = weather ?? '';
  if ((theirs === 'sandveil' && w === 'Sandstorm') || (theirs === 'snowcloak' && ['Snow', 'Snowscape', 'Hail'].includes(w))) accuracy *= 3277 / 4096;
  if (['brightpowder', 'laxincense'].includes(id(target.item))) accuracy *= 3686 / 4096;
  if (theirs === 'tangledfeet' && Object.keys(target.volatiles).some(k => id(k) === 'confusion')) accuracy *= 0.5;
  return Math.min(100, Math.round(accuracy * 10) / 10);
}

/**
 * A two-turn move spends this turn charging, so none of its damage lands now and the user is committed to it.
 * Sun skips Solar Beam's charge and rain skips Electro Shot's; Power Herb skips any, once.
 */
function chargeTurn(m: ReturnType<typeof dex.moves.get>, weather: string | null, user?: PokemonState) {
  if (!m.flags.charge) return undefined;
  if (['solarbeam', 'solarblade'].includes(m.id) && ['SunnyDay', 'DesolateLand'].includes(weather ?? '')) return undefined;
  if (m.id === 'electroshot' && ['RainDance', 'PrimordialSea'].includes(weather ?? '')) return undefined;
  if (user && id(user.item) === 'powerherb') return undefined;
  return 'spends this turn charging and hits next turn, so none of its damage lands now and a knockout before then wastes both turns';
}
/** Whether this move spends the turn charging now: no Power Herb, and no sun or rain to skip the charge. */
export function chargesThisTurn(moveName: string, weather: string | null, user: PokemonState): boolean {
  return !!chargeTurn(dex.moves.get(moveName), weather, user);
}
/** The dex omits these amounts because they depend on the weather, so compute them from the current weather. */
const weatherHealing = ['synthesis', 'moonlight', 'morningsun', 'shoreup'];
const variableHealing: Record<string, string> = {
  strengthsap: 'heals by the target\'s current Attack stat and lowers it by one stage',
  painsplit: 'averages both Pokémon\'s current HP, so it only helps below the target',
  wish: 'heals half the user\'s max HP at the end of the next turn, not now',
};
function conditionalHeal(moveId: string, weather: string | null): number | undefined {
  if (moveId === 'rest') return 100;
  if (moveId === 'junglehealing' || moveId === 'lunarblessing') return 25;
  if (!weatherHealing.includes(moveId)) return undefined;
  const boosted = moveId === 'shoreup' ? ['Sandstorm'] : ['SunnyDay', 'DesolateLand'];
  if (weather && boosted.includes(weather)) return Math.round(2 / 3 * 1000) / 10;
  // Any other weather halves these moves; Shore Up is unaffected by weather other than sand.
  const weakened = weather && !boosted.includes(weather) && moveId !== 'shoreup';
  return weakened ? 25 : 50;
}
/**
 * The share of max HP a self-healing status move restores this turn, or undefined when it is not a fixed amount now:
 * Strength Sap, Pain Split and Wish vary or land later, and Rest also puts the user to sleep.
 */
export function healPercentNow(moveName: string, weather: string | null): number | undefined {
  const m = dex.moves.get(moveName);
  if (!m.exists || m.category !== 'Status' || m.id === 'rest' || variableHealing[m.id]) return undefined;
  const conditional = conditionalHeal(m.id, weather);
  if (conditional !== undefined) return conditional;
  return m.heal && m.target === 'self' ? Math.round(m.heal[0]! / m.heal[1]! * 1000) / 10 : undefined;
}
/** Listed self-stage changes after ability modifiers; protocol boosts are already resolved and must not use this twice. */
export function selfStageChanges(user: PokemonState | undefined, listed: Record<string, number>) {
  const ability = user && !user.abilitySuppressed ? id(user.ability) : '';
  const factor = ability === 'contrary' ? -1 : ability === 'simple' ? 2 : 1;
  return Object.fromEntries(Object.entries(listed).map(([stat,n])=>[stat,n*factor]));
}

/**
 * Non-damage consequences of a move: recovery, boosts, status, hazards, field and forced switches.
 * Listed effects only, before abilities, items, immunities, protection and existing conditions.
 */
export function moveEffect(moveName: string, maxHP: number | null, weather: string | null = null, user?: PokemonState) {
  const m = dex.moves.get(moveName);
  if (!m.exists) return null;
  // Sheer Force trades a move's secondary effect for more damage, so advertising the secondary is wrong.
  const sheerForce = !!user && !user.abilitySuppressed && id(user.ability) === 'sheerforce' && !!m.secondaries?.length;
  // Serene Grace doubles every secondary chance, which turns Air Slash into a 60% flinch.
  const grace = !!user && !user.abilitySuppressed && id(user.ability) === 'serenegrace' ? 2 : 1;
  const chance = (c: number | undefined) => (typeof c === 'number' ? Math.min(100, c * grace) : c);
  const fraction = (v: readonly number[] | undefined) => (v?.length === 2 && v[1] ? Math.round(v[0]! / v[1] * 1000) / 10 : undefined);
  const self = m.target === 'self';
  const heal = fraction(m.heal) ?? conditionalHeal(m.id, weather);
  // Diamond Storm's +2 Defense happens half the time, which the payload once gave as certain: it told Jev Diamond Storm
  // cut Palafin's Jet Punch from 81.5% to 41.7%, as much as Tera Fairy would, and Diancie did not Terastallize and fell
  // to the second Jet Punch. Serene Grace makes it certain; Sheer Force removes it even though it is not a secondary.
  const listedSelfChance = (m.self as { chance?: number } | undefined)?.chance;
  const selfChance = typeof listedSelfChance === 'number' && listedSelfChance < 100 ? (sheerForce ? 0 : chance(listedSelfChance)!) : 100;
  // Torch Song, Power-Up Punch, Rapid Spin and Flame Charge list their boost as a secondary on the user. A certain one is
  // the move's own boost, as Swords Dance's is; a chance one (Charge Beam's 70%) is a boost only sometimes. Listed only
  // among the secondaries, they got no setup projection, though Torch Song raises its Special Attack every hit.
  const secondarySelf = sheerForce ? [] : (m.secondaries ?? []).filter(e => e.self?.boosts)
    .map(e => ({ boosts: e.self!.boosts as Record<string, number>, chance: chance(e.chance ?? 100)! }));
  const certainSecondary = Object.assign({}, ...secondarySelf.filter(e => e.chance >= 100).map(e => e.boosts)) as Record<string, number>;
  const chancedSecondary = secondarySelf.find(e => e.chance > 0 && e.chance < 100);
  const chancedUserBoosts = selfChance > 0 && selfChance < 100 && m.self?.boosts ? m.self.boosts as Record<string, number>
    : chancedSecondary?.boosts;
  const chancedPercent = selfChance > 0 && selfChance < 100 && m.self?.boosts ? selfChance : chancedSecondary?.chance ?? selfChance;
  // Scale Shot keeps its boosts under selfBoost, which applies after the final hit.
  const listedUserBoosts = { ...(self && m.boosts ? m.boosts : {}), ...(selfChance >= 100 ? m.self?.boosts ?? {} : {}), ...(m.selfBoost?.boosts ?? {}),
    ...certainSecondary, ...(undescribed[m.id]?.boosts ?? {}) } as Record<string,number>;
  const effect = {
    healPercentOfMaxHP: heal,
    healHPIfKnown: heal !== undefined && maxHP ? Math.floor(maxHP * heal / 100) : undefined,
    healVariesWithWeather: weatherHealing.includes(m.id) || undefined,
    healingIsVariable: variableHealing[m.id],
    revivesFaintedTeammateToHalfHP: m.id === 'revivalblessing' || undefined,
    sleepsUserUntilCured: m.id === 'rest' || undefined,
    drainPercentOfDamageDealt: fraction(m.drain),
    recoilPercentOfDamageDealt: fraction(m.recoil),
    userBoosts: selfStageChanges(user, listedUserBoosts),
    ...(Object.keys(listedUserBoosts).length ? { listedUserBoosts } : {}),
    ...(chancedUserBoosts ? { userBoostsOnlySometimes: { boosts: chancedUserBoosts, chancePercent: chancedPercent } } : {}),
    costsPercentOfMaxHP: undescribed[m.id]?.costsPercentOfMaxHP,
    alsoDoes: undescribed[m.id]?.note,
    // Explosion's damage is not a free hit: it spends the user.
    userFaints: m.selfdestruct === 'always' ? 'whether or not it hits' : m.selfdestruct ? 'if it hits' : undefined,
    // Supercell Slam cost Zebstrika half its HP twice in a row, into an Alomomola that Protected both times.
    crashesForHalfOurHPIf: m.hasCrashDamage ? 'it misses, is blocked by Protect or hits an immune target' : undefined,
    chargesFirst: chargeTurn(m, weather, user),
    targetBoosts: !self && m.boosts ? m.boosts : undefined,
    inflictsStatus: m.status,
    userVolatile: m.self?.volatileStatus ?? (self ? m.volatileStatus : undefined),
    // Hyper Beam and Giga Impact cost the user its next turn, which a Truant user was going to lose anyway: the recharge
    // turn and the loafing turn are the same one, so for Slaking the strongest move is free.
    losesItsNextTurnToRecharge: m.self?.volatileStatus === 'mustrecharge'
      ? (user && !user.abilitySuppressed && id(user.ability) === 'truant' ? 'no cost: Truant loses that turn anyway' : true) : undefined,
    targetVolatile: self ? undefined : m.volatileStatus,
    sideCondition: m.sideCondition,
    setsWeather: m.weather,
    setsTerrain: m.terrain,
    setsFieldEffect: m.pseudoWeather,
    forcesTargetSwitch: m.forceSwitch || undefined,
    switchesUserOut: m.selfSwitch && m.id !== 'revivalblessing' ? true : undefined,
    listedAccuracyPercent: m.accuracy === true ? 'cannot-miss' : m.accuracy,
    accuracyPercentNow: accuracyNow(m, weather, user),
    // Diamond Storm lists an empty secondary only so that Sheer Force applies; it is not an effect.
    secondaryEffects: sheerForce ? undefined : m.secondaries?.map(e => ({ chancePercent: chance(e.chance), status: e.status, volatileStatus: e.volatileStatus, targetBoosts: e.boosts, self: e.self }))
      .filter(e => Object.values(e).some(v => v !== undefined)),
    secondaryChancePercent: sheerForce ? undefined : m.secondaries?.map(x => chance(x.chance)).filter((x): x is number => typeof x === 'number'),
    secondaryChanceDoubledBySereneGrace: !sheerForce && grace > 1 && !!m.secondaries?.length || undefined,
    secondaryRemovedBySheerForce: sheerForce || undefined,
  };
  if (!Object.keys(effect.userBoosts).length) delete (effect as { userBoosts?: unknown }).userBoosts;
  if (!effect.secondaryChancePercent?.length) delete (effect as { secondaryChancePercent?: unknown }).secondaryChancePercent;
  if (!effect.secondaryEffects?.length) delete (effect as { secondaryEffects?: unknown }).secondaryEffects;
  const entries = Object.entries(effect).filter(([, v]) => v !== undefined);
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * A Substitute absorbs whatever is aimed at its holder unless the move bypasses it (sound moves, Whirlwind,
 * Taunt and the rest carry the flag) or the attacker has Infiltrator. Status moves are wasted entirely;
 * damaging moves hit the Substitute instead of the Pokémon.
 */
export function substituteInteraction(moveName: string, attacker: PokemonState, target: PokemonState) {
  const move = dex.moves.get(moveName);
  if (!move.exists || !Object.keys(target.volatiles).some(k => id(k) === 'substitute')) return null;
  if (!['normal', 'allAdjacent', 'allAdjacentFoes', 'randomNormal', 'any'].includes(move.target)) return null;
  const infiltrator = !attacker.abilitySuppressed && id(attacker.ability) === 'infiltrator';
  // The glossary says what each effect means, so only the non-obvious cause of a bypass is named here.
  if (move.flags.bypasssub || infiltrator) {
    return { effect: 'bypasses-substitute' as const, ...(infiltrator ? { why: 'Infiltrator' } : {}) };
  }
  return move.category === 'Status'
    ? { effect: 'absorbed-entirely' as const }
    : { effect: 'damages-substitute-first' as const };
}
