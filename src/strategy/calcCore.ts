import { moveVariants } from './moveVariants.js';
import { hitsSubstitute, substituteHP } from './substituteState.js';
import { calculate, Pokemon, Move, Field, calcStat, type StatID, type State } from '@smogon/calc';
import type { TypeName } from '@smogon/calc/dist/data/interface.js';
import type { BattleState, PokemonState, SideState, SideId } from '../battle/BattleState.js';
import { canonicalSpecies, dex, id } from '../pokemon/data.js';
import { typeEffectiveness } from '../pokemon/mechanics.js';
import type { Candidate } from './setTypes.js';
// Only called at decision time, never while modules load, so this import cycle with speed.ts is safe.
import { effectiveSpeed, movePriority, turnOrder } from './speed.js';
export const levelOf = (p: PokemonState) => Number(/(?:^|, )L(\d+)(?:,|$)/.exec(p.details)?.[1] ?? 100);
const stats: StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const neutral = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
const weather: Record<string, NonNullable<State.Field['weather']>> = { SunnyDay: 'Sun', RainDance: 'Rain', Sandstorm: 'Sand', Snow: 'Snow', Snowscape: 'Snow', Hail: 'Hail', DesolateLand: 'Harsh Sunshine', PrimordialSea: 'Heavy Rain', DeltaStream: 'Strong Winds' };
const terrain: Record<string, NonNullable<State.Field['terrain']>> = { 'Electric Terrain': 'Electric', 'Grassy Terrain': 'Grassy', 'Misty Terrain': 'Misty', 'Psychic Terrain': 'Psychic' };
function side(s: SideState) {
  return { isReflect: !!s.conditions.Reflect, isLightScreen: !!s.conditions['Light Screen'],
    isAuroraVeil: !!s.conditions['Aurora Veil'], isTailwind: !!s.conditions.Tailwind };
}
const hasVolatile = (p: PokemonState, name: string) => Object.keys(p.volatiles).some(k => id(k) === name);
/**
 * The calculator matches items and abilities by display name, while private Showdown requests supply IDs
 * ("lifeorb"). An unrecognised name is silently ignored there, so resolve it here and fail closed instead:
 * a dropped Life Orb or Huge Power understates damage without any sign that it happened.
 */
function displayName(kind: 'items' | 'abilities', value: string): string {
  if (!value) return '';
  const entry = dex[kind].get(value);
  if (!entry.exists) throw new Error(`Unrecognised ${kind.slice(0, -1)}: ${value}`);
  return entry.name;
}
type Spread = { evs: Record<StatID, number>; ivs: Record<StatID, number> };
/**
 * Fits by species, level and stats, which never change within a battle, and the failures too: a forme that does not
 * fit costs a full search of every IV and EV. Refitting on every damage calculation was over half of the game plan's
 * time, and statForme fits each of our Pokémon twice per calculation.
 */
const spreads = new Map<string, Spread | string>();
/**
 * Fit a spread to the private, unboosted stats we were given rather than guessing at them. Exported because
 * a form change recomputes its stats from the same spread against a different set of base stats.
 */
export function fittedSpread(p: PokemonState, speciesName = canonicalSpecies(p.species)): Spread {
  const level = levelOf(p);
  const actual = (stat: StatID) => stat === 'hp' ? p.exactHP?.max : p.stats?.[stat];
  const key = `${speciesName}|${level}|${stats.map(actual).join('|')}`;
  let fit = spreads.get(key);
  if (fit === undefined) {
    fit = fitSpread(speciesName, level, actual);
    if (spreads.size >= 4096) spreads.clear();
    spreads.set(key, fit);
  }
  if (typeof fit === 'string') throw new Error(fit);
  return { evs: { ...fit.evs }, ivs: { ...fit.ivs } };
}
function fitSpread(speciesName: string, level: number, actual: (stat: StatID) => number | undefined): Spread | string {
  const evs = { ...neutral }, ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const base = dex.species.get(speciesName).baseStats;
  for (const stat of stats) {
    const target = actual(stat);
    if (target === undefined) return 'Missing private stats';
    let found = false;
    for (let iv = 31; iv >= 0 && !found; iv--) for (let ev = 85; ev >= 0; ev--) {
      if (calcStat(9, stat, base[stat], iv, ev, level, 'Serious') === target) {
        ivs[stat] = iv; evs[stat] = ev; found = true; break;
      }
    }
    if (!found) return 'Stats outside supported random spread';
  }
  return { evs, ivs };
}
const entryBoostAbility = (ability: string | null | undefined) => id(ability) === 'download' || id(ability).startsWith('embodyaspect');
const copiedStats: Exclude<StatID, 'hp'>[] = ['atk', 'def', 'spa', 'spd', 'spe'];
/** A transformed Pokémon whose copied stats are all known, which Imposter on our Pokémon gives exactly. */
const knownCopy = (p: PokemonState) => copiedStats.every(k => (p.stats?.[k] ?? 0) > 0);
/**
 * A transformed Pokémon: the copied species' types, the copied stats other than HP, its copied ability, and its own
 * level, HP and item. A Ditto transformed into our Pokémon is our Pokémon with Ditto's HP and a Choice Scarf.
 */
function buildTransformed(p: PokemonState, c: Candidate | undefined, teraType: string | null) {
  const level = levelOf(p);
  const own = new Pokemon(9, canonicalSpecies(p.species), { level, evs: { ...(c?.evs ?? neutral) }, ivs: { ...(c?.ivs ?? { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }) }, nature: 'Serious' });
  const mon = new Pokemon(9, canonicalSpecies(p.transformedInto!), {
    level, evs: { ...neutral }, nature: 'Serious', boosts: p.boosts,
    ability: displayName('abilities', p.abilitySuppressed || entryBoostAbility(p.ability) ? 'No Ability' : (p.ability ?? 'No Ability')),
    abilityOn: !p.abilitySuppressed && id(p.ability) === 'flashfire' && hasVolatile(p, 'flashfire'),
    item: displayName('items', p.item ?? c?.item ?? ''), status: (p.status ?? '') as State.Pokemon['status'] & string,
    ...(teraType ? { teraType: teraType as NonNullable<State.Pokemon['teraType']> } : {}),
  });
  for (const stat of copiedStats) mon.rawStats[stat] = mon.stats[stat] = p.stats[stat]!;
  const hp = p.exactHP?.max ?? own.maxHP();
  mon.rawStats.hp = mon.stats.hp = hp;
  mon.originalCurHP = p.exactHP?.current ?? Math.max(1, Math.ceil(hp * (p.hpPercent ?? 100) / 100));
  return mon;
}
/**
 * Our own Pokémon's private stats name its current form when the protocol name does not. Minior reports its core colour
 * while Shields Down holds it in Meteor form, whose stats differ, so the fit failed and every damage, threat and speed
 * estimate for it was lost; the search then saw only our switches and voted Jev's Earthquake down. The formes a species
 * takes in battle are tried in turn, and the first whose stats fit is the one on the field.
 */
function statForme(p: PokemonState) {
  const named = canonicalSpecies(p.species);
  const species = dex.species.get(named);
  const base = species.exists ? dex.species.get(species.baseSpecies) : undefined;
  const battleFormes = (base?.otherFormes ?? []).filter(f => !!dex.species.get(f).battleOnly);
  for (const name of [named, ...battleFormes]) {
    try { fittedSpread(p, name); return name; } catch { /* the next forme */ }
  }
  return named;
}
export function buildPokemon(p: PokemonState, c?: Candidate, tera?: string) {
  if (p.transformedInto && knownCopy(p)) return buildTransformed(p, c, tera ?? (p.terastallized ? p.teraType : null));
  const speciesName = c ? canonicalSpecies(p.species) : statForme(p);
  const fitted = c ? null : fittedSpread(p, speciesName);
  const evs = { ...(c?.evs ?? fitted!.evs) }, ivs = { ...(c?.ivs ?? fitted!.ivs) };
  const teraType = tera ?? (p.terastallized ? p.teraType : null);
  const options: ConstructorParameters<typeof Pokemon>[2] = {
    level: levelOf(p), evs, ivs, nature: 'Serious', boosts: p.boosts,
    // The calculator re-applies Download and Embody Aspect on every calculation, as if the Pokémon had just come
    // in. Their boost is applied once where it happens instead — read from the log for a Pokémon on the field, and
    // in the entry and Tera projections — so the calculator must not add it a second time.
    ability: displayName('abilities', p.abilitySuppressed || entryBoostAbility(p.ability ?? c?.ability) ? 'No Ability' : (p.ability ?? c?.ability ?? 'No Ability')),
    // These abilities only change damage while their activation is up. Flash Fire's volatile records
    // the Fire hit it absorbed; without abilityOn the calculator misses its later Fire boost.
    abilityOn: hasVolatile(p, 'slowstart') || !!p.stakeoutActive ||
      (!p.abilitySuppressed && id(p.ability ?? c?.ability) === 'flashfire' && hasVolatile(p, 'flashfire')),
    ...(fallenAllies(p) ? { alliesFainted: fallenAllies(p) } : {}),
    ...(typeChange(p) ? { overrides: { types: typeChange(p)! } } : {}),
    item: displayName('items', Object.keys(p.volatiles).some(k => id(k) === 'embargo') || (!p.abilitySuppressed && id(p.ability ?? c?.ability) === 'klutz') ? '' : p.item ?? c?.item ?? ''), status: (p.status ?? '') as State.Pokemon['status'] & string,
    ...(teraType ? { teraType: teraType as NonNullable<State.Pokemon['teraType']> } : {}),
  };
  const mon = new Pokemon(9, speciesName, options);
  // Protosynthesis and Quark Drive raise the stat named in the volatile — Speed by half, anything else by
  // three tenths. The calculator models neither, so it is applied here; the volatile says which stat it chose.
  for (const volatile of Object.keys(p.volatiles)) {
    const match = boosterBoost(volatile);
    const named = match?.[2];
    if (!named || named === 'hp') continue;
    const stat = named as Exclude<StatID, 'hp'>;
    mon.rawStats[stat] = Math.floor(mon.rawStats[stat] * (stat === 'spe' ? 1.5 : 1.3));
  }
  mon.originalCurHP = p.exactHP?.current ?? Math.max(1, Math.ceil(mon.maxHP() * (p.hpPercent ?? 100) / 100));
  return mon;
}

export function buildField(s: BattleState, attackerSide: SideId, attacker?: PokemonState) {
  return new Field({ attackerSide: { ...side(s.sides[attackerSide]),
      ...(attacker && hasVolatile(attacker, 'charge') ? { isCharge: true } : {}) },
    defenderSide: side(s.sides[attackerSide === 'p1' ? 'p2' : 'p1']),
    ...(s.field.weather && weather[s.field.weather] ? { weather: weather[s.field.weather]! } : {}),
    ...(s.field.terrain && terrain[s.field.terrain] ? { terrain: terrain[s.field.terrain]! } : {}) });
}
/**
 * Volatiles that provably leave a damage calculation alone. An allowlist rather than a denylist: being
 * wrong here produces a confident wrong number, so anything not listed keeps declining. Slow Start is
 * modelled through `abilityOn` and a Booster-Energy boost is applied directly, so both are allowed too.
 */
const damageNeutral = new Set(['substitute', 'taunt', 'encore', 'disable', 'torment', 'confusion', 'attract', 'yawn',
  'leechseed', 'aquaring', 'ingrain', 'perishsong', 'saltcure', 'nightmare', 'imprison', 'throatchop',
  'healblock', 'embargo', 'defensecurl', 'rollout', 'iceball', 'furycutter', 'stockpile', 'trapped', 'partiallytrapped', 'curse', 'destinybond', 'grudge', 'magiccoat',
  'snatch', 'spotlight', 'followme', 'ragepowder', 'lockon', 'mindreader', 'slowstart',
  // No Retreat's +1 to every stat arrives as ordinary boosts; the volatile itself only stops switching. Left off this
  // list, it hid every damage estimate for the rest of our Falinks's stay.
  'noretreat', 'mustrecharge']);
/** Booster Energy and its weather or terrain trigger raise one stat, which the calculator does not model. */
const boosterBoost = (volatile: string) => /^(protosynthesis|quarkdrive)(hp|atk|def|spa|spd|spe)$/.exec(id(volatile));
/**
 * A type change announced as `typechange|Water` (Protean, Libero, Soak, Burn Up) is the typing the calculator must use.
 * Meowscarada's Protean made every estimate unavailable for 8 decisions in 30 games. A typing it cannot read declines.
 */
function typeChange(p: PokemonState): [TypeName] | [TypeName, TypeName] | null {
  const raw = Object.entries(p.volatiles).find(([k]) => id(k) === 'typechange')?.[1]?.data;
  if (!raw) return null;
  // '???' is the typeless slot a lost type leaves: Double Shock turns Pawmot into ???/Fighting, which hid Pawmot from
  // every estimate and from the search. It matters only when it is all that is left, as after a pure Fire Burn Up.
  const parts = raw.split('/').filter(t => t !== '???');
  if (!parts.length) return ['???' as TypeName];
  const types = parts.map(t => dex.types.get(t)).filter(t => t.exists).map(t => t.name as TypeName);
  if (!types.length || types.length > 2 || types.length !== parts.length) throw new Error(`Unmodelled type change: ${raw}`);
  return types as [TypeName] | [TypeName, TypeName];
}
/** Supreme Overlord announces its count of fainted allies as `fallen1` to `fallen5`, which the calculator takes directly. */
const fallenAllies = (p: PokemonState) => { for (const k of Object.keys(p.volatiles)) { const m = /^fallen([1-5])$/.exec(id(k)); if (m) return Number(m[1]); } return 0; };
const modelledVolatile = (key: string) => damageNeutral.has(id(key)) || /^perish[0-3]$/.test(id(key)) || /^stockpile[1-3]$/.test(id(key)) || !!boosterBoost(key) || /^fallen[1-5]$/.test(id(key))
  || id(key) === 'flashfire' // Mapped to the calculator's abilityOn when Flash Fire is still active.
  || id(key) === 'charge' // Doubles the next Electric attack through the calculator's attacker-side flag.
  || id(key) === 'glaiverush' // Doubled in scenario() for a hit that lands before its holder next moves.
  || id(key) === 'typechange' // Protean, Libero, Soak, Burn Up: the new typing is passed to the calculator in buildPokemon.
  // The charging turn of a two-turn move that stays in reach: it changes no damage, and Meteor Beam's or Electro Shot's
  // boost arrives as its own -boost line. Recorded since 2026-09-25, it dropped every estimate for a charging Eternatus.
  // Fly, Dig, Dive, Bounce and the Ghost moves stay unmodelled, since their user is out of reach.
  || chargingInReach.has(id(key));
const chargingInReach = new Set(['meteorbeam', 'electroshot', 'solarbeam', 'solarblade', 'skullbash', 'skyattack', 'razorwind',
  'freezeshock', 'iceburn', 'geomancy',
  // The -start announcing a Future Sight or Doom Desire marks its user; the hit itself lands later, from slot conditions.
  'futuresight', 'doomdesire']);
/**
 * Glaive Rush leaves its user taking double damage until it next moves, so a hit is doubled only if it lands first.
 * Our hit on their Glaive Rush user counts it only when we surely act first; their hit on ours counts it unless we
 * surely do, which keeps both estimates on the cautious side. Only the two active Pokémon trade hits this turn.
 */
export function glaiveRushExposed(s: BattleState, attacker: PokemonState, attackerSide: SideId, defender: PokemonState, move: string, attackerSet?: Candidate) {
  if (!Object.keys(defender.volatiles).some(k => id(k) === 'glaiverush')) return false;
  const defenderSide: SideId = attackerSide === 'p1' ? 'p2' : 'p1';
  if (s.sides[attackerSide].activeId !== attacker.id || s.sides[defenderSide].activeId !== defender.id) return false;
  if (attackerSide === s.mySide) return turnOrder(s, attacker, move)?.order === 'ours-first';
  const priority = movePriority(s, attacker, move, attackerSet);
  const theirs = effectiveSpeed(s, attacker, attackerSide, attackerSet), ours = effectiveSpeed(s, defender, defenderSide);
  if (priority === null || priority > 0 || theirs === null || ours === null) return true;
  if (priority < 0) return false;
  return s.field.trickRoom ? ours >= theirs : ours <= theirs;
}
/**
 * Whether a volatile can change effective Speed. A Substitute, Leech Seed or Taunt cannot; Slow Start is
 * modelled through `abilityOn`; a Booster-Energy boost only matters when it named the Speed stat.
 */
function affectsSpeed(volatile: string) {
  const match = /^(protosynthesis|quarkdrive)(hp|atk|def|spa|spd|spe)?$/.exec(id(volatile));
  return !!match && !match[2]; // Named Booster boosts are already applied by buildPokemon, including Speed.
}
const unmodelledField = (s: BattleState) =>
  Object.keys(s.effectStartTurns).filter(k => k !== 'weather' && !k.endsWith(' Terrain') && k !== 'Trick Room');
const fieldSupported = (s: BattleState) =>
  !unmodelledField(s).length; // An Illusion reveal names the Pokémon exactly; only its earlier history is in doubt.
export function supportedState(s: BattleState, ...mons: PokemonState[]) {
  return fieldSupported(s) && !mons.some(p => (p.transformedInto && !knownCopy(p)) || Object.keys(p.volatiles).some(k => !modelledVolatile(k)));
}
/**
 * Damage uses an allowlist, with Substitute interception handled by scenario(). Speed has a separate
 * support check: only speed-relevant effects should hide the observed turn order.
 */
export function supportedSpeed(s: BattleState, ...mons: PokemonState[]) {
  return fieldSupported(s) && !mons.some(p => (p.transformedInto && !knownCopy(p)) || Object.keys(p.volatiles).some(affectsSpeed));
}
/** Why an estimate is missing, so that absent numbers never read as an absence of danger. */
export function unsupportedReason(s: BattleState, ...mons: PokemonState[]): string | null {
  const field = unmodelledField(s);
  if (field.length) return `unmodelled field effect: ${field.join(', ')}`;
  for (const p of mons) {
    if (p.transformedInto && !knownCopy(p)) return `${p.species} is transformed into ${p.transformedInto}, whose stats are not known`;
    const volatiles = Object.keys(p.volatiles).filter(k => !modelledVolatile(k));
    if (volatiles.length) return `unmodelled volatile on ${p.species}: ${volatiles.join(', ')}`;
  }
  return null;
}
export function supportedMove(moveName: string) {
  const move = dex.moves.get(moveName);
  return move.exists && move.category !== 'Status';
}
export function hpInterval(p: PokemonState, maxHP: number): [number, number] {
  if (p.exactHP) return [p.exactHP.current, p.exactHP.current];
  if (p.hpPercent === null) return [1, maxHP];
  if (p.hpPercent === 0) return [0, 0];
  return [Math.max(1, Math.floor(maxHP * Math.max(0, p.hpPercent - 1) / 100) + 1), Math.ceil(maxHP * p.hpPercent / 100)];
}
export type KOVerdict = 'all-sampled-rolls' | 'some-sampled-rolls' | 'none-sampled';
/**
 * One damage envelope over the candidate sets. KO is damage-only, evaluated against the target's whole
 * possible current-HP interval. Because each set carries its generation frequency, the KO is also reported
 * as probability mass: how much of the distribution kills regardless of the roll, and how much can kill at all.
 */
/**
 * `attempted` is the probability mass of every set the rolls were drawn from, modelled or not. Inference leaves the
 * surviving sets with their prior weights, so after evidence they can sum to well under one; coverage is measured
 * against that mass, or a Keldeo narrowed to its three Tera Water sets read as 13.5% covered when all three were.
 */
export function accumulate(rolls: { min: number; max: number; probability: number; endures?: boolean; mechanicsNotes?: string[] }[], target: PokemonState, targetMaxHP: number, attempted = 1) {
  if (!rolls.length || targetMaxHP <= 0) return null;
  const [low, high] = hpInterval(target, targetMaxHP);
  let min = Infinity, max = -Infinity, koAll = true, koAny = false, mass = 0, certain = 0, possible = 0, endured = 0;
  for (const r of rolls) {
    min = Math.min(min, r.min); max = Math.max(max, r.max);
    // A set that survives on Focus Sash or Sturdy is not knocked out by any roll, however large the damage.
    const kills = !r.endures;
    koAny ||= kills && r.max >= low; koAll &&= kills && r.min >= high;
    mass += r.probability;
    if (r.endures) endured += r.probability;
    if (kills && r.min >= high) certain += r.probability;
    if (kills && r.max >= low) possible += r.probability;
  }
  const share = (v: number) => (mass > 0 ? Math.round(v / mass * 1000) / 1000 : 0);
  const conditionalKO = (koAll ? 'all-sampled-rolls' : koAny ? 'some-sampled-rolls' : 'none-sampled') as KOVerdict;
  const regardlessOfRoll = share(certain), onSomeRoll = share(possible);
  // The label already says it when every set agrees, so the mass is only worth stating when sets disagree.
  const informative = conditionalKO === 'some-sampled-rolls' || regardlessOfRoll !== onSomeRoll;
  return { hp: [min, max] as [number, number],
    percentOfMaxHP: [Math.floor(min / targetMaxHP * 1000) / 10, Math.ceil(max / targetMaxHP * 1000) / 10] as [number, number],
    scenarios: rolls.length, conditionalKO,
    ... (rolls.some(r=>r.mechanicsNotes?.length) ? { mechanicsNotes: [...new Set(rolls.flatMap(r=>r.mechanicsNotes ?? []))] } : {}),
    // Renormalised over the sets the calculator could model, which is `coveredProbabilityMass` of the whole.
    ...(informative ? { koProbability: { regardlessOfRoll, onSomeRoll } } : {}),
    ...(endured > 0 ? { survivesOnFocusSashOrSturdy: { probability: share(endured),
      why: 'from full HP those leave the holder on 1 HP instead of fainting, so this is not a knockout against those sets' } } : {}),
    ...(attempted > 0 && mass / attempted < 0.999 ? { coveredProbabilityMass: Math.round(mass / attempted * 1000) / 1000 } : {}) };
}
/**
 * Sets differ to the calculator only through the stats, ability and item that reach it, so several joint sets
 * collapse to one scenario. Their probabilities are summed, or the likelihood of a KO would be understated.
 */
export function dedupeCandidates(candidates: Candidate[]) {
  const merged = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = JSON.stringify([c.evs, c.ivs, c.ability, c.item]);
    const found = merged.get(key);
    if (found) found.probability += c.probability;
    else merged.set(key, { ...c });
  }
  return [...merged.values()];
}
/**
 * Moves whose damage is read off current HP instead of computed from stats. The calculator returns zero for
 * all three, and that is not a small error: a Luvdisc at 2% HP clicking Endeavor takes a full-health Regirock
 * from 268 to 19, so reporting it as no damage hides the largest hit on the field.
 */
const currentHPMoves: Record<string, (attackerHP: number, defenderHP: number) => number> = {
  // Endeavor levels the target down to the user's HP, and simply fails when the user is not the lower of the two.
  endeavor: (a, d) => Math.max(0, d - a),
  superfang: (_a, d) => Math.max(1, Math.floor(d / 2)),
  ruination: (_a, d) => Math.max(1, Math.floor(d / 2)),
};
/**
 * Focus Sash and Sturdy both leave their holder on 1 HP instead of fainting, from full HP only, and the
 * calculator models neither: its range is byte-identical with and without them. Left alone, a hit into a
 * full-health Sash holder is reported as a certain knockout, and the guards that skip a move on the strength
 * of `all-sampled-rolls` would be acting on a claim that is simply false.
 */
function enduresOneHit(defender: PokemonState, set: Candidate | undefined, maxHP: number, attacker: PokemonState, attackerSet?: Candidate, moveName = '') {
  const embargo = Object.keys(defender.volatiles).some(k => id(k) === 'embargo');
  const bypass = !attacker.abilitySuppressed && ['moldbreaker','teravolt','turboblaze','neutralizinggas'].includes(id(attacker.ability ?? attackerSet?.ability));
  const shield = !embargo && id(defender.item ?? set?.item)==='abilityshield';
  const ignores = !shield && (bypass || !!dex.moves.get(moveName).ignoreAbility);
  const item = embargo || (!defender.abilitySuppressed && id(defender.ability ?? set?.ability) === 'klutz') ? '' : id(defender.item ?? set?.item ?? ''), ability = defender.abilitySuppressed ? '' : id(defender.ability ?? set?.ability ?? '');
  if (item !== 'focussash' && (ability !== 'sturdy' || ignores)) return false;
  // Both work only from full HP, so anything that has already taken a point of damage is not protected.
  return hpInterval(defender, maxHP)[1] >= maxHP;
}
export function scenario(s: BattleState, attacker: PokemonState, defender: PokemonState, attackerSide: SideId, move: string, attackerSet?: Candidate, defenderSet?: Candidate, tera?: string, defenderTera?: string) {
  if (!supportedState(s, attacker, defender) || !supportedMove(move)) return null;
  try {
    const a = buildPokemon(attacker, attackerSet, tera), d = buildPokemon(defender, defenderSet, defenderTera);
    const ahp = hpInterval(attacker, a.maxHP()), dhp = hpInterval(defender, d.maxHP());
    const spec = dex.moves.get(move), fixed = currentHPMoves[id(move)];
    // Fixed-damage moves skip the damage modifiers, Glaive Rush's doubling among them.
    const doubled = !fixed && glaiveRushExposed(s, attacker, attackerSide, defender, move, attackerSet);
    // Item/ability inputs use IDs in the variant helper.
    const plans = moveVariants(s, attacker, attackerSide, move, id(a.ability), id(a.item));
    const sub = hitsSubstitute(attacker, defender, move, attackerSet?.ability);
    const subHP = substituteHP(defender, d.maxHP());
    let min = Infinity, max = -Infinity, shellMin = Infinity, shellMax = 0;
    let allBreak = true, anyBreak = false;
    const multi = plans.some(v=>v.hits>1);
    const notes = new Set(plans.flatMap(v => v.note ? [v.note] : []));
    if (doubled) notes.add('Glaive Rush doubles the damage its user takes until it next moves, and this hit lands before that');
    // Disguise takes the first hit for an eighth of max HP and Ice Face takes the first physical hit for nothing.
    // The calculator models neither. Both are spent on that hit, so later hits of a multi-hit move land in full,
    // and an ability-ignoring attacker or move reads straight through them.
    const pierces = id(d.item)!=='abilityshield' && ((!attacker.abilitySuppressed && ['moldbreaker','teravolt','turboblaze','neutralizinggas'].includes(id(a.ability))) || !!spec.ignoreAbility);
    const guardForm = pierces || sub ? null
      : id(d.ability) === 'disguise' && d.name === 'Mimikyu' ? 'disguise' as const
      : id(d.ability) === 'iceface' && d.name === 'Eiscue' && spec.category === 'Physical' ? 'iceface' as const : null;
    let guardSpent = false;
    for (const plan of plans) for (const x of new Set(ahp)) for (const y of new Set(dhp)) for (const upper of [false,true]) {
      const ac = a.clone(), dc = d.clone(); ac.originalCurHP = x; dc.originalCurHP = y;
      let holderDamage = 0, shell = sub ? subHP[upper ? 0 : 1] : 0, shellDamage = 0, guard = guardForm;
      const originalShell = shell;
      for (let hit = 0; hit < plan.hits; hit++) {
        const bp = plan.powers?.[hit];
        const built = new Move(9, move, { hits: 1, ...(bp !== undefined ? { overrides: { basePower: bp } } : {}) });
        built.hits = 1;
        // Callbacks whose conditional power we have explicitly bounded must not recompute it from speed.
        if (bp !== undefined) built.name = 'Bounded power' as typeof built.name;
        let range: [number,number];
        if (fixed) {
          const immune = typeEffectiveness(built.type, [...dc.types]) === 0;
          const amount = immune ? 0 : fixed(x, dc.originalCurHP!);
          range = [amount,amount];
        } else range = calculate(9, ac.clone(), dc.clone(), built, buildField(s, attackerSide, attacker)).range();
        let dealt = range[upper ? 1 : 0] * (doubled ? 2 : 1);
        if (shell > 0) {
          shellDamage += Math.min(shell,dealt); shell = Math.max(0,shell-dealt);
          // Excess damage on the breaking hit is discarded; subsequent hits can reach the holder.
        } else {
          // A hit that would deal nothing, such as into a type immunity, does not break the guard.
          if (guard && dealt > 0) { dealt = guard === 'disguise' ? Math.floor(dc.maxHP() / 8) : 0; guard = null; guardSpent = true; }
          const full = dc.originalCurHP === dc.maxHP();
          const ignores = id(dc.item)!=='abilityshield' && ((!attacker.abilitySuppressed && ['moldbreaker','teravolt','turboblaze','neutralizinggas'].includes(id(ac.ability))) || !!spec.ignoreAbility);
          const sash = id(dc.item) === 'focussash';
          if (multi && full && dealt >= dc.maxHP() && (sash || id(dc.ability) === 'sturdy' && !ignores)) {
            dealt = dc.maxHP()-1; if (sash) dc.item = '' as NonNullable<typeof dc.item>;
          }
          holderDamage += dealt;
          dc.originalCurHP = Math.max(0,dc.originalCurHP!-dealt);
          if (dc.originalCurHP <= 0) break;
          if (hit < plan.hits-1 && id(dc.item)==='sitrusberry' && dc.originalCurHP <= dc.maxHP()/2) {
            dc.originalCurHP = Math.min(dc.maxHP(),dc.originalCurHP+Math.floor(dc.maxHP()/4));
            holderDamage -= Math.floor(dc.maxHP()/4); dc.item = '' as NonNullable<typeof dc.item>;
            if (id(dc.ability)==='cheekpouch') { const heal=Math.floor(dc.maxHP()/3);dc.originalCurHP=Math.min(dc.maxHP(),dc.originalCurHP+heal);holderDamage-=heal; }
          }
          if (id(dc.ability)==='stamina') dc.boosts.def=Math.min(6,dc.boosts.def+1);
          if (id(dc.ability)==='weakarmor' && built.category==='Physical') dc.boosts.def=Math.max(-6,dc.boosts.def-1);
          if (id(dc.ability)==='watercompaction' && built.type==='Water') dc.boosts.def=Math.min(6,dc.boosts.def+2);
          if (multi && built.flags.contact && !['longreach','magicguard'].includes(id(ac.ability)) && id(ac.item)!=='protectivepads') {
            const chip=(['roughskin','ironbarbs'].includes(id(dc.ability))?Math.max(1,Math.floor(ac.maxHP()/8)):0)+(id(dc.item)==='rockyhelmet'?Math.max(1,Math.floor(ac.maxHP()/6)):0);
            ac.originalCurHP=Math.max(0,ac.originalCurHP!-chip);
            if (ac.originalCurHP===0) break;
          }
          // Resist berries are consumed on the first applicable hit; the calculator prices their first use.
          const resist: Record<string,string> = {occaberry:'Fire',passhoberry:'Water',wacanberry:'Electric',rindoberry:'Grass',yacheberry:'Ice',chopleberry:'Fighting',kebiaberry:'Poison',shucaberry:'Ground',cobaberry:'Flying',payapaberry:'Psychic',tangaberry:'Bug',chartiberry:'Rock',kasibberry:'Ghost',habanberry:'Dragon',colburberry:'Dark',babiriberry:'Steel',roseliberry:'Fairy',chilanberry:'Normal'};
          if (resist[id(dc.item)] === built.type && (built.type==='Normal'||typeEffectiveness(built.type,[...dc.types])! > 1)) dc.item = '' as NonNullable<typeof dc.item>;
        }
      }
      min=Math.min(min,Math.max(0,holderDamage)); max=Math.max(max,Math.max(0,holderDamage));
      shellMin=Math.min(shellMin,shellDamage);shellMax=Math.max(shellMax,shellDamage);
      const broken=originalShell>0 && shell===0;allBreak &&= broken;anyBreak ||= broken;
    }
    if (guardSpent) notes.add(guardForm === 'disguise'
      ? 'Disguise takes the first hit for an eighth of max HP and then breaks'
      : 'Ice Face takes the first physical hit for no damage and then breaks');
    const endures = !sub && !multi && enduresOneHit(defender, defenderSet, d.maxHP(), attacker, attackerSet, move);
    return { min, max, attackerMaxHP: a.maxHP(), defenderMaxHP: d.maxHP(),
      ...(notes.size ? { mechanicsNotes: [...notes] } : {}),
      ...(endures ? { endures: true as const } : {}),
      ...(sub ? { substitute: { hpBefore: subHP, damageHP: [shellMin,shellMax] as [number,number],
        breaks: allBreak ? 'all-rolls' as const : anyBreak ? 'some-rolls' as const : 'no-rolls' as const,
        holderDamageHP: max, laterHitsCanReachHolder: multi, excessDamageSpillsThrough: false } } : {}) };

  } catch { return null; }
}
