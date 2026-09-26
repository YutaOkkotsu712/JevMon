import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import type { Candidate } from '../strategy/setTypes.js';
import { buildPokemon, levelOf } from '../strategy/calcCore.js';
import { bestFitCandidates, inferOpponent } from '../strategy/inference.js';
import { speedSummary } from '../strategy/speed.js';
import { canonicalSpecies, dex, id } from '../pokemon/data.js';
import joint from '../data/gen9-joint-sets.json' with { type: 'json' };
import pools from '../data/gen9-sets.json' with { type: 'json' };
import { baseSpecies, complementarySetWeight, fitsTeam, revealedProfile, speciesPrior } from './teamPrior.js';

/**
 * Serialises our tracked battle into poke-engine's state string, so its search can play turns forward. The engine
 * needs complete information, and the opponent's sets are hidden, so each call describes one sampled "world": every
 * revealed opposing Pokémon takes one candidate set from our inference, drawn by its probability. Searching many
 * worlds and combining them is how Jaxcalibur and Foul Play handle hidden information.
 *
 * The opponent's unrevealed slots are filled too, as Jaxcalibur does: each takes a random species from the Gen 9
 * Random Battle pool, never one already on their team, with a set drawn the same way. Leaving them out made the
 * opponent look two or three Pokémon short, which flattered every position. The format is poke-engine's own,
 * documented by `State::deserialize` in its state.rs.
 */
export interface World { sets: Map<string, Candidate>; unrevealed: { pokemon: PokemonState; set: Candidate }[] }
const species = Object.keys(joint.species);
const levels = pools as Record<string, { level: number }>;
/** A stand-in for an opposing Pokémon not yet seen, carrying only what building its stats needs. */
function unseen(name: string): PokemonState {
  const dexName = dex.species.get(name).name;
  return { id: `unseen:${name}`, slot: 0, ident: `unseen: ${dexName}`, details: `${dexName}, L${levels[name]?.level ?? 80}`,
    species: dexName, hpPercent: 100, fainted: false, status: null, boosts: {}, volatiles: {}, knownMoves: [], revealedMoves: [],
    movePP: {}, moveUses: {}, ability: null, baseAbility: null, abilitySuppressed: false, item: null, teraType: null,
    terastallized: false, transformedInto: null, copiedMoves: [] } as unknown as PokemonState;
}

const status: Record<string, string> = { brn: 'BURN', slp: 'SLEEP', frz: 'FREEZE', par: 'PARALYZE', psn: 'POISON', tox: 'TOXIC' };
const weather: Record<string, string> = { SunnyDay: 'SUN', RainDance: 'RAIN', Sandstorm: 'SAND', Snow: 'SNOW', Snowscape: 'SNOW',
  Hail: 'HAIL', DesolateLand: 'HARSHSUN', PrimordialSea: 'HEAVYRAIN' };
const terrain: Record<string, string> = { 'Electric Terrain': 'ELECTRICTERRAIN', 'Psychic Terrain': 'PSYCHICTERRAIN',
  'Misty Terrain': 'MISTYTERRAIN', 'Grassy Terrain': 'GRASSYTERRAIN' };
/** Volatiles the engine models, by its names; anything else we track is left out rather than guessed at. */
const volatiles = new Set(['MUSTRECHARGE', 'AQUARING', 'ATTRACT', 'CONFUSION', 'CURSE', 'DESTINYBOND', 'DISABLE', 'ENCORE', 'FLASHFIRE',
  'FOCUSENERGY', 'HEALBLOCK', 'INGRAIN', 'LEECHSEED', 'MAGNETRISE', 'NORETREAT', 'PARTIALLYTRAPPED', 'PERISH4', 'PERISH3',
  'PERISH2', 'PERISH1', 'ROOST', 'SALTCURE', 'SLOWSTART', 'SUBSTITUTE', 'TAUNT', 'YAWN', 'PROTOSYNTHESISATK', 'PROTOSYNTHESISDEF',
  'PROTOSYNTHESISSPA', 'PROTOSYNTHESISSPD', 'PROTOSYNTHESISSPE', 'QUARKDRIVEATK', 'QUARKDRIVEDEF', 'QUARKDRIVESPA',
  'QUARKDRIVESPD', 'QUARKDRIVESPE',
  // Smack Down grounds, Tar Shot makes Fire hit double, Charge doubles the next Electric move, Throat Chop stops sound
  // moves and Torment a repeat: the engine reads each, and none reached it before.
  'SMACKDOWN', 'TARSHOT', 'CHARGE', 'THROATCHOP', 'TORMENT',
  // The charging turn of a two-turn move, which the engine turns into the strike next turn.
  'BOUNCE', 'DIG', 'DIVE', 'FLY', 'FREEZESHOCK', 'GEOMANCY', 'ICEBURN', 'METEORBEAM', 'ELECTROSHOT', 'PHANTOMFORCE',
  'RAZORWIND', 'SHADOWFORCE', 'SKULLBASH', 'SKYATTACK', 'SOLARBEAM', 'SOLARBLADE']);
const upper = (v: string | null | undefined) => id(v).toUpperCase();
const PLACEHOLDER = 'none,1,Typeless,Typeless,Typeless,Typeless,0,1,NONE,NONE,NONE,SERIOUS,,1,1,1,1,1,None,0,0,1,NONE;true;0,NONE;true;0,NONE;true;0,NONE;true;0,false,false,Normal,0';

/** Draw one candidate set for every revealed opposing Pokémon, in proportion to its probability. */
export function sampleWorld(s: BattleState, ourSide: SideId, random: () => number = Math.random): World {
  const theirs = s.sides[ourSide === 'p1' ? 'p2' : 'p1'];
  const selected: Candidate[] = [];
  const draw = (p: PokemonState, conditionTeam = false) => {
    // Every candidate, not the calculator's merged ones: dedupeCandidates keys on stats, ability and item, so it keeps
    // only the first moveset and Tera type of each group. Volcarona's 38 sets collapsed to two, Tera Water or Ground,
    // and no world ever held the Tera Grass Quiver Dance set it was actually running; the search rated Liquidation 0.95.
    let sets = inferOpponent(p).candidates;
    // Evidence no set explains leaves inference empty on purpose, so the payload makes no claim. The search still
    // needs a Pokémon there: a Zoroark's Dark Pulse, used as Chimecho, was written to Chimecho beside its own Calm Mind
    // and Dazzling Gleam, and every search played against an empty slot. Use the sets that explain the most of it.
    if (!sets.length && p.revealedMoves.length) sets = bestFitCandidates(p);
    const weight = (c: Candidate) => c.probability * (conditionTeam ? complementarySetWeight(c, selected) : 1);
    const total = sets.reduce((n, c) => n + weight(c), 0);
    let roll = random() * total;
    return sets.find(c => (roll -= weight(c)) <= 0) ?? sets.at(-1);
  };
  const world: World = { sets: new Map(), unrevealed: [] };
  for (const p of theirs.team) { const pick = draw(p); if (pick) { world.sets.set(p.id, pick); selected.push(pick); } }
  // Unseen slots follow the generator: its species odds, and only Pokémon its team rules allow beside those we have seen
  // (teamPrior.ts). Both halves of an unmasked Illusion are on the team, the Zoroark and the Pokémon it was disguised as.
  const team = theirs.team.flatMap(p => [revealedProfile(p.species, p.details, { ability: p.baseAbility ?? p.ability, moves: p.revealedMoves }),
    ...(p.illusion ? [revealedProfile(p.illusion.species, p.illusion.details)] : [])]);
  const missing = Math.max(0, (theirs.teamSize ?? 6) - theirs.team.length);
  const ruledOut = new Set<string>();
  for (let tries = 0; world.unrevealed.length < missing && tries < 200; tries++) {
    // While a revealed name may be a disguise, only the species clause is certain.
    const candidates = species.filter(name => !ruledOut.has(name) && (theirs.identityUncertain
      ? !team.some(p => p.base === baseSpecies(name)) : fitsTeam(name, team)));
    if (!candidates.length) break;
    const weights = candidates.map(name => speciesPrior.get(name) ?? 0);
    let roll = random() * weights.reduce((a, b) => a + b, 0);
    const name = candidates.find((_, i) => (roll -= weights[i]!) <= 0) ?? candidates.at(-1)!;
    const stand = unseen(name), pick = draw(stand, true);
    if (!pick) { ruledOut.add(name); continue; }
    team.push(revealedProfile(name, stand.details, { ability: pick.ability, moves: pick.moves })); selected.push(pick);
    world.unrevealed.push({ pokemon: stand, set: pick });
  }
  return world;
}

/** The four moves written for a Pokémon: our own known moves, or what theirs has revealed topped up from the set. */
const moveNames = (p: PokemonState, set: Candidate | undefined, known: boolean) =>
  (known ? p.knownMoves.map(id) : [...new Set([...p.revealedMoves.map(id), ...(set?.moves ?? [])])]).slice(0, 4);

function pokemon(p: PokemonState, set: Candidate | undefined, known: boolean, usable?: Set<string>, teraSpent = false): string | null {
  let built;
  try { built = buildPokemon(p, set); } catch { return null; }
  // Transform copies the target's species, types, weight, stats (all but HP) and moves, each with 5 PP; HP and item stay
  // its own. Written as the Ditto it was, the search saw a 12% Normal-type with nothing but Transform, where there stood a
  // +2 Choice Scarf copy of our Groudon: harmless things are worth keeping alive, so it chose Ruination, which cannot
  // knock out, over any attack that would have, and the copy's Precipice Blades took Ting-Lu next turn (2687224152).
  const species = dex.species.get(canonicalSpecies(p.transformedInto ?? p.species));
  if (!species.exists) return null;
  const types = [species.types[0], species.types[1] ?? 'Typeless'];
  // Soak, Protean, Libero and Burn Up change the typing until it switches out; the engine reverts to the base types
  // then, so those stay the species' own. Before, the changed typing never reached it.
  // Burn Up leaves its user typeless, which Showdown writes as ???.
  const changed = !p.transformedInto && p.volatiles.typechange?.data
    ? p.volatiles.typechange.data.split('/').map(t => (t === '???' ? 'Typeless' : t)) : null;
  const current = changed ? [changed[0]!, changed[1] ?? 'Typeless'] : types;
  const copied = p.transformedInto && p.copiedMoves.length ? [...new Set(p.copiedMoves.map(id))].slice(0, 4) : null;
  const maxHP = p.exactHP?.max ?? built.maxHP();
  const hp = p.fainted ? 0 : p.exactHP?.current ?? Math.max(1, Math.round((p.hpPercent ?? 100) / 100 * maxHP));
  // Harvest restores only a berry that was eaten: knocked off or tricked away, there is nothing to bring back, and the
  // engine cannot tell the two apart.
  const harvestIdle = id(p.ability ?? set?.ability) === 'harvest' && p.item === '' && !p.lastBerry;
  const ability = p.abilitySuppressed || harvestIdle ? 'NONE' : upper(p.ability ?? set?.ability) || 'NONE';
  // A Ditto is Imposter underneath whatever it copied: the engine reverts to the base ability on switching out, and
  // Imposter turns it back into a Ditto there and copies whatever is out when it returns.
  const imposter = !p.abilitySuppressed && canonicalSpecies(p.species) === 'Ditto' &&
    [p.baseAbility, p.ability, set?.ability].some(a => id(a ?? '') === 'imposter');
  const baseAbility = imposter ? 'IMPOSTER' : ability;
  const item = upper(p.item ?? set?.item) || 'NONE';
  const moves = (copied ?? moveNames(p, set, known)).map(m => {
    const move = dex.moves.get(m);
    const pp = copied ? 5 : known ? p.movePP[move.id]?.remaining : undefined;
    // Our active's moves are limited to what the request offers, which is how a Choice lock, Encore or Taunt reaches it.
    return `${upper(move.id)};${!!usable && !usable.has(move.id)};${Math.max(0, pp ?? Math.floor(move.pp * 8 / 5) - (p.ppSpent?.[move.id] ?? p.moveUses?.[move.id] ?? 0))}`;
  });
  while (moves.length < 4) moves.push('NONE;true;0');
  const evs = set?.evs ? [set.evs.hp, set.evs.atk, set.evs.def, set.evs.spa, set.evs.spd, set.evs.spe].join(';') : '';
  const stats = built.rawStats;
  return [upper(species.name), levelOf(p), ...current, ...types, hp, maxHP, ability, baseAbility, item, 'SERIOUS', evs,
    stats.atk, stats.def, stats.spa, stats.spd, stats.spe, status[p.status ?? ''] ?? 'None',
    // The engine's Rest counter starts at 3 and wakes on 1, one step per turn spent asleep.
    p.sleepFromRest ? Math.max(1, 3 - (p.sleepTurns ?? 0)) : 0, p.sleepTurns ?? 0, species.weightkg,
    ...moves, false, p.terastallized || (p.fainted && teraSpent), p.teraType ?? set?.teraType ?? 'Normal',
    // Damaging hits taken, which the engine's Rage Fist adds 50 base power for, up to six.
    Math.min(6, p.hitsTaken ?? 0)].join(',');
}

/** Ends of turn an effect started on `since` has seen by now; one started before turn 1 has seen none by turn 1. */
function elapsed(s: BattleState, since: number | undefined) {
  return since === undefined ? 0 : Math.max(0, s.turn - Math.max(1, since));
}

/** What our side may actually do this turn, from the request; the engine offers its own options otherwise. */
export interface Legal { moves: Set<string>; canSwitch: boolean; canTera: boolean; forcedSwitch?: boolean }
function side(s: BattleState, sideId: SideId, known: boolean, world: World, legal?: Legal) {
  const v = s.sides[sideId];
  const team = v.team.slice(0, 6);
  // The engine offers Tera while no Pokémon on a side is Terastallised, so a spent Tera is carried on the placeholders
  // and, when no Pokémon of ours shows it, on the fainted ones too.
  // A forced replacement cannot Tera on this choice, but the new Pokémon can still Tera next turn.
  // Marking the resource spent here made search prefer sacrificial replacements over Tera-capable answers.
  const spent = v.team.some(p => p.terastallized) || (!!legal && !legal.canTera && !legal.forcedSwitch);
  const unshown = spent && !v.team.some(p => p.terastallized);
  // A fainted Pokémon is written as itself at 0 HP, which the engine treats exactly like a placeholder until Revival
  // Blessing brings it back; as a placeholder there was nobody real to revive. Unbuildable Pokémon and the opposing
  // slots not yet revealed stay placeholders.
  // Their Choice lock, as the request gives ours: a sampled set holding a Choice item, or with Gorilla Tactics, is
  // locked into the move it used since coming in. Left open, a Choice Band locked into Close Combat could still pick
  // Shadow Claw at the root, and a Ghost switching in to take the lock looked worse than it was.
  const theirLock = (p: PokemonState) => {
    const set = world.sets.get(p.id);
    if (known || p.id !== v.activeId || !p.lastMoveUsed || p.transformedInto) return undefined;
    const item = id(p.item ?? set?.item ?? ''), ability = p.abilitySuppressed ? '' : id(p.ability ?? set?.ability ?? '');
    if (!['choiceband', 'choicespecs', 'choicescarf'].includes(item) && ability !== 'gorillatactics') return undefined;
    const move = id(p.lastMoveUsed);
    return moveNames(p, set, false).includes(move) ? new Set([move]) : undefined;
  };
  const slots = [...team.map(p => pokemon(p, known ? undefined : world.sets.get(p.id), known, p.id === v.activeId ? legal?.moves ?? theirLock(p) : undefined, unshown)),
    ...(known ? [] : world.unrevealed.map(u => pokemon(u.pokemon, u.set, false)))].slice(0, 6);
  const filler = spent ? PLACEHOLDER.replace(/,false,Normal,0$/, ',true,Normal,0') : PLACEHOLDER;
  const written = slots.map(x => x ?? filler);
  while (written.length < 6) written.push(filler);
  const active = Math.max(0, team.findIndex(p => p.id === v.activeId));
  const me = team[active];
  const count = (name: string) => Object.entries(v.hazards).find(([k]) => id(k) === name)?.[1] ?? 0;
  // Timed effects go in with the turns they have left. Written as if just started, a Reflect about to end read five
  // turns, a Yawn due to put us to sleep this turn read a turn away, and Slow Start at 0 counted down past zero and
  // never ended. An effect started before turn 1, on the leads' entry, has seen no end of turn by turn 1. A Light Clay
  // screen lasts eight: counted from five, every screen looked three turns shorter than it was.
  const turns = (name: string, total = 5) => {
    const entry = Object.entries(v.conditions).find(([k]) => id(k) === name);
    return entry ? Math.max(1, (entry[1].turns ?? total) - elapsed(s, entry[1].sinceTurn)) : 0;
  };
  // The consecutive-Protect count is what makes a repeated Protect fail; leaving it at zero had the search voting
  // for a third Protect as if it always worked.
  const conditions = [turns('auroraveil'), 0, 0, turns('lightscreen'), 0, 0, 0, turns('mist'), me?.consecutiveProtects ?? 0, 0, turns('reflect'),
    turns('safeguard'), count('spikes'), count('stealthrock') ? 1 : 0, count('stickyweb') ? 1 : 0, turns('tailwind', 4),
    me?.status === 'tox' ? me.toxicTurns ?? 0 : 0, count('toxicspikes'), 0].join(';');
  // Fake Out and First Impression work only straight after switching in, which the engine reads from the last action:
  // a Pokémon that has not moved since it entered last "switched", otherwise it last used one of its four moves.
  const last = me?.lastMoveUsed ? moveNames(me, known ? undefined : world.sets.get(me.id), known).indexOf(id(me.lastMoveUsed)) : -1;
  const lastUsed = !me?.lastMoveUsed ? `switch:${active}` : `move:${Math.max(0, last)}`;
  // The engine doubles damage on a Glaive Rush user for as long as the volatile is there and never removes it, so it
  // is passed only when the holder is hit before its next move: ours when we do not surely move first, theirs when we do.
  const first = speedSummary(s).ifEqualPriority;
  const glaive = !!me && Object.keys(me.volatiles).some(k => id(k) === 'glaiverush') && (sideId === s.mySide ? first !== 'ours-first' : first === 'ours-first');
  const vols = me ? Object.keys(me.volatiles).map(k => upper(k)).filter(k => volatiles.has(k) || (k === 'GLAIVERUSH' && glaive)) : [];
  // Outrage and its kind: ours is locked when the request offers only the rampage move; theirs surely is after its
  // first turn, since the lock lasts two or three. The engine counts ends of turn from 0 and releases after the third.
  const rampage = me?.rampage;
  // The engine repeats the last move by its slot, so the rampage move must be the last one used and be in the moveset
  // written; a sampled set without it would lock them into another move.
  const locked = !!rampage && last >= 0 && id(me!.lastMoveUsed ?? '') === id(rampage.move) &&
    (legal ? legal.moves.size === 1 && legal.moves.has(id(rampage.move)) : !known && rampage.turns === 1);
  if (locked && !vols.includes('LOCKEDMOVE')) vols.push('LOCKEDMOVE');
  const abilityOf = (p: PokemonState) => p.abilitySuppressed ? '' : id(p.ability ?? (known ? '' : world.sets.get(p.id)?.ability) ?? '');
  // Truant: having moved last turn, it loafs this one. A move before its last switch-in does not count.
  if (me && abilityOf(me) === 'truant' && me.lastActedTurn === s.turn - 1 && (me.activeSinceTurn ?? Infinity) <= me.lastActedTurn) vols.push('TRUANT');
  // Unburden doubles Speed once the holder's item is gone while it is out.
  if (me && abilityOf(me) === 'unburden' && me.itemLostOnTurn !== undefined && (me.activeSinceTurn ?? Infinity) <= me.itemLostOnTurn) vols.push('UNBURDEN');
  if (me && !me.transformedInto && me.volatiles.typechange?.data && !vols.includes('TYPECHANGE')) vols.push('TYPECHANGE');
  const since = (key: string) => Object.entries(me?.volatiles ?? {}).find(([k]) => id(k) === key)?.[1].sinceTurn;
  const counted = (key: string, most: number) => since(key) === undefined ? 0 : Math.min(most, elapsed(s, since(key)!));
  // Slow Start starts at 6 on entry and ends at 0, one step each end of turn.
  const slowStart = since('slowstart') === undefined ? 0 : Math.max(1, 6 - elapsed(s, since('slowstart')!));
  const durations = [0, counted('encore', 2), locked ? Math.min(2, rampage!.turns) : 0, slowStart, counted('taunt', 2), counted('yawn', 1)].join(';');
  const b = (stat: string) => me?.boosts[stat] ?? 0;
  // The opponent's HP is written in the sampled set's own units, so its Substitute must be too: a flat 100 made every
  // opposing shell 25 HP, a third of a real one on a typical 300-HP Pokémon. A shell already hit keeps what it has left.
  const built = (p: PokemonState | undefined) => {
    if (!p) return undefined;
    if (p.exactHP?.max) return p.exactHP.max;
    try { return buildPokemon(p, known ? undefined : world.sets.get(p.id)).maxHP(); } catch { return undefined; }
  };
  const maxHP = built(me) ?? 100;
  const shell = Math.floor(maxHP / 4);
  const subHP = me?.substitute && me.substitute.hits > 0
    ? Math.max(1, Math.min(shell, Math.round((me.substitute.hp[0] + me.substitute.hp[1]) / 2))) : shell;
  // A Future Sight this side cast: the engine sets 3 on the turn it is used and strikes as it counts down from 1, at the
  // end of the second turn after, with the user's stats. Before this a pending one never reached it, 120 power unseen.
  const pending = v.slotConditions.futureSight;
  const casterSlot = pending ? team.findIndex(p => p.id === pending.fromId) : -1;
  const futureLeft = pending ? 3 - elapsed(s, pending.setOnTurn) : 0;
  const futureSight = casterSlot >= 0 && futureLeft >= 1 ? [futureLeft, casterSlot] : [0, 0];
  // An opposing Wish carries no exact HP, so it heals half of its user's max HP in this world's sampled set.
  const wish = v.slotConditions.wish;
  const wishHP = wish ? wish.healsHP ?? Math.floor((built(team.find(p => p.id === wish.fromId)) ?? 0) / 2) : 0;
  // A pivot's replacement (U-turn, Volt Switch, Flip Turn, Parting Shot) after the opponent has already moved comes in
  // free: the turn is over for them. Told nothing, the engine let them attack whatever came in, which prices every slow
  // pivot as if it cost the replacement a hit. A faster pivot leaves their move to come, which the engine plays as usual,
  // and a fainted active already gets them no move.
  const opposing = s.sides[sideId === 'p1' ? 'p2' : 'p1'], foe = opposing.team.find(p => p.id === opposing.activeId);
  const freeReplacement = !!legal?.forcedSwitch && !!me && !me.fainted && !!foe && !foe.fainted && foe.lastActedTurn === s.turn;
  return { text: [...written, active, conditions, vols.map(x => `${x}:`).join(''), durations,
    vols.includes('SUBSTITUTE') ? subHP : 0,
    b('atk'), b('def'), b('spa'), b('spd'), b('spe'), b('accuracy'), b('evasion'),
    // The engine sets Wish to 2 and heals when it reaches 1, one step down per end of turn.
    ...(wish && wishHP > 0 && 2 - (s.turn - wish.setOnTurn) >= 1 ? [2 - (s.turn - wish.setOnTurn), wishHP] : [0, 0]),
    ...futureSight, freeReplacement, 'NONE', false, false, !!legal && !legal.canSwitch, lastUsed, false].join('='), team };
}

/** Our side is side one; the result names the Pokémon behind each engine switch so moves can be mapped back. */
export function toEngineState(s: BattleState, ourSide: SideId, world: World, legal?: Legal) {
  const ours = side(s, ourSide, true, world, legal), theirs = side(s, ourSide === 'p1' ? 'p2' : 'p1', false, world);
  // Weather, terrain and Trick Room with the turns they have left too: a Trick Room on its last turn read five.
  const left = (key: string | null) => Math.max(1, 5 - elapsed(s, key ? s.effectStartTurns[key] : undefined));
  const field = [`${weather[s.field.weather ?? ''] ?? 'NONE'};${s.field.weather ? left('weather') : 5}`,
    `${terrain[s.field.terrain ?? ''] ?? 'NONE'};${s.field.terrain ? left(s.field.terrain) : 5}`,
    `${s.field.trickRoom};${s.field.trickRoom ? left('Trick Room') : 5}`, 'false'].join('/');
  return { state: `${ours.text}/${theirs.text}/${field}`, ourTeam: ours.team };
}
