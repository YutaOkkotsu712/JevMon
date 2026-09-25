import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import type { Candidate } from '../strategy/setTypes.js';
import { buildPokemon, levelOf } from '../strategy/calcCore.js';
import { bestFitCandidates, inferOpponent } from '../strategy/inference.js';
import { speedSummary } from '../strategy/speed.js';
import { canonicalSpecies, dex, id } from '../pokemon/data.js';
import joint from '../data/gen9-joint-sets.json' with { type: 'json' };
import pools from '../data/gen9-sets.json' with { type: 'json' };

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
  'QUARKDRIVESPD', 'QUARKDRIVESPE']);
const upper = (v: string | null | undefined) => id(v).toUpperCase();
const PLACEHOLDER = 'none,1,Typeless,Typeless,Typeless,Typeless,0,1,NONE,NONE,NONE,SERIOUS,,1,1,1,1,1,None,0,0,1,NONE;true;0,NONE;true;0,NONE;true;0,NONE;true;0,false,false,Normal';

/** Draw one candidate set for every revealed opposing Pokémon, in proportion to its probability. */
export function sampleWorld(s: BattleState, ourSide: SideId, random: () => number = Math.random): World {
  const theirs = s.sides[ourSide === 'p1' ? 'p2' : 'p1'];
  const draw = (p: PokemonState) => {
    // Every candidate, not the calculator's merged ones: dedupeCandidates keys on stats, ability and item, so it keeps
    // only the first moveset and Tera type of each group. Volcarona's 38 sets collapsed to two, Tera Water or Ground,
    // and no world ever held the Tera Grass Quiver Dance set it was actually running; the search rated Liquidation 0.95.
    let sets = inferOpponent(p).candidates;
    // Evidence no set explains leaves inference empty on purpose, so the payload makes no claim. The search still
    // needs a Pokémon there: a Zoroark's Dark Pulse, used as Chimecho, was written to Chimecho beside its own Calm Mind
    // and Dazzling Gleam, and every search played against an empty slot. Use the sets that explain the most of it.
    if (!sets.length && p.revealedMoves.length) sets = bestFitCandidates(p);
    const total = sets.reduce((n, c) => n + c.probability, 0);
    let roll = random() * total;
    return sets.find(c => (roll -= c.probability) <= 0) ?? sets.at(-1);
  };
  const world: World = { sets: new Map(), unrevealed: [] };
  for (const p of theirs.team) { const pick = draw(p); if (pick) world.sets.set(p.id, pick); }
  const taken = new Set(theirs.team.map(p => id(canonicalSpecies(p.species))));
  const missing = Math.max(0, (theirs.teamSize ?? 6) - theirs.team.length);
  for (let tries = 0; world.unrevealed.length < missing && tries < 200; tries++) {
    const name = species[Math.floor(random() * species.length)]!;
    if (taken.has(name)) continue;
    const stand = unseen(name), pick = draw(stand);
    if (!pick) continue;
    taken.add(name);
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
  const copied = p.transformedInto && p.copiedMoves.length ? [...new Set(p.copiedMoves.map(id))].slice(0, 4) : null;
  const maxHP = p.exactHP?.max ?? built.maxHP();
  const hp = p.fainted ? 0 : p.exactHP?.current ?? Math.max(1, Math.round((p.hpPercent ?? 100) / 100 * maxHP));
  const ability = p.abilitySuppressed ? 'NONE' : upper(p.ability ?? set?.ability) || 'NONE';
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
  return [upper(species.name), levelOf(p), ...types, ...types, hp, maxHP, ability, ability, item, 'SERIOUS', evs,
    stats.atk, stats.def, stats.spa, stats.spd, stats.spe, status[p.status ?? ''] ?? 'None',
    // The engine's Rest counter starts at 3 and wakes on 1, one step per turn spent asleep.
    p.sleepFromRest ? Math.max(1, 3 - (p.sleepTurns ?? 0)) : 0, p.sleepTurns ?? 0, species.weightkg,
    ...moves, false, p.terastallized || (p.fainted && teraSpent), p.teraType ?? set?.teraType ?? 'Normal'].join(',');
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
  const slots = [...team.map(p => pokemon(p, known ? undefined : world.sets.get(p.id), known, p.id === v.activeId ? legal?.moves : undefined, unshown)),
    ...(known ? [] : world.unrevealed.map(u => pokemon(u.pokemon, u.set, false)))].slice(0, 6);
  const filler = spent ? PLACEHOLDER.replace(/,false,Normal$/, ',true,Normal') : PLACEHOLDER;
  const written = slots.map(x => x ?? filler);
  while (written.length < 6) written.push(filler);
  const active = Math.max(0, team.findIndex(p => p.id === v.activeId));
  const me = team[active];
  const count = (name: string) => Object.entries(v.hazards).find(([k]) => id(k) === name)?.[1] ?? 0;
  const turns = (name: string) => (Object.keys(v.conditions).some(k => id(k) === name) ? 5 : 0);
  // The consecutive-Protect count is what makes a repeated Protect fail; leaving it at zero had the search voting
  // for a third Protect as if it always worked.
  const conditions = [turns('auroraveil'), 0, 0, turns('lightscreen'), 0, 0, 0, turns('mist'), me?.consecutiveProtects ?? 0, 0, turns('reflect'),
    turns('safeguard'), count('spikes'), count('stealthrock') ? 1 : 0, count('stickyweb') ? 1 : 0, turns('tailwind'),
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
  // An opposing Wish carries no exact HP, so it heals half of its user's max HP in this world's sampled set.
  const wish = v.slotConditions.wish;
  const wishHP = wish ? wish.healsHP ?? Math.floor((built(team.find(p => p.id === wish.fromId)) ?? 0) / 2) : 0;
  return { text: [...written, active, conditions, vols.map(x => `${x}:`).join(''), '0;0;0;0;0;0',
    vols.includes('SUBSTITUTE') ? subHP : 0,
    b('atk'), b('def'), b('spa'), b('spd'), b('spe'), b('accuracy'), b('evasion'),
    // The engine sets Wish to 2 and heals when it reaches 1, one step down per end of turn.
    ...(wish && wishHP > 0 && 2 - (s.turn - wish.setOnTurn) >= 1 ? [2 - (s.turn - wish.setOnTurn), wishHP] : [0, 0]),
    0, 0, false, 'NONE', false, false, !!legal && !legal.canSwitch, lastUsed, false].join('='), team };
}

/** Our side is side one; the result names the Pokémon behind each engine switch so moves can be mapped back. */
export function toEngineState(s: BattleState, ourSide: SideId, world: World, legal?: Legal) {
  const ours = side(s, ourSide, true, world, legal), theirs = side(s, ourSide === 'p1' ? 'p2' : 'p1', false, world);
  const field = [`${weather[s.field.weather ?? ''] ?? 'NONE'};5`, `${terrain[s.field.terrain ?? ''] ?? 'NONE'};5`,
    `${s.field.trickRoom};5`, 'false'].join('/');
  return { state: `${ours.text}/${theirs.text}/${field}`, ourTeam: ours.team };
}
