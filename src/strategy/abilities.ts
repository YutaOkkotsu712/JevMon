import type { PokemonState } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { sampled } from './sampled.js';

/** Abilities that nullify a whole move type outright. The calculator applies these; naming them is the point. */
const absorbsType: Record<string, string> = {
  waterabsorb: 'Water', stormdrain: 'Water', dryskin: 'Water',
  voltabsorb: 'Electric', lightningrod: 'Electric', motordrive: 'Electric',
  flashfire: 'Fire', wellbakedbody: 'Fire', sapsipper: 'Grass',
  levitate: 'Ground', eartheater: 'Ground', windrider: 'Flying',
};
const absorbsFlag: Record<string, string> = { bulletproof: 'bullet', soundproof: 'sound', overcoat: 'powder' };
/** Abilities whose damage output changes once the holder is low enough, which moves an estimate mid-battle. */
const pinchAbilities: Record<string, { type: string; threshold: number; multiplier: number }> = {
  overgrow: { type: 'Grass', threshold: 100 / 3, multiplier: 1.5 },
  blaze: { type: 'Fire', threshold: 100 / 3, multiplier: 1.5 },
  torrent: { type: 'Water', threshold: 100 / 3, multiplier: 1.5 },
  swarm: { type: 'Bug', threshold: 100 / 3, multiplier: 1.5 },
  defeatist: { type: 'any', threshold: 50, multiplier: 0.5 },
};

/**
 * Abilities that stop a status move of their type outright, and usually profit from it: Volt Absorb against
 * Thunder Wave, Flash Fire against Will-O-Wisp, Sap Sipper against Spore. Listed by id, for sampled lookups.
 */
export function statusAbsorbers(moveName: string): string[] {
  const move = dex.moves.get(moveName);
  if (!move.exists || move.category !== 'Status') return [];
  const byType = Object.entries(absorbsType).filter(([key, type]) => type === move.type && !['levitate', 'windrider'].includes(key)).map(([key]) => key);
  return [...byType, ...(move.flags.sound ? ['soundproof'] : [])];
}

/** Why a given ability would take nothing at all from this move, or null if it would not. */
export function absorbedBy(ability: string, moveName: string): string | null {
  const move = dex.moves.get(moveName), key = id(ability);
  if (!move.exists || move.category === 'Status') return null;
  const type = absorbsType[key];
  if (type && move.type === type) return dex.abilities.get(key).name || ability;
  const flag = absorbsFlag[key];
  if (flag && move.flags[flag as keyof typeof move.flags]) return dex.abilities.get(key).name || ability;
  return null;
}

/**
 * A pinch ability changes what a Pokémon hits for as its HP falls, so an estimate taken now is not the
 * estimate that applies once it drops. Reported for either side; the opponent's ability may only be a
 * possibility, which the caller states.
 */
export function pinchAbility(p: PokemonState, ability: string | null = p.ability) {
  const entry = pinchAbilities[id(ability)];
  if (!entry || p.abilitySuppressed) return null;
  const hp = p.hpPercent;
  const active = hp !== null && hp <= entry.threshold;
  return { ability: dex.abilities.get(id(ability)).name, active,
    atOrBelowPercentOfMaxHP: Math.round(entry.threshold * 10) / 10,
    multiplier: entry.multiplier, appliesTo: entry.type === 'any' ? 'all its attacks' : `its ${entry.type} moves` };
}

/** Abilities that raise their holder each time it knocks a Pokémon out; Soul-Heart counts any faint at all. */
const onKnockout: Record<string, string> = {
  moxie: 'Attack', chillingneigh: 'Attack', asoneglastrier: 'Attack',
  grimneigh: 'Special Attack', asonespectrier: 'Special Attack', soulheart: 'Special Attack', beastboost: 'its highest stat',
};
/**
 * Every Pokémon we lose to this opponent also makes it stronger, which turns a sacrifice or a doomed stay into
 * a second cost. Only a possibility until the ability is revealed, so it carries the generation frequency.
 */
export function knockoutBoosts(foe: PokemonState) {
  const found = sampled(foe, 'abilities', Object.keys(onKnockout));
  return found.length ? found.map(a => ({ ability: a.name, probability: a.probability,
    gains: `${onKnockout[id(a.name)]} +1 per ${id(a.name) === 'soulheart' ? 'faint on either side' : 'knockout it scores'}` })) : null;
}

/** Effects our damaging move can hand the target when it lands. Some trigger on any hit,
 * Weak Armor on a physical hit, and others only on contact. The warning also covers
 * abilities that the search engine does not yet resolve. */
export function reactiveAbilityRisks(foe: PokemonState, moveName: string, canHit = true) {
  const move = dex.moves.get(moveName);
  if (!move.exists || move.category === 'Status' || !canHit || (foe.substitute && !move.multihit)) return null;
  const onDamage: Record<string, string> = {
    stamina: 'its Defense rises one stage after each hit it survives',
    cottondown: 'attacker loses one Speed stage after a damaging hit',
    cursedbody: 'up to 30% chance to disable the move that hit it',
  };
  const onContact: Record<string, string> = {
    roughskin: 'attacker loses 1/8 of its maximum HP per contact hit',
    ironbarbs: 'attacker loses 1/8 of its maximum HP per contact hit',
    static: 'up to 30% chance to paralyze the attacker on contact, if susceptible',
    flamebody: 'up to 30% chance to burn the attacker on contact, if susceptible',
    poisonpoint: 'up to 30% chance to poison the attacker on contact, if susceptible',
    effectspore: 'up to 30% chance to inflict sleep, paralysis or poison on contact, if susceptible',
    gooey: 'attacker loses one Speed stage on contact',
    tanglinghair: 'attacker loses one Speed stage on contact',
    mummy: 'attacker acquires Mummy on contact',
    lingeringaroma: 'attacker acquires Lingering Aroma on contact',
    wanderingspirit: 'attacker swaps abilities on contact',
    pickpocket: 'target may steal the attacker\'s removable item on contact if it holds none',
    perishbody: 'both Pokémon receive a three-turn perish count on contact',
    cutecharm: 'up to 30% chance to infatuate the attacker on contact, if genders are compatible',
  };
  const names = [...Object.keys(onDamage), ...(move.category === 'Physical' ? ['weakarmor'] : []),
    ...(move.flags.contact ? Object.keys(onContact) : [])];
  const found = sampled(foe, 'abilities', names);
  return found.length ? found.map(a => ({ ability: a.name, probability: a.probability,
    trigger: id(a.name) === 'weakarmor' ? 'each physical hit it survives'
      : onDamage[id(a.name)] ? 'damaging hit' : 'contact',
    effect: id(a.name) === 'weakarmor'
      ? 'its Defense can fall one stage and Speed can rise two stages per hit; it may outspeed us next turn'
      : onDamage[id(a.name)] ?? onContact[id(a.name)]! })) : null;
}

/**
 * Liquid Ooze turns whatever a draining move, Strength Sap or Leech Seed would restore into damage to the user.
 * Magic Guard blocks that damage, since it is not a direct hit.
 */
export function drainReversal(foe: PokemonState, moveName: string, user?: PokemonState) {
  const move = dex.moves.get(moveName);
  if (!move.exists || !(move.drain || ['leechseed', 'strengthsap'].includes(move.id))) return null;
  if (user && !user.abilitySuppressed && id(user.ability) === 'magicguard') return null;
  const ooze = sampled(foe, 'abilities', ['liquidooze'])[0];
  return ooze ? { ability: ooze.name, probability: ooze.probability,
    what: move.id === 'leechseed' ? 'each turn of seeding damages us by what it would have healed' : 'the HP it would restore is taken from us instead' } : null;
}

/** Abilities that ignore the other side's stat changes, which is what makes setting up against them futile. */
export const ignoresBoosts = (ability: string) => ['unaware'].includes(id(ability));

/** Abilities that read straight through whatever the other side's ability would have done. */
export const breaksMoulds = (p: PokemonState) =>
  !p.abilitySuppressed && ['moldbreaker', 'teravolt', 'turboblaze'].includes(id(p.ability));

/**
 * Pinch abilities across the sampled sets, for a Pokémon whose ability we may not know. A revealed ability
 * settles it; otherwise the probability is the mass of candidates carrying one.
 */
export function pinchAbilityRisk(p: PokemonState, candidates: { ability: string; probability: number }[]) {
  if (p.ability !== null) {
    const known = pinchAbility(p);
    return known ? { ...known, probability: 1 } : null;
  }
  const mass = candidates.reduce((n, c) => n + c.probability, 0);
  const carrying = candidates.filter(c => pinchAbility(p, c.ability));
  if (!carrying.length || mass <= 0) return null;
  const first = pinchAbility(p, carrying[0]!.ability)!;
  return { ...first, probability: Math.round(carrying.reduce((n, c) => n + c.probability, 0) / mass * 1000) / 1000 };
}
