import joint from '../data/gen9-joint-sets.json' with { type: 'json' };
import pools from '../data/gen9-sets.json' with { type: 'json' };
import { datasetSpeciesId, dex, id } from '../pokemon/data.js';
import type { Candidate } from '../strategy/setTypes.js';

/**
 * The hidden part of an opposing team, drawn the way Showdown's Gen 9 generator builds one (randomTeam in
 * data/random-battles/gen9/teams.ts). It picks a base species with weight min(ceil(formes / 3), 3), Squawkabilly 1, then
 * one of its formes evenly, and skips any Pokémon that breaks a team rule: two of a type, three weak to a type, one
 * double weakness to a type, four weak to Freeze-Dry, one level 100, and a few pairs it never puts together. Each rule
 * caps a count over the whole team, so every generated team keeps it against any subset of its members: a candidate
 * that breaks one against the Pokémon we have seen cannot be on that team. They are hard limits, not preferences.
 * Checked against 20,000 generated teams: every member fits the other five (scripts/check-team-rules.mjs).
 */
const keys = new Set(Object.keys(joint.species));
const levels = pools as Record<string, { level: number }>;
export const baseSpecies = (name: string) => id(dex.species.get(name).baseSpecies || name);

const formes = new Map<string, string[]>();
for (const key of keys) formes.set(baseSpecies(key), [...formes.get(baseSpecies(key)) ?? [], key]);
/** The generator's chance of each forme, before any team rule. */
export const speciesPrior = new Map<string, number>();
for (const [base, list] of formes) {
  const weight = base === 'squawkabilly' ? 1 : Math.min(Math.ceil(list.length / 3), 3);
  for (const key of list) speciesPrior.set(key, weight / list.length);
}

interface Profile { key: string; base: string; types: string[]; weak: string[]; doubleWeak: string[]; freezeDry: boolean; level100: boolean;
  /** Fire-neutral with Dry Skin or Fluffy: the generator counts that as a Fire weakness. */
  fireAbility: boolean;
  /** A Tera Blast user, or Ogerpon, Ogerpon-Hearthflame or Terapagos, of which the generator puts one on a team. */
  teraBlast: boolean }
/** The generator's getEffectiveness: an immunity counts as neutral, so Ground is a weakness of Skarmory. */
function effectiveness(attack: string, types: string[]) {
  return types.reduce((n, t) => n + ({ 1: 1, 2: -1 }[dex.types.get(t).damageTaken[attack] as number] ?? 0), 0);
}
const attackTypes = [...dex.types.all()].map(t => t.name).filter(t => t !== 'Stellar');
const profiles = new Map<string, Profile>();
const fireAbilities = ['dryskin', 'fluffy'];
const teraBlastSpecies = ['ogerpon', 'ogerponhearthflame', 'terapagos'];
const setAbilities = pools as Record<string, { sets?: { abilities?: string[]; role?: string }[] }>;
/**
 * `ability` and `moves` are what is known of the set. The generator's Fire rule reads the chosen ability for a member
 * already on the team, so an unknown one counts only when every set of the species has Dry Skin or Fluffy; a candidate
 * is refused if any of its abilities could be one.
 */
function profileOf(key: string, level?: number, known: { ability?: string | null; moves?: string[] } = {}): Profile {
  const plain = level === undefined && known.ability === undefined && known.moves === undefined;
  const cached = plain ? profiles.get(key) : undefined;
  if (cached) return cached;
  const species = dex.species.get(key), types = [...species.types];
  const ice = effectiveness('Ice', types);
  const fireNeutral = effectiveness('Fire', types) === 0;
  const allSetsFire = (setAbilities[key]?.sets ?? []).length > 0 &&
    (setAbilities[key]?.sets ?? []).every(r => (r.abilities ?? []).every(a => fireAbilities.includes(id(a))));
  const p = { key, base: baseSpecies(key), types,
    weak: attackTypes.filter(t => effectiveness(t, types) > 0), doubleWeak: attackTypes.filter(t => effectiveness(t, types) > 1),
    freezeDry: ice > 0 || ice > -2 && types.includes('Water'), level100: (level ?? levels[key]?.level) === 100,
    fireAbility: fireNeutral && (known.ability ? fireAbilities.includes(id(known.ability))
      : plain ? Object.values(species.abilities).some(a => fireAbilities.includes(id(a))) : allSetsFire),
    teraBlast: teraBlastSpecies.includes(key) || (known.moves ?? []).some(m => id(m) === 'terablast') };
  if (plain) profiles.set(key, p);
  return p;
}
/** A revealed Pokémon as the generator chose it: the listed forme a battle forme came from, at its shown level, with
 * whatever of its ability and moves has been seen. */
export function revealedProfile(species: string, details?: string, known: { ability?: string | null; moves?: string[] } = {}) {
  const level = Number(/, L(\d+)/.exec(details ?? '')?.[1] ?? 100);
  return profileOf(datasetSpeciesId(species, keys), level, { ability: known.ability ?? null, moves: known.moves ?? [] });
}

const webSetters = ['ariados', 'smeargle', 'masquerain', 'kricketune', 'leavanny', 'galvantula', 'vikavolt', 'ribombee', 'araquanid', 'spidops'];
const screenSetters = ['meowstic', 'grimmsnarl', 'ninetalesalola', 'abomasnow'];
const INCOMPATIBLE: [string[], string[]][] = [[['blissey'], ['chansey']], [['illumise'], ['volbeat']], [webSetters, webSetters],
  [screenSetters, screenSetters], [['toxicroak'], ['ninetales', 'torkoal', 'groudon', 'koraidon']]];

/** Whether the generator could have put this Pokémon on a team already holding these. */
export function fitsTeam(candidate: string, team: Profile[]) {
  const c = profileOf(candidate);
  const count = (f: (p: Profile) => boolean) => team.reduce((n, p) => n + (f(p) ? 1 : 0), 0);
  if (team.some(p => p.base === c.base)) return false;
  if (c.types.some(t => count(p => p.types.includes(t)) >= 2)) return false;
  // Dry Skin and Fluffy on a Fire-neutral Pokémon count as a Fire weakness, for the one being added and those already in.
  const weak = (t: string) => count(p => p.weak.includes(t) || (t === 'Fire' && p.fireAbility));
  if (c.weak.some(t => weak(t) >= 3) || (c.fireAbility && weak('Fire') >= 3)) return false;
  if (c.doubleWeak.some(t => count(p => p.doubleWeak.includes(t)) >= 1)) return false;
  if (c.freezeDry && count(p => p.freezeDry) >= 4) return false;
  if (c.level100 && count(p => p.level100) >= 1) return false;
  // Ogerpon, Ogerpon-Hearthflame and Terapagos are never added beside a Tera Blast user, or each other.
  if (teraBlastSpecies.includes(c.key) && team.some(p => p.teraBlast)) return false;
  for (const [a, b] of INCOMPATIBLE) {
    if (b.includes(c.key) && team.some(p => a.includes(p.key))) return false;
    if (a.includes(c.key) && team.some(p => b.includes(p.key))) return false;
  }
  return true;
}
export type { Profile as TeamProfile };

/**
 * Once a team holds one of these, the generator drops it from later movepools, so a second holder is rare. The factors
 * are how often two holders share a team, against the same Pokémon shuffled into independent teams, over 20,000
 * generated teams: Stealth Rock 0.056, Toxic Spikes 0.016, Defog and the spins 0.32, Spikes 0.84, and none at all for
 * Sticky Web, Aurora Veil or screens. A set whose moves were seen is never ruled out by this: it only weighs a guess.
 */
const SECOND_HOLDER: [string[], number][] = [[['stealthrock', 'stoneaxe'], 0.056], [['toxicspikes'], 0.016],
  [['defog', 'rapidspin', 'mortalspin'], 0.32], [['spikes'], 0.84], [['stickyweb'], 0.01], [['auroraveil'], 0.01],
  [['reflect', 'lightscreen'], 0.01]];
/** The team-limited moves among these, as ids: the ones the generator seldom gives a second Pokémon. */
export function teamLimited(moves: string[]) {
  return moves.map(id).filter(m => SECOND_HOLDER.some(([group]) => group.includes(m)));
}
/** How much likelier a move is on a Pokémon whose teammates have shown these team-limited moves (see teamLimited). */
export function teammateFactor(move: string, held: string[]) {
  const m = id(move);
  return SECOND_HOLDER.reduce((f, [group, factor]) => (group.includes(m) && held.some(h => group.includes(id(h))) ? f * factor : f), 1);
}
export function complementarySetWeight(set: Candidate, chosen: Candidate[]) {
  const held = new Set(chosen.flatMap(c => c.moves.map(id)));
  let weight = 1;
  for (const [group, factor] of SECOND_HOLDER) {
    if (group.some(m => held.has(m)) && set.moves.some(m => group.includes(id(m)))) weight *= factor;
  }
  return weight;
}
