import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { grounded, pokemonTypes, typeEffectiveness, selfStageChanges } from '../pokemon/mechanics.js';
import { movePriority } from './speed.js';
import { sampled } from './sampled.js';
import { phazeStoppers } from './phaze.js';
import { boostersFor, statusBoosters } from './statusGifts.js';
import { statusAbsorbers } from './abilities.js';
import { plausibleMoves } from './setPriors.js';
import { inferOpponent } from './inference.js';
import { scenario } from './calcCore.js';
import { protectMoves } from '../battle/BattleTracker.js';
import { wakeChance } from './risk.js';

/** Types that cannot take a given major status at all. */
const statusImmuneTypes: Record<string, string[]> = {
  brn: ['Fire'], par: ['Electric'], frz: ['Ice'], psn: ['Poison', 'Steel'], tox: ['Poison', 'Steel'],
};
/** Abilities that prevent one status, all statuses, or a whole class of move. */
const statusAbilities: Record<string, string[]> = {
  brn: ['waterveil', 'thermalexchange', 'waterbubble'], par: ['limber'],
  slp: ['insomnia', 'vitalspirit', 'comatose', 'sweetveil'], frz: ['magmaarmor'],
  psn: ['immunity'], tox: ['immunity'],
};
const allStatusAbilities = ['purifyingsalt'];
const hazardLimits: Record<string, number> = { stealthrock: 1, spikes: 3, toxicspikes: 2, stickyweb: 1 };
const weatherMoves: Record<string, string> = { sunnyday: 'SunnyDay', raindance: 'RainDance', sandstorm: 'Sandstorm', snowscape: 'Snow', chillyreception: 'Snow' };
const lastingSelfEffects = new Set(['noretreat', 'focusenergy', 'aquaring', 'ingrain', 'magnetrise']);
const has = (p: PokemonState, volatile: string) => Object.keys(p.volatiles).some(k => id(k) === volatile);

/** These self effects cannot be gained twice while their volatile is still active. */
export function repeatedSelfEffectFailure(user: PokemonState, moveName: string): string | null {
  const move = dex.moves.get(moveName);
  return lastingSelfEffects.has(move.id) && Object.keys(user.volatiles).some(k => id(k) === move.id)
    ? `the user is already under ${move.name}, so it fails` : null;
}

/**
 * Why a move would accomplish nothing, or nothing new. `certain` uses only facts already established — the
 * target's types, its current status, our own HP and boosts, the field and the side conditions. `possible`
 * covers hidden sets, so it carries generation frequencies rather than claims. Neither list is exhaustive:
 * an empty result is not a promise that the move will work.
 */
/**
 * The first reason a move certainly fails or backfires, from established facts only. Every `certain` reason qualifies
 * except the two that describe a status landing to their benefit — a Guts or Poison Heal holder, which
 * statusThatHelpsThem prices, and a curing berry, which the turn at least removes.
 */
export function certainFailure(s: BattleState, moveName: string, user: PokemonState, userSide: SideId, target: PokemonState | undefined) {
  return effectViability(s, moveName, user, userSide, target)?.certain
    .find(reason => !/helps the target|only removes the berry/.test(reason)) ?? null;
}

export function effectViability(s: BattleState, moveName: string, user: PokemonState, userSide: SideId, target: PokemonState | undefined) {
  const move = dex.moves.get(moveName);
  if (!move.exists) return null;
  const certain: string[] = [];
  const possible: { reason: string; probability: number | null }[] = [];
  const limited: { reason: string; probability: number | null }[] = [];
  const self = move.target === 'self';
  const ourSide = s.sides[userSide], theirSide = s.sides[userSide === 'p1' ? 'p2' : 'p1'];

  if (user.status === 'slp' && wakeChance(user) === 0 && !['sleeptalk', 'snore'].includes(move.id)) {
    certain.push('the user cannot wake this turn, so only Sleep Talk or Snore can act while it stays asleep');
  }
  if (user.status === 'slp' && wakeChance(user) === 1 && ['sleeptalk', 'snore'].includes(move.id)) {
    certain.push('the user will wake before this move, so it will no longer be asleep to use it');
  }

  if (move.id === 'revivalblessing' && !ourSide.team.some(p=>p.fainted)) certain.push('no fainted teammate to revive');

  // Recovery and Substitute depend only on our own HP, which we know exactly.
  const hp = user.hpPercent;
  // Draining attacks carry the heal flag too, for Heal Block, but their damage still lands at full HP.
  if (move.category === 'Status' && !['revivalblessing', 'wish'].includes(move.id) &&
    (move.flags.heal || move.id === 'rest') && move.id !== 'strengthsap' && hp === 100) {
    certain.push('the user is already at full HP, so a healing move restores nothing');
  }
  // Sleep is checked before Rest runs. On a certain wake turn, Rest can put the user back to sleep.
  if (move.id === 'rest' && user.status === 'slp' && wakeChance(user) === 0) {
    certain.push('the user cannot wake this turn, so Rest fails while it remains asleep');
  }
  if (move.category === 'Status' && move.flags.heal && has(user, 'healblock')) {
    certain.push('Heal Block prevents this recovery move from working');
  }
  // Rest only works by putting the user to sleep, so anything that keeps it awake makes Rest fail outright.
  if (move.id === 'rest' && user.status !== 'slp') {
    const awake = user.abilitySuppressed ? '' : id(user.ability);
    if (['insomnia', 'vitalspirit', 'sweetveil', 'purifyingsalt', 'comatose'].includes(awake)) certain.push(`${dex.abilities.get(awake).name} keeps the user from sleeping, so Rest fails`);
    else if (['Electric Terrain', 'Misty Terrain'].includes(s.field.terrain ?? '') && grounded(user)) certain.push(`${s.field.terrain} keeps a grounded user awake, so Rest fails`);
  }
  if (move.id === 'substitute' || move.id === 'shedtail') {
    const price = move.id === 'shedtail' ? 50 : 25;
    if (move.id === 'substitute' && Object.keys(user.volatiles).some(k => id(k) === 'substitute')) {
      certain.push('the user is already behind a Substitute');
    } else if (hp !== null && hp <= price) {
      certain.push(`${move.name} needs more than ${price === 50 ? 'half' : 'a quarter'} of the user's max HP`);
    }
  }
  // Boosts cap at six stages in either direction.
  const boostTarget = self ? user : target;
  const boosts = { ...(self && move.boosts ? move.boosts : {}), ...(move.self?.boosts ?? {}) };
  const ourBoosts = Object.entries(selfStageChanges(user, boosts as Record<string,number>));
  if (move.category === 'Status' && ourBoosts.length && ourBoosts.every(([stat, stage]) => (user.boosts[stat] ?? 0) === (stage! > 0 ? 6 : -6))) {
    certain.push('every stat this changes on the user is already at its limit');
  }
  // Imposter copies stat stages on entry, and Ditto's Choice Scarf then outspeeds the Pokémon it copied: a boost with
  // their Ditto waiting is a boost handed to it.
  if (ourBoosts.some(([, stage]) => stage! > 0)) {
    const waiting = theirSide.team.find(p => !p.fainted && p.id !== theirSide.activeId && id(p.baseAbility ?? p.ability ?? (p.species === 'Ditto' ? 'imposter' : '')) === 'imposter');
    if (waiting) possible.push({ reason: `their ${waiting.species} can switch in and copy these boosts with Imposter, then outspeed us with its Choice Scarf`, probability: 1 });
  }
  if (!self && move.boosts && boostTarget) {
    const entries = Object.entries(move.boosts);
    if (move.category === 'Status' && entries.every(([stat, stage]) => (boostTarget.boosts[stat] ?? 0) === (stage! > 0 ? 6 : -6))) {
      certain.push('every stat this changes on the target is already at its limit');
    }
  }
  // Hazards, screens, weather and terrain that are already in place.
  if (move.sideCondition) {
    const side = ['reflect', 'lightscreen', 'auroraveil', 'tailwind', 'safeguard', 'mist'].includes(id(move.sideCondition)) ? ourSide : theirSide;
    const present = Object.entries(side.conditions).find(([name]) => id(name) === id(move.sideCondition));
    const limit = hazardLimits[id(move.sideCondition)];
    if (present && (!limit || (side.hazards[present[0]] ?? 0) >= limit)) {
      certain.push(`${present[0]} is already at its limit on that side`);
    }
  }
  const weather = weatherMoves[move.id];
  if (weather && s.field.weather === weather) certain.push(`${weather} is already active`);
  if (move.terrain && s.field.terrain === `${move.terrain[0]!.toUpperCase()}${move.terrain.slice(1)} Terrain`) {
    certain.push(`${s.field.terrain} is already active`);
  }

  // Fake Out and First Impression work only on the user's first turn after entering. The server still offers
  // them afterwards, where they fail, so a 100% flinch is on offer every turn and pays off on only one.
  if (['fakeout', 'firstimpression'].includes(move.id) && typeof user.activeSinceTurn === 'number' && s.turn > user.activeSinceTurn + 1) {
    certain.push(`${move.name} only works on the user's first turn after entering, and ${user.species} has been in since turn ${user.activeSinceTurn}, so it fails`);
  }

  // Lasting effects fail on a second use while they are still up. Falinks, under No Retreat from turn 9, chose it twice
  // more and failed both times while Gurdurr used Bulk Up to +3.
  const repeated = self ? repeatedSelfEffectFailure(user, move.name) : null;
  if (repeated) certain.push(repeated);

  if (self || !target) return certain.length || possible.length ? { certain, possible, limited } : null;
  if (['taunt', 'encore', 'torment', 'yawn'].includes(move.id) && Object.keys(target.volatiles).some(k => id(k) === move.id)) {
    certain.push(`the target is already under ${move.name}, so it fails`);
  }
  if (move.id === 'yawn' && target.status) certain.push(`the target already has a status condition (${target.status}), so Yawn fails`);
  const types = pokemonTypes(target);
  // An empty string is a known absence: the item was removed or used up, not merely unrevealed.
  if (move.id === 'poltergeist' && target.item === '') certain.push('Poltergeist fails because the target no longer holds an item');
  const targeted = ['normal', 'allAdjacent', 'allAdjacentFoes', 'randomNormal', 'any'].includes(move.target);

  // A rampage commits us for two or three turns: a teammate of theirs that takes nothing from it comes in for free.
  if (move.self?.volatileStatus === 'lockedmove' && move.category !== 'Status') {
    for (const p of theirSide.team.filter(x => !x.fainted && x.id !== theirSide.activeId)) {
      const sets = inferOpponent(p).candidates;
      const blanked = sets.length > 0 && sets.every(c => { const r = scenario(s, user, p, userSide, move.name, undefined, c); return !!r && r.max === 0; });
      if (blanked) possible.push({ reason: `${p.species} takes nothing from ${move.name} and can switch in for free while we stay locked into it`, probability: 1 });
    }
  }
  // Leech Seed misses a Grass type entirely, stacks on nothing, and cannot reach through a Substitute.
  if (move.id === 'leechseed') {
    if (types.includes('Grass')) certain.push('Grass types cannot be seeded');
    if (Object.keys(target.volatiles).some(k => id(k) === 'leechseed')) certain.push('the target is already seeded');
    if (Object.keys(target.volatiles).some(k => id(k) === 'substitute')) certain.push('Leech Seed cannot reach through a Substitute');
  }
  // A status move still has to get past the target's type, its current status and the field.
  let statusImmune = false;
  if (move.status) {
    if (target.status) certain.push(`the target already has a status condition (${target.status})`);
    if ((statusImmuneTypes[move.status] ?? []).some(t => types.includes(t))) {
      statusImmune = true;
      certain.push(`${types.join('/')} cannot be ${move.status === 'brn' ? 'burned' : move.status === 'par' ? 'paralysed' : move.status === 'frz' ? 'frozen' : move.status === 'slp' ? 'put to sleep' : 'poisoned'}`);
    }
    if (move.status === 'slp' && move.id !== 'rest') {
      const asleep = theirSide.team.find(p => p.status === 'slp' && !p.fainted);
      if (asleep) certain.push(`Sleep Clause: ${asleep.species} on that side is already asleep, so this fails`);
    }
    if (Object.keys(theirSide.conditions).some(c => id(c) === 'safeguard')) certain.push('Safeguard protects that side from status');
    if (s.field.terrain === 'Misty Terrain' && grounded(target)) certain.push('Misty Terrain protects the grounded target from status');
    if (s.field.terrain === 'Electric Terrain' && move.status === 'slp' && grounded(target)) certain.push('Electric Terrain keeps the grounded target awake');
    // These do not block the status; they make landing it a gift, which is the same wasted turn from our side.
    if (move.status === 'psn' || move.status === 'tox') {
      for (const a of sampled(target, 'abilities', ['poisonheal'])) {
        const harm = 'Poison Heal turns the poison into an eighth of max HP healed every turn, so this helps the target';
        if (a.known) certain.push(harm); else possible.push({ reason: harm, probability: a.probability });
      }
    }
    if (['psn', 'tox', 'brn'].includes(move.status)) {
      for (const a of sampled(target, 'abilities', ['magicguard'])) {
        limited.push({ reason: move.status === 'brn'
          ? 'Magic Guard blocks burn damage, but burn still lowers physical Attack'
          : 'Magic Guard blocks poison damage, but the status still lands and may have other effects',
          probability: a.known ? 1 : a.probability });
      }
    }
    // Guts and its kind do not stop the status; they turn it into a boost, so landing it strengthens the target.
    for (const a of sampled(target, 'abilities', boostersFor(move.status))) {
      const harm = `${statusBoosters[id(a.name)]!.why(move.status)}, so this helps the target`;
      if (a.known) certain.push(harm); else possible.push({ reason: harm, probability: a.probability });
    }
    for (const a of sampled(target, 'abilities', [...(statusAbilities[move.status] ?? []), ...allStatusAbilities])) {
      possible.push({ reason: `${a.name} would prevent it`, probability: a.probability });
    }
    if (s.field.weather === 'SunnyDay') {
      for (const a of sampled(target, 'abilities', ['leafguard'])) possible.push({ reason: 'Leaf Guard prevents status in sun', probability: a.probability });
    }
  }
  // Conditional priority: Psychic Terrain refuses a priority move aimed at a grounded target, and Prankster's
  // own +1 is what a Dark type is immune to, so an unboosted status move from anyone else still lands.
  if (targeted && s.field.terrain === 'Psychic Terrain' && grounded(target) && (movePriority(s, user, move.name) ?? 0) > 0) {
    certain.push('Psychic Terrain blocks increased-priority moves aimed at a grounded target, so this fails outright');
  }
  if (move.category === 'Status' && targeted && types.includes('Dark') &&
      !user.abilitySuppressed && id(user.ability) === 'prankster') {
    certain.push('Dark types are immune to status moves given priority by Prankster');
  }
  if (move.flags.powder) {
    if (types.includes('Grass')) certain.push('Grass types ignore powder and spore moves');
    for (const a of sampled(target, 'abilities', ['overcoat'])) possible.push({ reason: 'Overcoat blocks powder moves', probability: a.probability });
    for (const i of sampled(target, 'items', ['safetygoggles'])) possible.push({ reason: 'Safety Goggles blocks powder moves', probability: i.probability });
  }
  // Showdown status moves ignore the damage type chart by default. Thunder Wave explicitly opts
  // back into type immunity, but Trick, Hypnosis and the like still affect Dark targets.
  // Skipped when the status immunity above already says the same thing in plainer terms.
  if (!statusImmune && move.category === 'Status' && targeted && move.ignoreImmunity === false &&
      typeEffectiveness(move.type, types) === 0) {
    certain.push(`${types.join('/')} is immune to ${move.type} moves`);
  }
  const breaksMoulds = !user.abilitySuppressed && ['moldbreaker', 'teravolt', 'turboblaze'].includes(id(user.ability));
  if (move.category === 'Status' && targeted) {
    for (const a of sampled(target, 'abilities', ['goodasgold'])) {
      possible.push({ reason: 'Good as Gold blocks status moves outright', probability: a.probability });
    }
    // Absorbing abilities stop status moves of their type as surely as attacks, and most profit from it.
    for (const a of breaksMoulds ? [] : sampled(target, 'abilities', statusAbsorbers(move.name))) {
      const harm = id(a.name) === 'soundproof' ? `Soundproof blocks sound moves, so ${move.name} fails`
        : `${a.name} absorbs ${move.type} moves, so ${move.name} fails and can power it up`;
      if (a.known) certain.push(harm); else possible.push({ reason: harm, probability: a.probability });
    }
  }
  // A crash move into a possible Protect risks half our HP for nothing; a revealed Protect makes it concrete.
  if (move.hasCrashDamage) {
    const guard = plausibleMoves(target).find(m => protectMoves.has(id(m.move)));
    if (guard) possible.push({ reason: `if they use ${guard.move} this crashes and costs half our max HP`, probability: guard.revealed ? 1 : guard.priorProbability });
  }
  // Queenly Majesty, Dazzling and Armor Tail refuse any move given priority against their holder.
  if (targeted && !breaksMoulds && (movePriority(s, user, move.name) ?? 0) > 0) {
    for (const a of sampled(target, 'abilities', ['queenlymajesty', 'dazzling', 'armortail'])) {
      const harm = `${a.name} blocks moves with increased priority, so ${move.name} fails`;
      if (a.known) certain.push(harm); else possible.push({ reason: harm, probability: a.probability });
    }
  }
  // A cure-on-status berry spends our turn for one berry: the status lands and is gone at once.
  const cures = move.status ? ['lumberry', ...(move.status === 'slp' ? ['chestoberry'] : [])]
    : !self && move.volatileStatus === 'confusion' ? ['lumberry', 'persimberry'] : [];
  if (cures.length && !statusImmune) {
    for (const i of sampled(target, 'items', cures)) {
      const harm = `${i.name} cures it straight away, so the turn only removes the berry`;
      if (i.known) certain.push(harm); else possible.push({ reason: harm, probability: i.probability });
    }
  }
  // Roar and Whirlwind do nothing else, so anything that stops the drag makes them fail. An attacking phaze still hits.
  if (move.forceSwitch && move.category === 'Status' && target) {
    const stops = phazeStoppers(s, target, userSide === 'p1' ? 'p2' : 'p1', move.name);
    for (const reason of stops.certain) certain.push(`${reason}, so ${move.name} fails`);
    for (const p of stops.possible) possible.push({ reason: `${p.reason}, so ${move.name} would fail`, probability: p.probability });
  }
  if (move.flags.reflectable) {
    for (const a of sampled(target, 'abilities', ['magicbounce'])) {
      const harm = move.sideCondition
        ? `Magic Bounce reflects this, so ${move.name} lands on our own side instead of theirs`
        : `Magic Bounce reflects ${move.name} straight back at us`;
      if (a.known) certain.push(harm);
      else possible.push({ reason: harm, probability: a.probability });
    }
  }
  // An attack's chance to inflict a status is a cost, not a bonus, against a Pokémon that thrives on it: Scald's burn
  // on a Guts user is a 30% chance to make it hit harder. Sheer Force removes the chance, and so does an immune type.
  if (move.category !== 'Status' && !target.status && (user.abilitySuppressed || id(user.ability) !== 'sheerforce')) {
    for (const e of move.secondaries ?? []) {
      if (!e.status || !e.chance || (statusImmuneTypes[e.status] ?? []).some(t => types.includes(t))) continue;
      const what = e.status === 'brn' ? 'a burn' : e.status === 'par' ? 'paralysis' : 'poison';
      for (const a of sampled(target, 'abilities', boostersFor(e.status))) {
        possible.push({ reason: `its ${e.chance}% chance of ${what} works against us: ${statusBoosters[id(a.name)]!.why(e.status)}`,
          probability: a.known ? 1 : a.probability });
      }
    }
  }
  return certain.length || possible.length || limited.length ? { certain, possible, limited } : null;
}
