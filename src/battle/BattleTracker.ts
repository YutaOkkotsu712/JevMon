import { dex, id as moveId } from '../pokemon/data.js';
import { SubstituteTracker } from '../strategy/SubstituteTracker.js';
import { displayedMoves, formFromImmunity, formFromMove, illusionLevel, type IllusionForm } from '../strategy/illusion.js';
import { BattleEvidence } from '../strategy/BattleEvidence.js';
import { createBattleState, type BattleState, type PokemonState } from './BattleState.js';
import { canonicalIdent, isRecord, isStatus, parseCondition, sideId, speciesFromDetails } from '../showdown/parser.js';
import type { ProtocolMessage } from '../showdown/protocol.js';

const stats = new Set(['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion']);
const hazardLimits: Record<string, number> = { 'Stealth Rock': 1, 'Spikes': 3, 'Toxic Spikes': 2, 'Sticky Web': 1 };
const effectName = (value: string) => value.replace(/^(move|ability|item): /, '');
const userId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const identityDetails = (details: string) => details.replace(/, tera:[^,]+/g, '');
const effectId = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const rememberNativeAbility = (pokemon: PokemonState, ability: string) => {
  if (!pokemon.baseAbility && !pokemon.transformedInto &&
      Object.values(dex.species.get(pokemon.species).abilities ?? {}).some(value => effectId(value) === effectId(ability)))
    pokemon.baseAbility = ability;
};
/** Marks a volatile announced by -singlemove, which ends when its holder next tries to move. */
const singleMove = 'until-its-next-move';
const endSingleMove = (p: PokemonState) => {
  for (const [key, v] of Object.entries(p.volatiles)) if (v.data === singleMove) delete p.volatiles[key];
};
/** Protecting moves, whose consecutive use is what makes the next one likely to fail. */
export const protectMoves = new Set(['protect', 'detect', 'spikyshield', 'banefulbunker', 'silktrap',
  'kingsshield', 'obstruct', 'burningbulwark', 'maxguard', 'endure']);
/** Callers that pick from the user's own move set, so the move they call is still evidence of that set. */
const ownSetCallers = new Set(['sleeptalk', 'instruct', 'dancer0', 'lockedmove']);

/**
 * The stats Transform copies: all but HP, taken from the target. Ours are known exactly. An opponent's are the Random
 * Battle spread at its level (85 EVs and 31 IVs in each, neutral nature), which misses only the rare set with 0 Attack
 * or Speed IVs. Left unknown, every estimate for our Ditto was dropped, and the request then filled in Ditto's own.
 */
function copiedStats(target: PokemonState): Record<string, number> {
  if (['atk', 'def', 'spa', 'spd', 'spe'].every(k => (target.stats?.[k] ?? 0) > 0)) return { ...target.stats };
  const species = dex.species.get(target.transformedInto ?? target.species);
  if (!species.exists) return { ...target.stats };
  const level = Number(/(?:^|, )L(\d+)(?:,|$)/.exec(target.details)?.[1] ?? 100);
  const stat = (base: number) => Math.floor((2 * base + 31 + Math.floor(85 / 4)) * level / 100) + 5;
  const b = species.baseStats;
  return { atk: stat(b.atk), def: stat(b.def), spa: stat(b.spa), spd: stat(b.spd), spe: stat(b.spe) };
}

export class BattleTracker {
  state: BattleState;
  private nextId = 0;
  private evidence = new BattleEvidence();
  private substitutes = new SubstituteTracker();
  constructor(battleId: string, private readonly username?: string) { this.state = createBattleState(battleId); }
  private uncertain(message: string) {
    if (!this.state.uncertainties.includes(message)) this.state.uncertainties.push(message);
  }
  private makePokemon(ident: string, details: string): PokemonState {
    const side = sideId(ident)!;
    return { id: `${side}-${++this.nextId}`, ident: canonicalIdent(ident), slot: null, details,
      // Every Pokémon is first seen before it can be hit (leads at turn 0, the rest on their first switch-in, and a
      // rejoin replays the battle from the start), so its hits are counted from zero; Rage Fist reads the count.
      hitsTaken: 0, transformedInto: null, knownMoves: [], copiedMoves: [], stats: {}, volatiles: {}, baseAbility: null, abilitySuppressed: false,
      species: speciesFromDetails(details), hpPercent: null, hpPrecision: 'unknown', status: null,
      fainted: false, boosts: {}, revealedMoves: [], ability: null, item: null, teraType: null, terastallized: false,
      activeSinceTurn: null, lastActiveTurn: null, moveUses: {}, movePP: {}, consecutiveProtects: 0,
      lastMoveUsed: null, sameMoveStreak: 0, toxicTurns: 0, sleepTurns: 0, lastSleepTurnCounted: null, sleepFromRest: false };
  }
  private countSleepTurn(pokemon: PokemonState) {
    if (pokemon.lastSleepTurnCounted === this.state.turn) return;
    pokemon.sleepTurns++;
    pokemon.lastSleepTurnCounted = this.state.turn;
  }
  /** The last move used, by side, so an immunity can be traced to the attack that met it. */
  private lastMove: { side: string; move: string } | null = null;
  /** Treat a disguised Pokémon as the Zoroark form under it, until it leaves the field. */
  private unmask(p: PokemonState, form: IllusionForm, clue: string) {
    p.illusion = { species: p.species, details: p.details };
    p.species = form;
    p.details = `${form}, L${illusionLevel(form)}`;
    const side = this.state.sides[p.id.startsWith('p1') ? 'p1' : 'p2'];
    side.identityUncertain = true;
    this.uncertain(`Illusion: ${clue}, so the ${p.illusion.species} is a ${form}`);
  }
  private find(ident: string): PokemonState | undefined {
    const id = sideId(ident);
    if (!id) return;
    const side = this.state.sides[id];
    if (/^p[12]a:/.test(ident)) return side.team.find(p => p.id === side.activeId);
    const candidates = side.team.filter(p => p.ident === canonicalIdent(ident));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) this.uncertain('Ambiguous inactive Pokémon identity');
    return undefined;
  }
  private condition(p: PokemonState, text: string, exact = false) {
    exact ||= !!this.state.mySide && sideId(p.ident) === this.state.mySide;
    const condition = parseCondition(text);
    if (condition) {
      Object.assign(p, condition, { hpPrecision: exact ? 'exact' : 'public' });
      const fraction = /^(\d+)\/(\d+)/.exec(text);
      if (exact && fraction) p.exactHP = { current: Number(fraction[1]), max: Number(fraction[2]) };
      else if (exact && condition.fainted && p.exactHP) p.exactHP.current = 0;
      else delete p.exactHP;
    }
    else this.uncertain('Malformed HP condition ignored');
  }
  handle(message: ProtocolMessage): void {
    if (message.room !== this.state.battleId) return;
    this.substitutes.before(this.state, message);
    this.evidence.before(this.state, message);
    const a = message.data.split('|');
    const first = a[0] ?? '', second = a[1] ?? '', third = a[2] ?? '';
    const id = sideId(first), side = id ? this.state.sides[id] : undefined;
    const pokemon = this.find(first);
    switch (message.type) {
      case 'init':
        if (first === 'battle') { this.state = createBattleState(this.state.battleId); this.nextId = 0; this.evidence = new BattleEvidence(); }
        break;
      case 'player':
        if (side) {
          side.name = second;
          side.rating = /^\d+$/.test(a[3] ?? '') ? Number(a[3]) : null;
          if (this.username && userId(second) === userId(this.username)) this.state.mySide = id;
        }
        break;
      case 'teamsize':
        if (side && /^[1-6]$/.test(second)) side.teamSize = Number(second);
        break;
      case 'turn':
        if (/^\d+$/.test(first) && Number.isSafeInteger(Number(first))) {
          this.state.turn = Number(first);
          // Toxic damage grows by a sixteenth for every turn it has been in place.
          for (const s of Object.values(this.state.sides)) {
            const active = s.team.find(p => p.id === s.activeId);
            if (active?.status === 'tox') active.toxicTurns++;
          }
          // A new pairing starts a new record; the same pairing keeps the HP it met at.
          const [one, two] = [this.state.sides.p1, this.state.sides.p2].map(s => s.team.find(p => p.id === s.activeId));
          if (one && two && (this.state.matchup?.p1 !== one.id || this.state.matchup?.p2 !== two.id)) {
            this.state.matchup = { p1: one.id, p2: two.id, sinceTurn: this.state.turn, p1HP: one.hpPercent, p2HP: two.hpPercent };
          }
        }
        break;
      case 'switch': case 'drag': {
        if (!side || !/^p[12]a: .+/.test(first) || !second || !parseCondition(third)) break;
        const previous = side.team.find(p => p.id === side.activeId);
        // Recorded before anything below resets the outgoing Pokémon, since its last move is what marks a pivot.
        const otherSide = this.state.sides[id === 'p1' ? 'p2' : 'p1'];
        const facing = otherSide.team.find(p => p.id === otherSide.activeId);
        const pivot = previous?.lastMoveUsed && previous.lastActedTurn === this.state.turn && dex.moves.get(previous.lastMoveUsed).selfSwitch
          ? previous.lastMoveUsed : null;
        const record = { turn: this.state.turn, from: previous?.species ?? null, to: speciesFromDetails(second),
          facing: facing && !facing.fainted ? facing.species : null, afterFaint: !!previous?.fainted, dragged: message.type === 'drag', via: pivot };
        side.switches = [...(side.switches ?? []), record].slice(-40);
        if (previous) {
          // A Zoroark found under a disguise leaves with it; whoever comes in under that name next may be the real one.
          if (previous.illusion) {
            previous.revealedMoves = displayedMoves(previous.illusion.species, previous.revealedMoves);
            previous.species = previous.illusion.species; previous.details = previous.illusion.details;
            delete previous.illusion;
          }
          previous.lastActiveTurn = this.state.turn;
          previous.consecutiveProtects = 0;
          previous.lastMoveUsed = null; previous.sameMoveStreak = 0;
          previous.toxicTurns = 0; // The counter restarts when a Pokémon leaves the field.
          // Copied stats leave with the Transform; our own come back with the next request.
          if (previous.transformedInto) previous.stats = {};
          delete previous.rampage;
          previous.boosts = {}; previous.volatiles = {}; previous.transformedInto = null; previous.copiedMoves = [];
          previous.ability = previous.baseAbility; previous.abilitySuppressed = false;
        }
        const named = side.team.filter(p => p.ident === canonicalIdent(first));
        const matching = named.filter(p => identityDetails(p.details) === identityDetails(second));
        const candidates = matching.length ? matching : named.length === 1 ? named : [];
        if (candidates.length > 1) { side.identityUncertain = true; this.uncertain('Ambiguous switch identity'); }
        let next = candidates.length === 1 ? candidates[0] : undefined;
        if (!next) {
          next = this.makePokemon(first, second);
          side.team.push(next);
        }
        next.boosts = {};
        next.details = second;
        next.species = speciesFromDetails(second);
        // A switch or drag always means entering the field, even where a request had already named the
        // active slot. Joining mid-battle leaves this null, which reads as unknown rather than as just arrived.
        next.activeSinceTurn = this.state.turn;
        side.activeId = next.id;
        this.condition(next, third);
        const tera = /, tera:([^,]+)/.exec(second)?.[1];
        if (tera) { next.teraType = tera; next.terastallized = true; }
        break;
      }
      case 'replace':
        // Illusion can make earlier observations belong to another Pokémon.
        // Keep the uncertainty visible instead of merging histories with certainty.
        if (pokemon && second) {
          delete pokemon.illusion;
          pokemon.ident = canonicalIdent(first); pokemon.details = second; pokemon.species = speciesFromDetails(second);
          this.condition(pokemon, third);
          if (side) side.identityUncertain = true;
          this.uncertain('Illusion revealed: earlier identity and team counts may be ambiguous');
        }
        break;
      case 'detailschange': case '-formechange':
        if (pokemon && second) {
          pokemon.species = speciesFromDetails(second);
          // -formechange names only the new form, so the level and gender stay those it replaces. Taking the bare form
          // as the details left Cramorant-Gorging with no level, which reads as 100: its L86 Surf was predicted a third
          // too strong and our hits on it a third too weak (2687193686).
          pokemon.details = message.type === '-formechange'
            ? [second.split(',')[0]!.trim(), ...pokemon.details.split(', ').slice(1)].join(', ') : second;
        }
        break;
      case '-damage': case '-heal':
        if (pokemon) {
          if (message.type === '-damage' && parseCondition(second) && !a.some(x=>x.startsWith('[from]')) && pokemon.hitsTaken !== undefined) pokemon.hitsTaken++;
          this.condition(pokemon, second);
        }
        break;
      case '-sethp':
        for (let i = 0; i + 1 < a.length; i += 2) {
          const target = this.find(a[i]!); if (target) this.condition(target, a[i + 1]!);
        }
        break;
      case 'faint':
        if (side) side.totalFaints = (side.totalFaints ?? 0) + 1;
        if (pokemon) { pokemon.hpPercent = 0; pokemon.fainted = true; pokemon.status = null; pokemon.boosts = {}; }
        break;
      case '-status': if (pokemon && isStatus(second)) {
        pokemon.status = second; pokemon.toxicTurns = 0;
        // Sleep lasts one to three turns, except from Rest, which is exactly two.
        pokemon.sleepTurns = 0; pokemon.lastSleepTurnCounted = null;
        // A prior Rest is not evidence that this new sleep came from Rest. The protocol names the source.
        pokemon.sleepFromRest = second === 'slp' && a.some(part => /^\[from\] move: Rest$/i.test(part));
      } break;
      case '-curestatus': if (pokemon) { pokemon.status = null; pokemon.toxicTurns = 0; pokemon.sleepTurns = 0; pokemon.lastSleepTurnCounted = null; pokemon.sleepFromRest = false; } break;
      // A turn lost to sleep is the only public evidence of how far through the counter a Pokémon is.
      case 'cant':
        if (pokemon) endSingleMove(pokemon);
        if (pokemon && moveId(second) === 'slp') this.countSleepTurn(pokemon);
        // A rampage stopped by sleep, paralysis or a flinch ends without the confusion.
        if (pokemon) delete pokemon.rampage;
        // Truant runs after sleep, freeze and recharge but before paralysis, flinch and Taunt, so a turn stopped
        // by one of those later checks still counts as the turn Truant allowed.
        if (pokemon && !['slp', 'frz', 'recharge', 'abilitytruant'].includes(moveId(second))) pokemon.lastActedTurn = this.state.turn;
        break;
      case '-cureteam': if (side) side.team.forEach(p => { p.status = null; }); break;
      case 'move':
        if (pokemon && second) {
          const moves = pokemon.transformedInto ? pokemon.copiedMoves : pokemon.revealedMoves;
          // A move called by another (Sleep Talk, Copycat) spends no PP of its own.
          const called = a.some(value => value.startsWith('[from]'));
          // Only some of those come from the user's own move set. A move reflected by Magic Bounce or
          // copied by Dancer belongs to whoever used it first, and recording it here would rule out every
          // set the Pokémon could actually have — which is how a Magic Bounce erases its own warning.
          const source = a.find(value => value.startsWith('[from]'))?.replace(/^\[from\] ?/, '') ?? '';
          // A move of its own ends the last one's single-move effect; a called move comes after the caller already did.
          // The second turn of a two-turn move or a rampage arrives as [from]lockedmove and is its own move too: left
          // standing, a fired Meteor Beam's charge told the engine it was still charging, so the next turn it offered
          // nothing but Meteor Beam.
          if (!called || effectId(source) === 'lockedmove') endSingleMove(pokemon);
          const ownMoveSet = !called || ownSetCallers.has(effectId(source.replace(/^(move|ability): /, '')));
          if (ownMoveSet && !moves.includes(second)) moves.push(second);
          this.lastMove = { side: id ?? '', move: second };
          // Illusion: a move the disguise could never carry names the Zoroark underneath.
          if (id !== this.state.mySide && !called && !pokemon.transformedInto && !pokemon.illusion) {
            const form = formFromMove(pokemon.species, second, pokemon.revealedMoves);
            if (form) this.unmask(pokemon, form, `${pokemon.species} used ${second}, which no ${pokemon.species} set carries`);
          }
          const key = effectId(second);
          if (!called) pokemon.moveUses[key] = (pokemon.moveUses[key] ?? 0) + 1;
          // Pressure charges a second PP when the move is aimed at its holder, which is decided at the moment of use:
          // counting it later from whoever is out now doubled uses aimed at other Pokémon, or missed the ones that paid.
          if (!called) {
            const target = third ? this.find(third) : undefined;
            const pressured = !!target && sideId(third) !== id && !target.abilitySuppressed && effectId(target.ability ?? '') === 'pressure';
            (pokemon.ppSpent ??= {})[key] = (pokemon.ppSpent[key] ?? 0) + (pressured ? 2 : 1);
          }
          // Healing within the pairing is what a stall looks like: counted per side, reset when either side changes.
          const healing = dex.moves.get(second);
          if (!called && id && this.state.matchup?.[id] === pokemon.id && healing.category === 'Status' && healing.flags.heal && (healing.target === 'self' || healing.id === 'strengthsap')) {
            const heals = this.state.matchup.heals ??= { p1: 0, p2: 0 };
            heals[id]++;
            const facing = this.state.matchup[id === 'p1' ? 'p2' : 'p1'];
            const record = this.state.healsAgainst ??= {};
            record[`${pokemon.id}>${facing}`] = (record[`${pokemon.id}>${facing}`] ?? 0) + 1;
          }
          pokemon.consecutiveProtects = protectMoves.has(key) ? pokemon.consecutiveProtects + 1 : 0;
          // A sleeper using Sleep Talk spends a turn of its sleep without a 'cant' line, which is the only other sign.
          if (!called && pokemon.status === 'slp' && moveId(second) === 'sleeptalk') this.countSleepTurn(pokemon);
          // Outrage and its kind lock the user in: the turns after the first arrive marked [from]lockedmove.
          const continuing = effectId(source) === 'lockedmove';
          if (continuing && pokemon.rampage && pokemon.rampage.move === second) pokemon.rampage.turns++;
          else if (!called && healing.self?.volatileStatus === 'lockedmove') pokemon.rampage = { move: second, turns: 1 };
          else if (!called) delete pokemon.rampage;
          if (continuing) pokemon.lastActedTurn = this.state.turn;
          if (!called) {
            pokemon.lastActedTurn = this.state.turn;
            pokemon.sameMoveStreak = pokemon.lastMoveUsed === second ? pokemon.sameMoveStreak + 1 : 1;
            pokemon.lastMoveUsed = second;
          }
          if (['Baton Pass', 'Shed Tail'].includes(second)) this.uncertain('Passed volatiles may be incomplete');
          const owner = id && this.state.sides[id];
          // An opponent's Wish was never recorded, because its exact HP is unknown; half of whatever its max HP is still
          // lands on that slot next turn, which is what a stall and the search both have to reckon with.
          if (owner && key === 'wish') {
            owner.slotConditions.wish = { setOnTurn: this.state.turn, healsHP: pokemon.exactHP ? Math.floor(pokemon.exactHP.max / 2) : null, from: pokemon.species, fromId: pokemon.id };
          }
          if (owner && ['healingwish', 'lunardance'].includes(key)) {
            owner.slotConditions.healingWish = { from: pokemon.species, move: second };
          }
        }
        break;
      case '-boost': case '-unboost': case '-setboost': {
        if (!pokemon || !stats.has(second) || !/^-?\d+$/.test(third)) break;
        const amount = Number(third);
        if (!Number.isSafeInteger(amount)) break;
        const next = message.type === '-setboost' ? amount : (pokemon.boosts[second] ?? 0) + (message.type === '-unboost' ? -amount : amount);
        pokemon.boosts[second] = Math.max(-6, Math.min(6, next));
        break;
      }
      case '-clearboost': if (pokemon) pokemon.boosts = {}; break;
      case '-clearallboost':
        for (const s of Object.values(this.state.sides)) { const active = s.team.find(p => p.id === s.activeId); if (active) active.boosts = {}; }
        break;
      case '-clearpositiveboost': case '-clearnegativeboost':
        if (pokemon) for (const [stat, value] of Object.entries(pokemon.boosts)) {
          if (message.type === '-clearpositiveboost' ? value > 0 : value < 0) pokemon.boosts[stat] = 0;
        }
        break;
      case '-invertboost': if (pokemon) for (const stat of Object.keys(pokemon.boosts)) pokemon.boosts[stat] = -pokemon.boosts[stat]!; break;
      case '-ability':
        if (pokemon && second) {
          pokemon.ability = second; pokemon.abilitySuppressed = false;
          if (!a.some(x => x.startsWith('[from]')) && !pokemon.transformedInto && !pokemon.baseAbility) pokemon.baseAbility = second;
        }
        break;
      case '-endability': if (pokemon) pokemon.abilitySuppressed = true; break;
      case '-item': if (pokemon && second) { pokemon.item = second; delete pokemon.itemLostOnTurn; } break;
      case '-enditem':
        if (pokemon) {
          pokemon.item = ''; pokemon.itemLostOnTurn = this.state.turn;
          if (second && a.includes('[eat]')) pokemon.lastBerry = second;
        }
        break;
      case '-terastallize': if (pokemon && second) { pokemon.teraType = second; pokemon.terastallized = true; } break;
      case '-weather':
        if (first) {
          this.state.field.weather = first === 'none' ? null : first === 'Snowscape' ? 'Snow' : first;
          if (first === 'none') delete this.state.effectStartTurns.weather;
          else if (!a.includes('[upkeep]')) this.state.effectStartTurns.weather = this.state.turn;
        }
        break;
      case '-fieldstart': case '-fieldend': {
        const effect = effectName(first), started = message.type === '-fieldstart';
        if (effect.endsWith(' Terrain')) this.state.field.terrain = started ? effect : null;
        if (effect === 'Trick Room') this.state.field.trickRoom = started;
        if (started) this.state.effectStartTurns[effect] = this.state.turn;
        else delete this.state.effectStartTurns[effect];
        break;
      }
      case '-sidestart': case '-sideend': {
        const effect = effectName(second), limit = hazardLimits[effect];
        if (side) {
          if (message.type === '-sidestart') side.conditions[effect] ??= { sinceTurn: this.state.turn };
          else delete side.conditions[effect];
        }
        if (side && limit) side.hazards[effect] = message.type === '-sideend' ? 0 : Math.min(limit, (side.hazards[effect] ?? 0) + 1);
        break;
      }
      case 'request': this.request(message.data); break;
      case 'win': this.state.ended = true; this.state.winner = first; this.state.requestKind = 'none'; break;
      case 'tie': this.state.ended = true; this.state.winner = null; this.state.requestKind = 'none'; break;
      case '-swapboost': case '-copyboost': {
        const other = this.find(second);
        if (!pokemon || !other) break;
        const selected = third && !third.startsWith('[') ? third.split(',').map(x => x.trim()).filter(x => stats.has(x)) : [...stats];
        // Simulator logs the recipient first for Psych Up (unlike the old protocol prose).
        for (const stat of selected) {
          const old = pokemon.boosts[stat] ?? 0;
          pokemon.boosts[stat] = other.boosts[stat] ?? 0;
          if (message.type === '-swapboost') other.boosts[stat] = old;
        }
        break;
      }
      case '-transform': {
        const target = this.find(second);
        if (pokemon && target) {
          // Transform copies species, types, stats other than HP, stat stages, ability and every move; it keeps its own
          // HP, level and item. Imposter copies whatever it faces on entry, which is usually our Pokémon, whose exact
          // stats and moves we know; those make the copy fully known. Ditto's Choice Scarf then locks it into the first
          // move it uses in the new form, so the last move before transforming is forgotten.
          pokemon.transformedInto = target.transformedInto ?? target.species;
          pokemon.boosts = { ...target.boosts };
          pokemon.copiedMoves = [...(target.knownMoves.length ? target.knownMoves : target.revealedMoves)];
          pokemon.ability = target.ability; pokemon.abilitySuppressed = false;
          pokemon.stats = copiedStats(target);
          pokemon.lastMoveUsed = null; pokemon.sameMoveStreak = 0;
          if (a.some(x => x === '[from] ability: Imposter') && !pokemon.baseAbility) pokemon.baseAbility = 'Imposter';
        } else this.uncertain('Unresolved Transform target');
        break;
      }
      case '-activate': {
        const effect = effectName(second);
        // Binding uses -activate, not -start. Keep one canonical key for strategy and remove it on -end.
        if (pokemon && ['Bind', 'Clamp', 'Fire Spin', 'Infestation', 'Magma Storm', 'Sand Tomb', 'Snap Trap', 'Thunder Cage', 'Whirlpool', 'Wrap'].includes(effect)) {
          pokemon.volatiles.partiallytrapped = { sinceTurn: this.state.turn, data: effect };
        }
        if (pokemon && effect === 'trapped') pokemon.volatiles.trapped = { sinceTurn: this.state.turn, data: null };
        break;
      }
      case '-start':
        if (pokemon && second) {
          const effect = effectName(second);
          // Each countdown message replaces the previous count, rather than accumulating stale counts.
          if (/^perish[0-3]$/.test(effect)) for (const key of Object.keys(pokemon.volatiles)) {
            if (/^perish[0-3]$/.test(key)) delete pokemon.volatiles[key];
          }
          pokemon.volatiles[effect] = { sinceTurn: this.state.turn, data: third || null };
          if (effect === 'confusion' && a.includes('[fatigue]')) delete pokemon.rampage;
          // Future Sight is announced on its user and lands on the other side's slot, whoever is there by then; it
          // belongs to the side, so it outlasts the user switching out.
          if (effectId(effect) === 'futuresight') {
            const own = this.state.sides[pokemon.id.split('-')[0] as 'p1' | 'p2'];
            if (own) own.slotConditions.futureSight = { setOnTurn: this.state.turn, fromId: pokemon.id };
          }
        }
        break;
      // Glaive Rush, Destiny Bond and Grudge last until their user next tries to move. Glaive Rush matters most: until
      // then its user takes double damage, and Baxcalibur, locked into it, stayed in on a 66-78% Ice Beam that did twice that.
      // Hyper Beam and its kind: the holder's next turn is lost to recharging, shown then as `cant … recharge`.
      case '-mustrecharge':
        if (pokemon) pokemon.volatiles.mustrecharge = { sinceTurn: this.state.turn, data: singleMove };
        break;
      case '-singlemove':
        if (pokemon && second) pokemon.volatiles[effectName(second)] = { sinceTurn: this.state.turn, data: singleMove };
        break;
      // The first turn of a two-turn move (Phantom Force, Solar Beam, Dig): next turn it strikes, and meanwhile the flier
      // or digger is out of reach. It lasts until the holder next moves.
      case '-prepare':
        if (pokemon && second) pokemon.volatiles[moveId(second)] = { sinceTurn: this.state.turn, data: singleMove };
        break;
      // A charge skipped the same turn (Power Herb, Solar Beam in sun, Electro Shot in rain) shows as -anim straight
      // after -prepare: the move has fired, so nothing is charging. Eternatus's Power Herb Meteor Beam was left charging,
      // and the engine made it charge a second one into Psychic Noise, trapped at 32% (2687788784).
      case '-anim':
        if (pokemon && second && pokemon.volatiles[moveId(second)]?.sinceTurn === this.state.turn) delete pokemon.volatiles[moveId(second)];
        break;
      // Illusion again: our attack had no effect where the disguise's typing would have taken it and a Zoroark's does not.
      // An immunity from an ability says so ([from] ability), and a Terastallised or transformed target is left alone.
      case '-immune':
        if (pokemon && id !== this.state.mySide && this.lastMove?.side === this.state.mySide && !a.some(v => v.startsWith('[from]')) &&
            !pokemon.illusion && !pokemon.terastallized && !pokemon.transformedInto && !pokemon.volatiles.typechange) {
          const move = dex.moves.get(this.lastMove.move);
          const form = move.exists && move.category !== 'Status' ? formFromImmunity([...dex.species.get(pokemon.species).types], move.type) : null;
          if (form) this.unmask(pokemon, form, `${move.name} had no effect on it`);
        }
        break;
      case '-end':
        if (pokemon) {
          delete pokemon.volatiles[effectName(second)];
          // The strike is announced on its target; the Future Sight belonged to the other side.
          if (effectId(effectName(second)) === 'futuresight') delete this.state.sides[pokemon.id.startsWith('p1') ? 'p2' : 'p1'].slotConditions.futureSight;
          if (a.includes('[partiallytrapped]') && pokemon.volatiles.partiallytrapped?.data === effectName(second)) delete pokemon.volatiles.partiallytrapped;
        }
        break;
      case '-swapsideconditions': {
        const [p1, p2] = [this.state.sides.p1, this.state.sides.p2];
        [p1.hazards, p2.hazards] = [p2.hazards, p1.hazards];
        // Court Change exchanges these conditions, not arbitrary side conditions.
        for (const name of ['Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web', 'Reflect', 'Light Screen', 'Aurora Veil', 'Tailwind', 'Mist', 'Safeguard']) {
          const one = p1.conditions[name], two = p2.conditions[name];
          delete p1.conditions[name]; delete p2.conditions[name];
          if (two) p1.conditions[name] = two;
          if (one) p2.conditions[name] = one;
        }
        break;
      }
    }
    // Abilities and items can also be revealed as the source of another event.
    const source = a.find(value => value.startsWith('[from] '));
    const owner = a.find(value => value.startsWith('[of] '));
    const target = owner ? this.find(owner.slice(5)) : pokemon;
    // Trace names the Pokémon it copied from in [of], not the one that has Trace: that one is the first argument, and
    // the [of] Pokémon is revealed to have the ability copied. Reading it the usual way once recorded a Thundurus-T,
    // whose Volt Absorb a Gardevoir traced, as having Trace.
    if (message.type === '-ability' && source === '[from] ability: Trace' && pokemon && second) {
      if (target && target !== pokemon) { target.ability = second; rememberNativeAbility(target, second); }
      if (!pokemon.baseAbility) pokemon.baseAbility = 'Trace';
    } else if (target && source?.startsWith('[from] ability: ') && message.type !== '-transform') {
      target.ability = source.slice(16);
      // A triggered native ability is public evidence about the original set. Keep it across a switch;
      // otherwise Harvest (for example) vanishes from the opponent's state just when it matters again.
      // Do not promote an ability acquired through Skill Swap or Trace to the original ability.
      rememberNativeAbility(target, target.ability);
    }
    if (target && source?.startsWith('[from] item: ') && message.type !== '-enditem') target.item = source.slice(13);
    // Delayed recovery is spent once it lands.
    if (source && id) {
      if (/^\[from\] move: Wish/.test(source)) delete this.state.sides[id].slotConditions.wish;
      if (/^\[from\] move: (Healing Wish|Lunar Dance)/.test(source)) delete this.state.sides[id].slotConditions.healingWish;
    }
    this.evidence.after(this.state, message);
    this.substitutes.after(this.state, message);
  }

  private request(raw: string) {
    let request: unknown;
    try { request = JSON.parse(raw); } catch { this.uncertain('Malformed request ignored'); return; }
    if (request === null) { this.state.requestKind = 'none'; return; }
    if (!isRecord(request)) { this.uncertain('Malformed request ignored'); return; }
    this.state.requestKind = request.wait === true ? 'wait' : request.teamPreview === true ? 'preview' :
      Array.isArray(request.forceSwitch) && request.forceSwitch.some(x => x === true) ? 'switch' : Array.isArray(request.active) ? 'move' : 'none';
    if (!isRecord(request.side) || !['p1', 'p2'].includes(String(request.side.id)) || !Array.isArray(request.side.pokemon)) return;
    const id = request.side.id as 'p1' | 'p2';
    const rows = request.side.pokemon;
    if (rows.length < 1 || rows.length > 6 || rows.some(row => !isRecord(row) || typeof row.ident !== 'string' ||
        sideId(row.ident) !== id || typeof row.details !== 'string' || !row.details ||
        typeof row.condition !== 'string' || !parseCondition(row.condition) || typeof row.active !== 'boolean')) {
      this.uncertain('Malformed request team ignored'); return;
    }
    const side = this.state.sides[id];
    // Requests provide ordered roster slots, preserving duplicate species and nicknames.
    const available = [...side.team];
    const team = (rows as Record<string, unknown>[]).map((row, index) => {
      const ident = row.ident as string, details = row.details as string;
      let found = available.findIndex(p => p.ident === canonicalIdent(ident) && identityDetails(p.details) === identityDetails(details));
      if (found < 0 && row.active === true) found = available.findIndex(p => p.id === side.activeId);
      const p = found >= 0 ? available.splice(found, 1)[0]! : this.makePokemon(ident, details);
      p.slot = index + 1; p.ident = canonicalIdent(ident); p.details = details; p.species = speciesFromDetails(details);
      this.condition(p, row.condition as string, true);
      if (Array.isArray(row.moves) && row.moves.every(m => typeof m === 'string')) p.knownMoves = [...row.moves];
      // Transform copies every move the target has, and our request lists them all, where '-transform' could copy only
      // the ones the target had shown. Our Ditto as Latias had Psyshock the search never saw, so each turn it weighed
      // Recover and switches and never the attack Jev kept asking for (2687703481). The target's set is then known too.
      if (p.transformedInto && Array.isArray(row.moves) && row.moves.every(m => typeof m === 'string') && row.moves.length) {
        const names = (row.moves as string[]).map(m => dex.moves.get(m).exists ? dex.moves.get(m).name : m);
        p.copiedMoves = names;
        const foe = this.state.sides[id === 'p1' ? 'p2' : 'p1'];
        const target = foe.team.find(x => !x.transformedInto && x.species === p.transformedInto);
        if (target) for (const name of names) if (!target.revealedMoves.includes(name)) target.revealedMoves.push(name);
      }
      if (row.active === true && Array.isArray(request.active)) {
        const slot = (request.active as unknown[])[0];
        if (isRecord(slot) && Array.isArray(slot.moves)) for (const m of slot.moves) {
          if (isRecord(m) && typeof m.id === 'string' && typeof m.pp === 'number' && typeof m.maxpp === 'number' &&
              Number.isInteger(m.pp) && Number.isInteger(m.maxpp) && m.pp >= 0 && m.maxpp > 0) {
            p.movePP[m.id] = { remaining: m.pp, max: m.maxpp };
          }
        }
      }
      // A transformed Pokémon's request carries its own stats, not the copied ones: Ditto as Latias was modelled with
      // Ditto's Speed, slower than the Latias its Choice Scarf outran, and Ditto's weak attacks.
      if (isRecord(row.stats) && !p.transformedInto) p.stats = Object.fromEntries(Object.entries(row.stats).filter(([key, value]) => stats.has(key) && typeof value === 'number' && Number.isFinite(value) && value > 0)) as Record<string, number>;
      if (typeof row.baseAbility === 'string') p.baseAbility = row.baseAbility;
      if (typeof row.ability === 'string') p.ability = row.ability;
      else if (typeof row.baseAbility === 'string' && p.ability === null) p.ability = row.baseAbility;
      if (typeof row.item === 'string') p.item = row.item;
      if (typeof row.teraType === 'string') p.teraType = row.teraType;
      if (typeof row.terastallized === 'string' && row.terastallized) { p.terastallized = true; p.teraType = row.terastallized; }
      return p;
    });
    const activeIndex = rows.findIndex(row => isRecord(row) && row.active === true);
    side.team = team; side.teamSize = team.length; side.identityUncertain = false; side.activeId = team[activeIndex]?.id ?? null;
    this.state.mySide = id;
  }
}
