import type { DecisionInput } from '../decisions/DecisionProvider.js';
import { dex, id } from '../pokemon/data.js';
import { damageRange } from './damage.js';
import { inferOpponent } from './inference.js';
import { buildPokemon, dedupeCandidates, hpInterval, scenario, supportedMove } from './calcCore.js';
import { boostedStat, chargesThisTurn, fieldFactors, healPercentNow, hitChancePercent, pokemonTypes, selfStageChanges, typeEffectiveness } from '../pokemon/mechanics.js';
import { effectiveSpeed, movePriority, speedSummary, turnOrder } from './speed.js';
import { incomingThreats, outgoingBest } from './threat.js';
import { hasSubstitute } from './substituteState.js';
import { canUseRecoveryNow, choiceLock, matchupProgress, opponentPP, protectOutlook, substitutePlan } from './stalling.js';
import { sleepTalkMoves, statusRisk, wakeChance } from './risk.js';
import { afterTerastallizing } from './forme.js';
import { defensiveTera } from './projection.js';
import { breaksMoulds } from './abilities.js';
import { afterEntry } from './entry.js';
import { switchRelief } from './switchRelief.js';
import { residuals } from './residual.js';
import { plausibleMoves } from './setPriors.js';
import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { remainingPokemon } from '../battle/BattleState.js';
import type { Candidate } from './setTypes.js';
import { protectMoves } from '../battle/BattleTracker.js';
import { giftsFor } from './statusGifts.js';
import { restPlan } from './rest.js';
import { sampled } from './sampled.js';
import { certainFailure, effectViability, hitBeforeHeal, repeatedSelfEffectFailure } from './viability.js';

/**
 * A move that certainly fails is never the fallback. Scream Tail faced a Gastrodon that out-healed Play Rough;
 * outhealed rightly skipped the attack, and the next action in the blend was Thunder Wave, which the search rated
 * like anything else in a lost position and which cannot touch a Ground type. It was used seven turns running while
 * Ice Beam wore Scream Tail down. The payload said so; only a guard keeps the fallback honest.
 *
 * Narrow: only failures established from facts (type, status, field, our HP and boosts, a known ability or item),
 * never a hidden set's possibility. Tera variants are left to the ranking, since Terastallizing still happens.
 */
export function certainlyFails(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const ours = s.sides[s.mySide], theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || me.fainted) return result;
  // Asleep with no Sleep Talk or Snore, every move fails alike, and using one still counts a sleep turn down where a
  // switch keeps it; so sleep alone skips nothing, and staying or switching is left to the ranking. Skipping all four
  // left Misdreavus only a switch to Greninja, which Pachirisu's Thunderbolt knocked out; the search had staying at
  // 0.563 against 0.370 (2687779585).
  const sleepTalks = input.legalActions.some(a => a.kind === 'move' && ['sleeptalk', 'snore'].includes(id(a.label.split(' + Tera')[0]!)));
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || action.command.endsWith(' terastallize')) continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label);
    if (!move.exists) continue;
    const reasons = (effectViability(s, move.name, me, s.mySide, foe && !foe.fainted ? foe : undefined)?.certain ?? [])
      .filter(r => !/helps the target|only removes the berry/.test(r))
      .filter(r => sleepTalks || !/only Sleep Talk or Snore can act/.test(r));
    if (reasons.length) result.set(action.id, { by: 'certain-failure', reason: `${move.name}: ${reasons[0]}` });
  }
  return result;
}

/** Do not spend another turn on an already active self effect. A Tera variant can still change
 * typing before the failed move, so leave that distinct defensive choice to the ranking. */
export function repeatedSelfEffect(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const ours = s.sides[s.mySide], me = ours.team.find(p => p.id === ours.activeId);
  if (!me || me.fainted) return result;
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || action.command.endsWith(' terastallize')) continue;
    const reason = repeatedSelfEffectFailure(me, action.label);
    if (reason) result.set(action.id, { by: 'certain-failure', reason });
  }
  return result;
}

/** Deliberately limited to simple attacks with declarative secondary effects and no resource-changing callbacks. */
function simple(moveName: string, foeStatus: string | null, foeTypes: string[]) {
  const m = dex.moves.get(moveName);
  const allowed = new Set(['flamethrower','hydrosteam','surf','watergun','scald','thunderbolt','discharge','thundershock',
    'icebeam','powdersnow','dragonpulse','dragonbreath','psychic','psybeam','airslash','aircutter','ember','swift','tackle','scratch','pound','strength']);
  if (!allowed.has(m.id) || m.category === 'Status' || m.self || m.selfSwitch || m.recoil || m.drain || m.forceSwitch || m.multihit) return null;
  const secondary = m.secondaries?.filter(e => {
    if (e.status && (foeStatus || (e.status === 'brn' && foeTypes.includes('Fire')) || (e.status === 'par' && foeTypes.includes('Electric')))) return false;
    return true;
  }) ?? [];
  // Effects on a living target are not interchangeable: e.g. Flamethrower's burn is a real option.
  return { move: m, effects: JSON.stringify([secondary, m.flags.contact ?? 0, m.flags.sound ?? 0, m.flags.bypasssub ?? 0, m.critRatio ?? 1]) };
}
export function dominatedMoves(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move') return result;
  const own = s.sides[s.mySide], other = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = own.team.find(p => p.id === own.activeId), foe = other.team.find(p => p.id === other.activeId);
  if (!me || !foe || Object.keys(foe.volatiles).some(k => id(k) === 'substitute')) return result;
  const options = input.legalActions.filter(a => a.kind === 'move').map(action => {
    const slot = Number(action.command.split(' ')[1]) - 1;
    const moveName = input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!;
    const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    const info = simple(moveName, foe.status, pokemonTypes(foe));
    if (!info) return null;
    const pp = input.request?.active?.[0]?.moves[slot]?.pp ?? me.movePP?.[info.move.id]?.remaining;
    return { action, info, tera, pp, range: damageRange(s, moveName, tera) };
  }).filter((v): v is NonNullable<typeof v> => !!v && !!v.range);
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  for (const a of options) for (const b of options) {
    if (a === b || result.has(a.action.id) || a.tera !== b.tera || a.info.effects !== b.info.effects ||
      a.info.move.category !== b.info.move.category || a.info.move.priority !== b.info.move.priority ||
      a.info.move.accuracy !== b.info.move.accuracy ||
      !['normal','allAdjacent','allAdjacentFoes'].includes(a.info.move.target) || !['normal','allAdjacent','allAdjacentFoes'].includes(b.info.move.target) ||
      a.pp === undefined || b.pp === undefined || b.pp < a.pp || b.pp <= 1) continue;
    if ((a.range!.coveredProbabilityMass ?? 1) < 0.999 || (b.range!.coveredProbabilityMass ?? 1) < 0.999 ||
      b.range!.hp[0] < a.range!.hp[0] || b.range!.hp[1] <= a.range!.hp[1]) continue;
    // Envelopes alone can conceal candidate-specific reversals. Check every modeled set, fail closed.
    if (!sets.length || !sets.every(c => {
      const ar = scenario(s, me, foe, s.mySide!, a.info.move.name, undefined, c, a.tera);
      const br = scenario(s, me, foe, s.mySide!, b.info.move.name, undefined, c, b.tera);
      return ar && br && br.min >= ar.max;
    })) continue;
    result.set(a.action.id, { by: b.action.id,
      reason: `${b.info.move.name} has no worse damage/KO in every modeled set and strictly higher maximum damage, with equal priority, accuracy, relevant effects and Tera cost, and at least as much PP. Conditional on the current defender staying in.` });
  }
  return result;
}

/**
 * The other way a move can be strictly worse: when two moves both knock the target out, the extra damage on
 * the slower one buys nothing, while the faster one wins the exchange without being hit at all. Priority is
 * decisive there, which is exactly the case the damage comparison above has to exclude.
 *
 * Kept narrow. Both knockouts must hold across every modelled set, the faster move may not be less accurate,
 * and anything that makes the slower move worth its turn on its own terms — draining back, pivoting out — is
 * left alone. A Substitute on the target is excluded, since a knockout then means the substitute, not the
 * Pokémon.
 */
export function lethalPriority(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide) return result;
  const ours = s.sides[s.mySide], theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId);
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || foe.fainted || hasSubstitute(foe)) return result;
  const options = input.legalActions.map(action => {
    if (action.kind !== 'move') return null;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const requested = input.request?.active?.[0]?.moves[slot];
    const move = dex.moves.get(requested?.id ?? action.label.split(' + Tera')[0]!);
    if (!move.exists || move.category === 'Status' || move.drain || move.selfSwitch || move.forceSwitch) return null;
    const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    const range = damageRange(s, move.name, tera);
    if (!range || range.conditionalKO !== 'all-sampled-rolls' || (range.coveredProbabilityMass ?? 1) < 0.999) return null;
    const order = turnOrder(s, me, move.name)?.order;
    if (!order || order === 'uncertain') return null;
    // Sucker Punch only reaches that priority against an attack, so it can never stand in for a move that
    // always connects. It is still a legal choice; it just cannot be the reason another one is skipped.
    return { action, move, tera, order, conditional: move.id === 'suckerpunch',
      accuracy: move.accuracy === true ? 100 : move.accuracy };
  }).filter((v): v is NonNullable<typeof v> => !!v);
  for (const slower of options) for (const faster of options) {
    if (slower === faster || result.has(slower.action.id)) continue;
    if (slower.order !== 'theirs-first' || faster.order !== 'ours-first') continue;
    if (faster.conditional) continue;
    // Spending Tera to gain the move order is a real cost, so only compare like for like.
    if (!!slower.tera !== !!faster.tera) continue;
    if (faster.accuracy < slower.accuracy) continue;
    result.set(slower.action.id, { by: faster.action.id,
      reason: `${faster.move.name} also knocks the target out in every modelled set and moves first, so ${slower.move.name} only lets ${foe.species} act first for damage that is already surplus.` });
  }
  return result;
}

/**
 * Protect stops being a tactic and becomes a wasted turn once it is repeated: its success chance falls to a
 * third with each consecutive use, and if it buys no ground even when it works, a successful one is worth
 * nothing and a failed one is worth less. Garganacl spent five turns protecting into a Substitute it could
 * have broken, which is what this recognises directly rather than describing again.
 *
 * Narrow on purpose. It leaves the first Protect alone for scouting. Later attempts are preserved for
 * identified payoffs such as Wish, recovery, residual damage and timers. Otherwise it needs the end-of-turn swing to be known and non-positive, so protecting while poison, Salt Cure
 * or Leftovers work in our favour is untouched; and it leaves the move alone when it is the only one offered.
 */
export function futileProtect(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide) return result;
  const ours = s.sides[s.mySide], theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId);
  if (!me || input.request?.forceSwitch?.[0]) return result;
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  const blocked = input.legalActions.filter(action => {
    if (action.kind !== 'move') return false;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const requested = input.request?.active?.[0]?.moves[slot];
    const name = dex.moves.get(requested?.id ?? action.label.split(' + Tera')[0]!).name;
    const outlook = protectOutlook(s, name, s.mySide!, me, foe);
    // A third Protect in a row succeeds one time in nine, which no payoff redeems: Morpeko spent three turns on it for
    // Leftovers and fell on the one that failed.
    return !!outlook && ((outlook.consecutiveProtectsAlready >= 1 && outlook.noIdentifiedPayoff) || outlook.consecutiveProtectsAlready >= 2);
  });
  // Skipping every option would leave nothing to choose, so a lone protecting move is allowed through.
  if (!blocked.length || blocked.length >= input.legalActions.length) return result;
  const already = me.consecutiveProtects ?? 0;
  for (const action of blocked) {
    result.set(action.id, { by: 'repetition',
      reason: already >= 2
        ? `${me.species} has protected ${already} turns in a row, so this succeeds about ${Math.round(100 / 3 ** already)}% of the time`
        : `${me.species} has protected ${already} turns in a row, so this succeeds about ${Math.round(100 / 3 ** already)}% of the time and gains no ground at end of turn even when it does` });
  }
  return result;
}

/** Somewhere worth going: an offered switch whose target every sampled set does not knock out as it arrives. */
/**
 * A switch that answers the Pokémon in front of us: it lives through its entry and then either lives through a second hit
 * from the opponent's likely attacks (revealed, or in half its sets) or moves first. Surviving the entry alone is not
 * enough. Iron Jugulis, asleep, was switched to an Arcanine that a +2 Drifblim's Shadow Ball took to 39% and knocked
 * out next turn before it moved; the search had staying at 0.197 against 0.170 (2687862037).
 */
function answeringSwitch(input: DecisionInput) {
  const s = input.state;
  if (!s.mySide) return false;
  const side = s.mySide, ours = s.sides[side];
  return input.legalActions.some(a => {
    if (a.kind !== 'switch' || a.uncertain) return false;
    const target = ours.team.find(p => p.slot === Number(a.command.split(' ')[1]));
    if (!target || target.fainted) return false;
    let threat; try { threat = incomingThreats(s, target, side, Infinity); } catch { return false; }
    const likely = (threat?.damagingMoves ?? []).filter(m => m.revealed || (m.priorProbability ?? 0) >= 0.5);
    const worst = Math.max(0, ...likely.map(m => m.percentOfMaxHP[1]));
    const arriving = afterEntry(s, target, side).hpPercent ?? target.hpPercent ?? 100;
    if (worst >= arriving) return false;
    let first = false; try { first = speedSummary(s, target).relation === 'faster-than-all-samples'; } catch { first = false; }
    return 2 * worst < arriving || first;
  });
}

function escapable(input: DecisionInput) {
  const s = input.state;
  if (!s.mySide) return false;
  const ours = s.sides[s.mySide];
  return input.legalActions.some(a => {
    if (a.kind !== 'switch' || a.uncertain) return false;
    const target = ours.team.find(p => p.slot === Number(a.command.split(' ')[1]));
    return !!target && incomingThreats(s, target, s.mySide!, 1)?.conditionalKO !== 'all-sampled-rolls';
  });
}

/**
 * Encored into a move that does nothing, switching is the only way out and is nearly always right: every turn
 * spent is a free turn for the opponent, and Encore runs for three of them. Garganacl spent four turns
 * Protecting into a Comfey that was simply waiting.
 *
 * Narrow, because being Encored into a real attack is survivable and sometimes fine. It needs the locked move
 * to deal no damage at all, and it needs somewhere to go: a replacement that is not knocked out on entry. If
 * every switch would die on the way in, staying locked is the lesser loss and nothing is skipped.
 */
export function encoredIntoNothing(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || input.request?.forceSwitch?.[0]) return result;
  const ours = s.sides[s.mySide];
  const me = ours.team.find(p => p.id === ours.activeId);
  if (!me || !Object.keys(me.volatiles).some(k => id(k) === 'encore')) return result;
  const moves = input.legalActions.filter(a => a.kind === 'move');
  if (!moves.length || !escapable(input)) return result;
  for (const action of moves) {
    const slot = Number(action.command.split(' ')[1]) - 1;
    const requested = input.request?.active?.[0]?.moves[slot];
    const move = dex.moves.get(requested?.id ?? action.label.split(' + Tera')[0]!);
    if (!move.exists) continue;
    const range = move.category === 'Status' ? null : damageRange(s, move.name);
    const harmless = move.category === 'Status' || (range !== null && range.percentOfMaxHP[1] === 0);
    if (!harmless) continue;
    result.set(action.id, { by: 'encore',
      reason: `${me.species} is Encored into ${move.name}, which deals no damage, and Encore replaces every other move until it ends; switching is the only way out` });
  }
  return result;
}

/**
 * Locked into one attack that the target is immune to, staying in hands the opponent a free turn and switching is
 * the only way out; it also releases a Choice lock. Terrakion, Choice Banded into Close Combat, used it into a
 * Sinistcha that its Ghost typing makes immune, although the payload said the target takes nothing from it.
 *
 * Narrow in the same way as the Encore guard: exactly one move is on offer, whatever the lock, and it deals
 * nothing to every sampled set of the current target — a Substitute being hit is not nothing — and some switch
 * is not knocked out on the way in. A damaging move that hits nothing has no side effect left to be worth it.
 */
const choiceItems = ['choiceband', 'choicespecs', 'choicescarf'];
export function lockedIntoImmunity(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || input.request?.forceSwitch?.[0]) return result;
  const ours = s.sides[s.mySide], theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || foe.fainted) return result;
  const moves = input.legalActions.filter(a => a.kind === 'move');
  const names = new Set(moves.map(a => a.label.split(' + Tera')[0]));
  if (names.size !== 1) return result;
  const move = dex.moves.get([...names][0]!);
  if (!move.exists || move.category === 'Status' || !escapable(input)) return result;
  const lock = choiceItems.includes(id(me.item)) ? `its ${dex.items.get(me.item!).name}` : 'what is left to it';
  for (const action of moves) {
    const tera = / \+ Tera (\w+)$/.exec(action.label)?.[1];
    const range = damageRange(s, move.name, tera);
    if (!range || range.percentOfMaxHP[1] !== 0 || (range.takesNothingFromIt?.probability ?? 0) < 1) continue;
    result.set(action.id, { by: 'lock',
      reason: `${me.species} is locked into ${move.name} by ${lock}, and ${foe.species} takes nothing from it, so staying in only gives them a free turn; switching is the way out` });
  }
  return result;
}

/**
 * Terastallising only to add damage to a hit that already knocks the target out spends a once-a-battle resource on
 * surplus; so does Terastallising into a type the incoming attack hits harder without buying a knockout. Medicham's Close Combat was already a certain knockout on the Rillaboom in front of it, and Tera Fighting
 * changed nothing about the damage it took; Jev chose the Tera version anyway, although the instructions forbid it.
 *
 * Narrow: the plain move is offered and knocks out every sampled set of the current target, Terastallising does not
 * lower the damage we take this turn by any measurable amount nor stop any single modeled attack from knocking us
 * out, and it changes nothing else. A lower worst hit does not count as protection when the new type lets another
 * modeled attack knock us out: Tera Steel Latias resisted Explosion and died to the Thunderbolt it had resisted before — Ogerpon's Embody Aspect
 * and Terapagos's Stellar form are exempt, since they change stats and turn order. The Tera version is skipped for
 * the next-ranked action, which is usually the same move without it.
 */
export function redundantTera(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || input.request?.forceSwitch?.[0]) return result;
  const ours = s.sides[s.mySide], theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  const tera = input.request?.active?.[0]?.canTerastallize;
  if (!me || !foe || foe.fainted || !tera || afterTerastallizing(me, tera) !== me) return result;
  // A turn they cannot act, Tera protects nothing, and it happens before moves next turn just as well. Malamar went
  // Tera Steel with Superpower while Slaking loafed on Truant; the Fighting hit gained nothing, the Steel typing blocked
  // nothing that turn, and Slaking came back with Tera Ground Earthquake into the weakness Malamar had just taken.
  // Their switch-in does not attack on the turn it arrives either. Only a Tera that changes our own damage is kept.
  if ((statusRisk(foe, s.turn)?.chanceItActsAtAllPercent ?? 100) === 0) {
    for (const action of input.legalActions) {
      if (action.kind !== 'move' || !action.command.endsWith(' terastallize')) continue;
      const plain = input.legalActions.find(a => a.command === action.command.replace(/ terastallize$/, ''));
      const name = action.label.split(' + Tera')[0]!;
      if (!plain) continue;
      const before = dex.moves.get(name).category === 'Status' ? null : damageRange(s, name)?.percentOfMaxHP;
      const after = before ? damageRange(s, name, tera)?.percentOfMaxHP : null;
      if (before && after && (after[0] !== before[0] || after[1] !== before[1])) continue;
      result.set(action.id, { by: 'tera', reason: `${foe.species} cannot act this turn, so Tera ${tera} protects nothing yet and adds nothing to ${name}; it can be taken next turn, before any move, with more known` });
    }
    return result;
  }
  const defence = defensiveTera(s, me, s.mySide, tera);
  // Tera that takes a knockout away from any modeled attack is buying survival, whatever else it does.
  if (defence?.stopsItFromKnockingUsOut || defence?.stopsTheseFromKnockingUsOut) return result;
  // A lower worst hit is protection only while it does not hand another attack a knockout.
  const letsKO = defence?.letsTheseKnockUsOut?.join(' and ');
  if (defence && !letsKO && defence.worstIncomingPercentBecomes < defence.wasBefore) return result;
  // A likely hit that knocks us out with or without Tera means the hit we land first is the only one we get. Then Tera's
  // extra damage is real progress for whoever comes next, and handing another attack a knockout costs nothing. Flamigo
  // at 48% faced a last Glastrier whose Icicle Crash killed it either way; Tera Fighting Close Combat left 8-22% to
  // finish instead of 31-42%, the search put 0.98 on it, and the guard skipped it three turns running for "lets High
  // Horsepower knock us out" and "not a hit fewer", a second hit Flamigo would never land (2687217753).
  const doomed = (incomingThreats(s, me, s.mySide, Infinity)?.damagingMoves ?? [])
    .some(m => (m.revealed || (m.priorProbability ?? 0) >= 0.5) && m.conditionalKO === 'all-sampled-rolls');
  const lastOpponent = remainingPokemon(theirs) === 1;
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || !action.command.endsWith(' terastallize')) continue;
    const plain = input.legalActions.find(a => a.command === action.command.replace(/ terastallize$/, ''));
    const name = action.label.split(' + Tera')[0]!;
    if (!plain || dex.moves.get(name).category === 'Status') continue;
    const onlyHit = doomed && turnOrder(s, afterTerastallizing(me, tera), name)?.order === 'ours-first';
    if (damageRange(s, name)?.conditionalKO === 'all-sampled-rolls') {
      result.set(action.id, { by: 'tera', reason: letsKO
        ? `${name} already knocks out ${foe.species} at every sampled roll without Terastallising, and Tera ${tera} lets ${letsKO} knock us out first, so it costs the knockout it was meant to add to`
        : `${name} already knocks out ${foe.species} at every sampled roll without Terastallising, and Tera ${tera} lowers nothing we take this turn, so it spends Tera for surplus damage` });
      continue;
    }
    // The other way Tera loses: its knockout odds are no better than the plain move's, and its type is one the attack
    // coming at us hits harder. Carbink took Tera Fighting for 27 points of Body Press, no knockout either way, and
    // doubled Hoopa-Unbound's Psychic from 49.6% to 99.2%. A Tera that turns no knockout into a possible one is
    // buying something real, so that trade is left to judgement.
    const rank = (ko: string | undefined) => (ko === 'all-sampled-rolls' ? 2 : ko === 'some-sampled-rolls' ? 1 : 0);
    if (onlyHit) continue;
    if ((defence?.makesUsWeakerToTheirAttack || letsKO) && rank(damageRange(s, name, tera)?.conditionalKO) <= rank(damageRange(s, name)?.conditionalKO)) {
      result.set(action.id, { by: 'tera', reason: letsKO
        ? `Tera ${tera} improves no knockout odds with ${name} and lets ${letsKO} knock us out, while spending Tera for the rest of the battle`
        : `Tera ${tera} improves no knockout odds with ${name} and raises the worst hit on us from ${defence!.wasBefore}% to ${defence!.worstIncomingPercentBecomes}%, while spending Tera for the rest of the battle` });
      continue;
    }
    // Chip: Tera spent for damage that is neither a knockout nor a hit fewer to one, with nothing gained in defence and
    // a team still left to spend it on. Early chip Teras came in games we went 5-15 in: Perrserker's Close Combat from
    // 51.7-61.1% to 77.5-91.5% of a Pokémon that survived either way, and Tera was gone for the rest of the battle.
    const plainRange = damageRange(s, name), teraRange = damageRange(s, name, tera);
    const hits = (range: typeof plainRange) => (range && range.percentOfMaxHP[0] > 0 && foe.hpPercent ? Math.ceil(foe.hpPercent / range.percentOfMaxHP[0]) : Infinity);
    // Knockout odds over the rolls, not the category: at 80% a Snorlax is knocked out by 22% of Wave Crash's rolls and
    // 92% of Tera Water's, both "some rolls".
    const koChance = (range: typeof plainRange) => {
      if (!range || foe.hpPercent === null) return 0;
      const [lo, hi] = range.percentOfMaxHP;
      return foe.hpPercent <= lo ? 1 : foe.hpPercent > hi ? 0 : (hi - foe.hpPercent) / Math.max(hi - lo, 1e-9);
    };
    const alive = ours.team.filter(p => !p.fainted).length;
    // Against their last Pokémon there is no later matchup to keep Tera for.
    if (alive >= 4 && !lastOpponent && plainRange && teraRange && koChance(teraRange) < koChance(plainRange) + 0.1 && hits(teraRange) >= hits(plainRange)) {
      result.set(action.id, { by: 'tera', reason: `Tera ${tera} buys ${name} no knockout and not a hit fewer to one (${plainRange.percentOfMaxHP.join('-')}% becomes ${teraRange.percentOfMaxHP.join('-')}%) and changes nothing we take, with ${alive} Pokémon still able to use it` });
    }
  }
  return result;
}

/**
 * Choice-locked into an attack that has not dented them for three turns while we lose HP, staying in only repeats the
 * exchange we are losing. Clawitzer, locked into Aura Sphere by Choice Specs, used it seven turns running while a Calm
 * Mind Suicune boosted past it and Rested back to 90%; the payload had said they were not losing ground since turn 16.
 *
 * Narrow: a Choice item holds the lock, the pairing has lasted three turns with them at most 5% down net and us 10% or
 * more down, and some switch survives its entry. Switching also releases the lock.
 */
export function lockedAndLosing(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || input.request?.forceSwitch?.[0]) return result;
  const ours = s.sides[s.mySide], theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || foe.fainted || !choiceItems.includes(id(me.item))) return result;
  const moves = input.legalActions.filter(a => a.kind === 'move');
  const names = new Set(moves.map(a => a.label.split(' + Tera')[0]));
  const progress = matchupProgress(s, me, foe);
  if (names.size !== 1 || !progress?.theyAreNotLosingGround || !escapable(input)) return result;
  for (const action of moves) {
    result.set(action.id, { by: 'lock', reason: `${me.species} is locked into ${[...names][0]} by its ${dex.items.get(me.item!).name}, and over ${progress.turns} turns ${foe.species} has moved ${progress.theirHPChange}% while we moved ${progress.ourHPChange}%; switching breaks the lock and the exchange` });
  }
  return result;
}

/**
 * The share of damage rolls, weighted over the sampled sets, that knock `defender` out from the HP it has now. Rolls
 * are spread evenly between the extremes, so a partial range is read as the matching fraction of the sixteen.
 */
function knockoutShare(s: BattleState, attacker: PokemonState, defender: PokemonState, attackerSide: SideId, move: string,
  attackerSets: (Candidate | undefined)[], defenderSets: (Candidate | undefined)[], attackerTera?: string, defenderTera?: string) {
  let mass = 0, share = 0;
  for (const a of attackerSets) for (const d of defenderSets) {
    const r = scenario(s, attacker, defender, attackerSide, move, a, d, attackerTera, defenderTera);
    if (!r || r.substitute) return null;
    const hp = hpInterval(defender, r.defenderMaxHP)[1];
    const ko = r.endures ? 0 : r.min >= hp ? 1 : r.max < hp ? 0 : (r.max - hp + 1) / (r.max - r.min + 1);
    const p = (a?.probability ?? 1) * (d?.probability ?? 1);
    mass += p; share += p * ko;
  }
  return mass > 0 ? share / mass : null;
}

/**
 * A switch that wins the exchange outright: the Pokémon coming in survives their worst sampled hit on the way in, and a
 * second one if it does not move first, then knocks them out at every sampled roll, with a move that cannot miss, even
 * after their end-of-turn healing.
 */
function sureSwitch(input: DecisionInput, foe: PokemonState) {
  const s = input.state, side = s.mySide!, ours = s.sides[side];
  const foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const heal = residuals(s, foe, foeSide)?.perTurnPercentOfMaxHP;
  const healing = Math.max(0, (Array.isArray(heal) ? heal[1] : heal) ?? 0);
  for (const a of input.legalActions) {
    if (a.kind !== 'switch' || a.uncertain) continue;
    const target = ours.team.find(p => p.slot === Number(a.command.split(' ')[1]));
    if (!target || target.fainted) continue;
    const arrived = afterEntry(s, target, side);
    if (arrived.fainted || !arrived.hpPercent) continue;
    const threat = incomingThreats(s, target, side, 8);
    if (!threat || threat.worstCasePercentOfMaxHP === null || 'knockedOutByHazards' in threat) continue;
    const knockout = outgoingBest(s, target, side, 8)?.moves.find(m => m.conditionalKO === 'all-sampled-rolls' &&
      m.percentOfMaxHP[0] >= (foe.hpPercent ?? 100) + healing + 1 && hitChancePercent(m.move, s.field.weather, arrived, foe) >= 100);
    if (!knockout) continue;
    const speed = speedSummary(s, arrived), priority = movePriority(s, arrived, knockout.move);
    const first = speed.relation === (s.field.trickRoom ? 'slower-than-all-samples' : 'faster-than-all-samples') &&
      priority !== null && (speed.opponentPriorityBracket?.[1] ?? Infinity) <= priority;
    const hits = first ? 1 : 2;
    if (threat.worstCasePercentOfMaxHP * hits >= arrived.hpPercent) continue;
    return { action: a, species: target.species, move: knockout.move, worst: threat.worstCasePercentOfMaxHP, hits };
  }
  return null;
}

/**
 * Staking a healthy Pokémon on a roll when a switch wins the same exchange for certain. Jumpluff, at 68%, used a 75%
 * Sleep Powder into a Volcanion whose revealed Flamethrower knocked it out on most rolls, while Wyrdeer could take two of
 * its hits and Earthquake it at every roll; a miss would have lost a Pokémon for nothing the switch did not also buy.
 * Staying in to chip it was worse still: the same knockout back, without the coin flip.
 *
 * Narrow: our active has at least half its HP, their knockout comes from a revealed or near-certain attack on at least
 * half the rolls, they can act — asleep or frozen, the gamble is theirs — and neither side is behind a Substitute. Some
 * switch must win outright as `sureSwitch` describes. A stay-in move is then skipped when it leaves at least a one-in-ten
 * chance of losing our Pokémon this turn: a status move that can miss, counted as if landing stopped them, or an attack
 * that does not remove them before they act, if the Pokémon it risks is worth more than the hits the switch-in takes.
 * Healing, draining, pivoting out, Protect and status that cannot miss are left to judgement, as is any move whose turn
 * order is not settled.
 */
export function needlessGamble(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted || (me.hpPercent ?? 0) < 50 || hasSubstitute(me) || hasSubstitute(foe)) return result;
  if (foe.status === 'slp' || foe.status === 'frz') return result;
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  if (!sets.length) return result;
  const lock = choiceLock(foe);
  const known = lock && lock.probability >= 0.5 ? [lock.lockedInto]
    : plausibleMoves(foe).filter(m => m.revealed || (m.priorProbability ?? 0) >= 0.95).map(m => m.move);
  const lethal = (tera?: string) => {
    let best: { move: string; share: number } | null = null;
    for (const move of known) {
      if (!supportedMove(move)) continue;
      const share = knockoutShare(s, foe, me, foeSide, move, sets, [undefined], undefined, tera);
      if (share !== null && share >= 0.5 && (!best || share > best.share)) best = { move: dex.moves.get(move).name, share };
    }
    return best;
  };
  if (!lethal() && !input.legalActions.some(a => a.command.endsWith(' terastallize'))) return result;
  const sure = sureSwitch(input, foe);
  if (!sure) return result;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    if (!move.exists || move.flags.heal || move.drain || move.stallingMove || move.selfSwitch || move.target === 'self') continue;
    const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    const threat = lethal(tera);
    const order = turnOrder(s, me, move.name)?.order;
    if (!threat || !order || order === 'uncertain') continue;
    const hit = hitChancePercent(move.name, s.field.weather, me, foe) / 100;
    let losing: number, why: string;
    if (move.category === 'Status') {
      if (hit >= 1) continue;
      losing = order === 'theirs-first' ? threat.share : (1 - hit) * threat.share;
      why = order === 'theirs-first' ? `${foe.species} moves first` : `${move.name} misses ${pct(1 - hit)} of the time`;
    } else {
      const removes = order === 'ours-first' ? hit * (knockoutShare(s, me, foe, side, move.name, [undefined], sets, tera) ?? 0) : 0;
      losing = (1 - removes) * threat.share;
      why = order === 'theirs-first' ? `${foe.species} moves first` : removes > 0
        ? `${move.name} fails to knock ${foe.species} out ${pct(1 - removes)} of the time` : `${move.name} does not knock ${foe.species} out`;
    }
    if (losing < 0.1) continue;
    // A switch is not free either: its Pokémon takes a hit coming in, and another if it is slower. An attack is staked
    // only when what it risks, our Pokémon (counted as the engine counts one: 30 for being alive, plus its HP) less the
    // entry hit a switch-in saves by coming in after a faint, outweighs those hits. Cinccino's Tail Slap knocked a
    // Toxtricity out 84% of the time and moved first; the guard sent Ting-Lu into two 35% hits instead (2687507386).
    // A status move that lands still leaves them on the field, so it keeps the stricter test.
    if (move.category !== 'Status') {
      const stake = losing * (30 + (me.hpPercent ?? 100) + (sure.hits - 1) * sure.worst);
      if (stake < sure.hits * sure.worst) continue;
    }
    result.set(action.id, { by: sure.action.id,
      reason: `${why}, and then ${threat.move} knocks ${me.species} out on about ${pct(threat.share)} of rolls: a ${pct(losing)} chance of losing it this turn, while ${sure.species} can come in, take ${sure.hits === 1 ? `a hit of at most ${sure.worst}%` : `two hits of at most ${sure.worst}% each`}, and knock ${foe.species} out with ${sure.move} at every sampled roll` });
  }
  return result;
}

/**
 * Keep the sole durable answer to a revealed bench threat when another teammate can safely finish the current foe.
 * The current attack may knock the foe out, but if it moves second after a severe hit it can leave our only check
 * unusable. This is deliberately narrower than a general switch preference: the replacement must survive two of
 * the current foe's strongest modelled hits and knock it out at its current typing, while each other teammate faces a hit of at least
 * half its maximum HP from the revealed bench threat. A move's presence in a sampled set is not a prediction that
 * the opponent will pick it.
 */
export function preserveSoleDefensiveAnswer(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted || (me.hpPercent ?? 0) < 50 ||
      foe.status === 'slp' || foe.status === 'frz' || hasSubstitute(me) || hasSubstitute(foe) ||
      theirs.identityUncertain) return result;
  const safe = sureSwitch(input, foe);
  if (!safe) return result;
  const replacement = ours.team.find(p => p.slot === Number(safe.action.command.split(' ')[1]));
  if (!replacement || (statusRisk(replacement, s.turn)?.chanceItActsAtAllPercent ?? 100) < 100) return result;
  const threat = incomingThreats(s, me, side, Infinity);
  const severe = threat?.damagingMoves.find(m => (m.revealed || (m.priorProbability ?? 0) >= 0.95) &&
    m.percentOfMaxHP[0] >= Math.max(40, (me.hpPercent ?? 0) - 15));
  if (!severe) return result;

  const bench = theirs.team.filter(p => !p.fainted && p.id !== foe.id);
  const soleCheck = bench.find(p => {
    const facing = { ...s, sides: { ...s.sides, [foeSide]: { ...theirs, activeId: p.id } } };
    const oursHit = incomingThreats(facing, me, side, Infinity)?.worstCasePercentOfMaxHP;
    if (oursHit == null || oursHit > 35 || oursHit * 2 >= (me.hpPercent ?? 0)) return false;
    return ours.team.filter(ally => !ally.fainted && ally.id !== me.id).every(ally => {
      const theirHit = incomingThreats(facing, ally, side, Infinity)?.worstCasePercentOfMaxHP;
      return theirHit != null && theirHit >= Math.max(50, oursHit * 1.5);
    });
  });
  if (!soleCheck) return result;
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || action.command.endsWith(' terastallize')) continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    if (!move.exists || move.category === 'Status' || move.drain || move.selfSwitch || move.flags.heal ||
        move.stallingMove || turnOrder(s, me, move.name)?.order !== 'theirs-first') continue;
    result.set(action.id, { by: safe.action.id,
      reason: `${me.species} is our only teammate that can take two modeled hits from ${soleCheck.species}; ${foe.species} can move first with ${severe.move} and leave it at 15% HP or less before recovery, while ${safe.species} can take two hits and knock ${foe.species} out with ${safe.move} if it keeps its current typing` });
  }
  return result;
}

/**
 * A crash move the opponent can see coming invites the one reply that costs them nothing: Protect, or a switch to a
 * teammate the move cannot touch, and we lose half our max HP for it. Mienshao, Choice Banded into High Jump Kick, used it
 * on a 29% Appletun; Blackft had gone from Appletun to Hoopa before, did so again, and Hoopa's Ghost typing took nothing.
 * Zebstrika's Supercell Slam crashed into an Alomomola whose set certainly carried Protect, then, at 24%, into the
 * Mamoswine that switched in, which cost Zebstrika itself.
 *
 * Narrow. They must see it coming: a Choice item has locked us into it, it knocks their active out at every sampled roll,
 * or it is our hardest-hitting attack into it. They must have the answer: a revealed or near-certain Protect not used the
 * turn before, or a healthy teammate that takes nothing from the move in every sampled set and that they have switched to
 * from this Pokémon, or brought in against ours, before. When the crash would knock us out, less evidence is enough: a
 * second Protect in a row, or any such teammate from an opponent that switches by choice. There must be somewhere else
 * to go: another attack that damages the target, or a switch that survives entry.
 */
export function baitedCrash(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted || hasSubstitute(foe) || theirs.identityUncertain) return result;
  const nameOf = (action: DecisionInput['legalActions'][number]) => {
    const slot = Number(action.command.split(' ')[1]) - 1;
    return dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
  };
  const moves = input.legalActions.filter(a => a.kind === 'move');
  const crashing = moves.filter(a => nameOf(a).hasCrashDamage);
  if (!crashing.length) return result;
  const hardest = new Map(moves.filter(a => !a.command.endsWith(' terastallize') && nameOf(a).category !== 'Status')
    .map(a => [nameOf(a).id, damageRange(s, nameOf(a).name)?.percentOfMaxHP[1] ?? 0]));
  const locked = choiceItems.includes(id(me.item)) && new Set(moves.map(a => nameOf(a).id)).size === 1;
  const elsewhere = [...hardest].some(([m, most]) => !dex.moves.get(m).hasCrashDamage && most > 0);
  if (!elsewhere && !escapable(input)) return result;
  const lethal = (me.hpPercent ?? 100) <= 50;
  const chosen = (theirs.switches ?? []).filter(x => !!x.from && !x.afterFaint && !x.dragged && x.turn >= 1);
  const protect = plausibleMoves(foe).find(m => protectMoves.has(id(m.move)) && (m.revealed || (m.priorProbability ?? 0) >= 0.9));
  const protects = foe.consecutiveProtects ?? 0;
  const usableProtect = protect && (protects === 0 || (lethal && protects === 1)) ? dex.moves.get(protect.move).name : null;
  for (const action of crashing) {
    const move = nameOf(action);
    const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    const doomed = damageRange(s, move.name, tera)?.conditionalKO === 'all-sampled-rolls';
    const obvious = (hardest.get(move.id) ?? 0) > 0 && [...hardest.values()].every(v => v <= hardest.get(move.id)!);
    if (!locked && !doomed && !obvious) continue;
    // Replayed over the logs, a predicted switch to an immune teammate came true only when we were Choice-locked or the
    // crash would have knocked us out; into our hardest hit or a move that knocked them out, the opponent stayed every
    // time: Grimmsnarl set Reflect and Parting Shot through four skipped Supercell Slams, the last a certain knockout.
    // Otherwise half our HP risked on a switch that rarely comes is cheaper than the hit given up.
    const switchCounts = locked || (lethal && !doomed);
    const immune = !switchCounts ? undefined : theirs.team.find(p => {
      if (p.id === foe.id || p.fainted || !((p.hpPercent ?? 0) > 0)) return false;
      const habit = chosen.some(x => x.to === p.species && (x.from === foe.species || x.facing === me.species));
      if (!habit && !(lethal && chosen.length)) return false;
      const sets = dedupeCandidates(inferOpponent(p).candidates);
      return sets.length > 0 && sets.every(c => { const r = scenario(s, me, p, side, move.name, undefined, c, tera); return !!r && r.max === 0; });
    });
    if (!usableProtect && !immune) continue;
    const why = locked ? `${me.species} is locked into ${move.name} by its ${dex.items.get(me.item!).name}, so they know it is coming`
      : doomed ? `${move.name} knocks ${foe.species} out at every sampled roll, so staying in loses it anyway`
      : `${move.name} is our hardest hit on ${foe.species}, so it is the move they expect`;
    const answer = [usableProtect ? `${foe.species}'s ${protect!.revealed ? 'revealed' : 'near-certain'} ${usableProtect}` : null,
      immune ? `a switch to ${immune.species}, which takes nothing from it` : null].filter(Boolean).join(' or ');
    result.set(action.id, { by: 'crash', reason: `${why}; ${answer} costs them nothing and makes ${me.species} crash for half its max HP${lethal ? ', which knocks it out from here' : ''}` });
  }
  return result;
}

/**
 * A status the target's ability turns to its advantage. Guts gives 1.5× Attack under any status and ignores a burn's
 * halving, so Will-O-Wisp into it does the opposite of what the move is for; Marvel Scale, Quick Feet, Toxic Boost and
 * Flare Boost do the same for Defense, Speed and damage, Poison Heal turns poison into healing, and Magic Guard makes
 * poison do nothing at all.
 *
 * Narrow: a move whose only effect is that status — nothing it also lowers, sets or switches — into a target that has
 * no status yet, whose ability is revealed or carried by at least 90% of its sampled sets and is not suppressed.
 * Attacks that merely might inflict the status are left alone; their chance is reported as a cost instead.
 */
export function statusThatHelpsThem(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!foe || foe.fainted || foe.status) return result;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    if (!move.exists || move.category !== 'Status' || !move.status || move.boosts || move.volatileStatus || move.self ||
      move.sideCondition || move.selfSwitch || move.secondaries?.length) continue;
    const gifts = giftsFor(move.status);
    const found = sampled(foe, 'abilities', gifts.map(g => g.ability)).find(a => a.known || (a.probability ?? 0) >= 0.9);
    if (!found) continue;
    const why = gifts.find(g => g.ability === id(found.name))!.why;
    result.set(action.id, { by: 'ability', reason: `${foe.species} ${found.known ? 'has' : 'almost certainly has'} ${found.name}: ${why}, so ${move.name} helps it` });
  }
  return result;
}

/**
 * Healing when a knockout is on offer and the heal cannot keep up. Clefable, at 32% and slower, used Moonlight on a 17%
 * Keldeo that Moonblast knocked out at every roll, while Keldeo's Hydro Pump took 54–64% a hit: more than the 50% the
 * heal restores. Keldeo acts first whichever we pick, so the heal changes nothing about surviving this turn; if we do
 * survive, Moonblast removes Keldeo now, while the heal only returns us to the same choice a turn later, with no more
 * HP, after another attack.
 *
 * Narrow: an offered move that cannot miss knocks their active out at every sampled roll; the heal restores a fixed
 * amount now (Recover, Roost, Moonlight and the like; not Rest, Wish, Strength Sap or Pain Split) and has no more
 * priority than that move; and the smallest roll of their strongest revealed attack on us is at least what the heal
 * would restore from here. Draining attacks deal damage, so they are left alone.
 */
export function healingOverAKnockout(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, theirs = s.sides[side === 'p1' ? 'p2' : 'p1'], ours = s.sides[side];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted || hasSubstitute(foe)) return result;
  const moveOf = (action: DecisionInput['legalActions'][number]) => {
    const slot = Number(action.command.split(' ')[1]) - 1;
    return dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
  };
  const tera = (action: DecisionInput['legalActions'][number]) =>
    action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
  const knockouts = input.legalActions.filter(a => a.kind === 'move').map(a => ({ action: a, move: moveOf(a) }))
    .filter(({ action, move }) => {
      if (!move.exists || move.category === 'Status' || hitChancePercent(move.name, s.field.weather, me, foe) < 100) return false;
      const range = damageRange(s, move.name, tera(action));
      return range?.conditionalKO === 'all-sampled-rolls' && (range.coveredProbabilityMass ?? 1) >= 0.999;
    });
  if (!knockouts.length) return result;
  const fastest = Math.max(...knockouts.map(k => movePriority(s, me, k.move.name) ?? -Infinity));
  const revealed = new Set(foe.revealedMoves.map(m => id(m)));
  const hits = incomingThreats(s, me, side, 8)?.damagingMoves.filter(m => revealed.has(id(m.move))) ?? [];
  const strongest = hits.sort((a, b) => b.percentOfMaxHP[0] - a.percentOfMaxHP[0])[0];
  if (!strongest) return result;
  const room = 100 - (me.hpPercent ?? 100);
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const move = moveOf(action);
    const heal = healPercentNow(move.name, s.field.weather);
    if (heal === undefined || (movePriority(s, me, move.name) ?? Infinity) > fastest) continue;
    // At full HP a heal restores nothing, which the move's own report already says.
    const restores = Math.round(Math.min(heal, room) * 10) / 10;
    if (restores <= 0 || strongest.percentOfMaxHP[0] < restores) continue;
    // A heal that comes with a Tera can be a survival play: Decidueye-Hisui's Roost + Tera Water turned Lunala's
    // Psyshock from a knockout into a hit it lived through, and the knockout offered instead never got to move.
    const withTera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    const saved = withTera ? defensiveTera(s, me, side, withTera) : null;
    if (saved && (saved.stopsItFromKnockingUsOut || saved.stopsTheseFromKnockingUsOut?.includes(strongest.move))) continue;
    const ko = knockouts.find(k => (movePriority(s, me, k.move.name) ?? -Infinity) >= (movePriority(s, me, move.name) ?? 0)) ?? knockouts[0]!;
    result.set(action.id, { by: ko.action.id, reason: `${ko.move.name} knocks ${foe.species} out at every sampled roll, and ${foe.species}'s ${strongest.move} takes at least ${strongest.percentOfMaxHP[0]}% a hit, more than the ${restores}% ${move.name} restores: healing only postpones the same knockout while ${foe.species} attacks again` });
  }
  return result;
}

/** Moves that break a healing stall rather than feed it: a status that chips or cripples, anything that stops the heal. */
const stallBreakers = new Set(['taunt', 'encore', 'healblock', 'psychicnoise', 'torment', 'disable']);
/** Attacks used for what they do besides damage: hazard removal, forcing a switch, clearing boosts. */
const notForTheDamage = new Set(['rapidspin', 'mortalspin', 'circlethrow', 'dragontail', 'clearsmog']);

/**
 * Attacking into a healer that restores more than every hit takes. Gurdurr traded Knock Off and Drain Punch, 32% at
 * best, with an Illumise that Roosted back half its HP every other turn, for twelve turns, and fell from full to 13%;
 * Rhyperior's resisted Stone Edge watched Skarmory Roost from 26% to 87%. When one heal undoes more than our best hit,
 * attacking only spends our PP and our HP.
 *
 * Narrow: they have used a healing move at least twice against the Pokémon we have out, this battle, whether or not
 * either side switched in between, and are not asleep or frozen now; the fixed amount it restores is
 * more than the most our best attack does to them, none of our attacks is a certain knockout, and either some switch
 * survives its entry or we have a stall-breaker of our own to use instead. Wish counts as the half it restores a turn later: Scream Tail alternated Wish and Protect from 45% back to
 * full through seven of Sandy Shocks's Thunderbolts, each doing about a fifth. Attacks and idle moves are skipped; a
 * switch, a pivot, a status, Taunt, Encore, Heal Block, setup, our own heal, hazards, screens, hazard removal and
 * phazing are left, since those are what break a stall like this or pay whatever it heals.
 */
export function outhealed(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || foe.fainted || hasSubstitute(foe)) return result;
  // Asleep or frozen, it cannot reach its heal this turn, so our attacks land for free: Latias, Spored straight after
  // its second Recover, had Crunch skipped for a switch to Spidops, then woke and Draco Meteored Spidops.
  if (foe.status === 'slp' || foe.status === 'frz') return result;
  const met = s.matchup;
  // Counted over the whole battle for this pair: Chimecho Recovered twice against Electrode, and when Electrode came
  // back to face it, four Thunderbolts into Calm Mind and Recover ended with Life Orb recoil knocking Electrode out.
  const healed = Math.max(met?.heals?.[foeSide] ?? 0, s.healsAgainst?.[`${foe.id}>${me.id}`] ?? 0);
  if (!met || met[side] !== me.id || met[foeSide] !== foe.id || healed < 2) return result;
  // Strength Sap heals by our own current Attack, which we know exactly; as a share of their max HP it is the heal.
  const sap = () => {
    try {
      const theirMax = buildPokemon(foe, inferOpponent(foe).candidates[0]).maxHP();
      const attack = boostedStat(buildPokemon(me).rawStats.atk, me.boosts.atk ?? 0);
      return theirMax > 0 ? Math.min(100, Math.round(attack / theirMax * 1000) / 10) : 0;
    } catch { return 0; }
  };
  // Wish restores half its user's max HP at the end of the next turn, to whoever holds the slot; a healer staying in takes it itself.
  const heal = Math.max(0, ...foe.revealedMoves.map(m => id(m) === 'strengthsap' ? sap() : id(m) === 'wish' ? 50 : healPercentNow(m, s.field.weather) ?? 0));
  // A heal with one use or none left ends the stall on its own: attacking through it is how that PP runs out.
  const healers = foe.revealedMoves.filter(m => id(m) === 'strengthsap' || id(m) === 'wish' || (healPercentNow(m, s.field.weather) ?? 0) > 0).map(m => dex.moves.get(m).name);
  const pp = opponentPP(s, foe, me)?.moves ?? [];
  if (healers.length && healers.every(h => (pp.find(m => m.move === h)?.atMostRemaining ?? Infinity) <= 1)) return result;
  // With no switch that answers it, a Taunt or Encore of our own still ends the stall, so the attacks are still skipped.
  // A switch that only lives through its entry is no way out: Dusknoir's Poltergeist into a Shore Up Palossand was
  // skipped three turns running for Bastiodon, four times weak to its Earth Power, and a judge with Palossand's real set
  // put Poltergeist 0.07 to 0.13 ahead each time (self-play seed 11).
  const breaks = input.legalActions.some(a => a.kind === 'move' && stallBreakers.has(id(a.label.split(' + Tera')[0]!)));
  if (!heal || (!answeringSwitch(input) && !breaks)) return result;
  const moves = input.legalActions.filter(a => a.kind === 'move').map(action => {
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    return { action, move, range: move.exists && move.category !== 'Status' ? damageRange(s, move.name, tera) : null };
  });
  if (moves.some(m => m.range?.conditionalKO === 'all-sampled-rolls')) return result;
  const best = Math.max(0, ...moves.map(m => m.range?.percentOfMaxHP[1] ?? 0));
  // What they lose every turn whatever they heal, poison, Salt Cure, Leech Seed or weather, counts beside our hit: a
  // healer badly poisoned is losing the loop long before one hit outdoes its heal. Taken at its most, so an unknown
  // Leftovers never makes a stall of one that is not.
  let chip = 0;
  try { const net = residuals(s, foe, foeSide)?.perTurnPercentOfMaxHP ?? 0; chip = Math.max(0, -(Array.isArray(net) ? net[0]! : net)); } catch { chip = 0; }
  if (best + chip >= heal) return result;
  const bestName = moves.find(m => (m.range?.percentOfMaxHP[1] ?? -1) === best)?.move.name ?? 'our best attack';
  const ourHazards = Object.values(ours.hazards ?? {}).some(n => (n ?? 0) > 0);
  const holds = (volatile: string) => Object.keys(foe.volatiles).some(k => id(k) === volatile);
  for (const { action, move } of moves) {
    // Knock Off breaks it only while there is an item to take: after the first hit it is one more attack.
    const takesItem = move.id === 'knockoff' && foe.item !== '';
    if (!move.exists || move.status || stallBreakers.has(move.id) || takesItem || move.selfSwitch || (move.target === 'self' && (move.boosts || move.self?.boosts))) continue;
    // A move whose point is not its damage is not outhealed. Our own heal: skipped here, Florges's Synthesis became a
    // switch to Ditto twice against a Calm Mind Latias (2687703481). Hazards and screens work whatever they heal, and
    // clearing our hazards pays on every later switch. Rapid Spin and Mortal Spin clear them too, and phazing or Clear
    // Smog breaks the stall: Avalugg's Rapid Spin, the search's pick at 0.63, was skipped three times against Toxapex for
    // Recover at 0.52 (2687740108).
    if (move.category === 'Status' && (move.flags?.heal || move.sideCondition ||
        (['defog', 'courtchange', 'tidyup'].includes(move.id) && ourHazards))) continue;
    if (notForTheDamage.has(move.id)) continue;
    // Salt Cure and Leech Seed start a loss no heal stops, and Yawn puts the healer to sleep or out: the first of each
    // breaks the stall. Once it is in place, another is only its hit, or fails.
    if (['saltcure', 'leechseed', 'yawn'].includes(move.id) && !holds(move.id) && !(move.id === 'yawn' && foe.status)) continue;
    // Pain Split is our own recovery as much as their loss, left to the search like our other heals.
    if (move.id === 'painsplit') continue;
    // An attack that raises the stat it hits with, at least half the time, grows with every use: Torch Song's Special
    // Attack climbs each hit until it outpaces the heal, where a plain attack never does.
    const attackingStat = move.category === 'Physical' ? 'atk' : 'spa';
    if ((move.secondaries ?? []).some(e => (e.chance ?? 100) >= 50 && ((e.self?.boosts as Record<string, number> | undefined)?.[attackingStat] ?? 0) > 0)) continue;
    result.set(action.id, { by: 'stall', reason: `${foe.species} has healed ${healed} times against ${me.species}, and each heal restores ${heal}% while our best hit, ${bestName}, does at most ${best}%${chip ? `, with ${Math.round(chip)}% a turn it loses anyway` : ''}; ${move.name} cannot outpace that, so switch or break the stall instead` });
  }
  return result;
}

/**
 * A Recover user can move first, undo the apparent knockout, and make us pay recoil anyway. Dondozo repeatedly
 * Wave Crashed into Arceus's Recover until recoil knocked it out, even though Rest was safe and Sleep Talk let it
 * keep playing. Only skip the recoil attack after recovery has been observed against this Pokémon, when that
 * recovery keeps the foe out of range, Rest can be used before we are knocked out, and the two sleep turns survive.
 */
export function recoilIntoRecovery(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted || (me.hpPercent ?? 100) > 40 ||
      hasSubstitute(foe) || foe.status === 'slp' || foe.status === 'frz' ||
      ['rockhead', 'magicguard'].includes(id(me.ability)) ||
      speedSummary(s, me).relation !== 'slower-than-all-samples' || !sleepTalkMoves(me)) return result;
  const rest = input.legalActions.find(a => a.kind === 'move' && !a.command.endsWith(' terastallize') &&
    id(a.label) === 'rest');
  if (!rest || certainFailure(s, 'Rest', me, side, foe) || restPlan(s, me, side).survivesTheSleep !== true) return result;
  const threat = incomingThreats(s, me, side, Infinity);
  if (threat?.worstCasePercentOfMaxHP == null || threat.worstCasePercentOfMaxHP >= (me.hpPercent ?? 0)) return result;
  const currentPair = s.matchup?.[side] === me.id && s.matchup?.[foeSide] === foe.id;
  const healed = Math.max(currentPair ? s.matchup?.heals?.[foeSide] ?? 0 : 0,
    s.healsAgainst?.[`${foe.id}>${me.id}`] ?? 0);
  if (healed < 1) return result;
  const recovery = foe.revealedMoves.map(name => ({ name, amount: healPercentNow(name, s.field.weather) ?? 0 }))
    .filter(x => x.amount > 0 && canUseRecoveryNow(foe, x.name)).sort((a, b) => b.amount - a.amount)[0];
  if (!recovery || (healed < 2 && id(foe.lastMoveUsed) !== id(recovery.name))) return result;
  const remaining = opponentPP(s, foe, me)?.moves.find(m => id(m.move) === id(recovery.name))?.atMostRemaining;
  if (remaining !== undefined && remaining <= 1) return result;
  const healedHP = Math.min(100, (foe.hpPercent ?? 100) + recovery.amount);
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || action.command.endsWith(' terastallize')) continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label);
    if (!move.exists || !move.recoil || move.category === 'Status') continue;
    const range = damageRange(s, move.name);
    if (!range || range.percentOfMaxHP[1] + 1 >= healedHP || !me.exactHP?.max) continue;
    const recoil = Math.floor(range.hp[0] * move.recoil[0]! / move.recoil[1]!) / me.exactHP.max * 100;
    if (recoil < 8) continue;
    result.set(action.id, { by: rest.id,
      reason: `${foe.species} has used ${recovery.name} against ${me.species} and can heal to ${healedHP}% before ${move.name}; even its highest modeled hit cannot knock it out then, while recoil costs at least ${Math.round(recoil)}% of ${me.species}'s HP. Rest survives the incoming hit and its two Sleep Talk turns` });
  }
  return result;
}

/**
 * Staying in asleep against a Pokémon that sets up. Reshiram, put to sleep by Darkrai's Hypnosis, stayed in choosing Blue
 * Flare while Darkrai used Nasty Plot, and the boosted Dark Pulse then went through the rest of the team. A sleeper most
 * likely loses the turn, and against a Pokémon that boosts, a lost turn is a free boost.
 *
 * Narrow: our active is asleep from a move rather than Rest, has no Sleep Talk, and acts this turn at most half the time;
 * the opponent already holds a boost or has a revealed or near-certain boosting move; and some switch answers it: it
 * lives through its entry and then through a second hit, or moves first. Only the sleeper's moves are skipped.
 */
export function asleepWhileTheyBoost(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, theirs = s.sides[side === 'p1' ? 'p2' : 'p1'], ours = s.sides[side];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || foe.fainted || me.status !== 'slp' || me.sleepFromRest) return result;
  if ([...me.knownMoves, ...me.revealedMoves].some(m => id(m) === 'sleeptalk')) return result;
  const acts = wakeChance(me);
  if (acts > 0.5) return result;
  const boosted = Object.entries(foe.boosts).filter(([, v]) => (v ?? 0) > 0).map(([k]) => k);
  const setup = plausibleMoves(foe).find(m => (m.revealed || (m.priorProbability ?? 0) >= 0.9) && (() => {
    const move = dex.moves.get(m.move);
    return move.category === 'Status' && move.target === 'self' && Object.values(move.boosts ?? {}).some(v => (v ?? 0) > 0);
  })());
  if (!boosted.length && !setup) return result;
  if (!answeringSwitch(input)) return result;
  const why = boosted.length ? `${foe.species} is already boosted (${boosted.join(', ')})` : `${foe.species} has ${setup!.move}`;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    result.set(action.id, { by: 'sleep', reason: `${me.species} is asleep and ${acts === 0 ? 'cannot wake this turn' : `acts this turn only ${Math.round(acts * 100)}% of the time`}, and ${why}, so a lost turn is a free boost; switch to something that can answer it` });
  }
  return result;
}

/**
 * Feeding a boosted sweeper one replacement at a time while the answer waits. Against a Veluza at +2 from Fillet Away,
 * Latios, Revavroom and Talonflame went in one after another, each slower and each knocked out by a single hit, before
 * the Choice Scarf Ditto, whose Imposter copy of those boosts outsped Veluza and knocked it out on every roll. A
 * replacement for a fainted Pokémon comes in without taking a hit, so the answer costs nothing to send now.
 *
 * Narrow, because a replacement that looks doomed often is not: across 435 logged forced switches, most of the
 * Pokémon a broader rule would have held back went on to act, because the opponent switched or chose another move. A
 * boosted opponent keeps attacking rather than give its boosts up, and that is what this needs. Our Pokémon has
 * fainted (not a pivot), the opponent still standing holds a raised stat, and some replacement certainly moves first
 * with a move that knocks it out on every roll at its current typing. Then any replacement that one of the opponent's
 * likely attacks (revealed, or in half its sets) knocks out on every roll without a chance to miss, with none of its own
 * moves certainly going first and no Focus Sash or Sturdy at full HP, is skipped.
 */
export function doomedReplacement(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || !input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const gone = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!gone?.fainted || !foe || foe.fainted || !Object.values(foe.boosts).some(v => (v ?? 0) > 0)) return result;
  const options = input.legalActions.filter(a => a.kind === 'switch' && !a.uncertain).map(action => {
    const target = ours.team.find(p => p.slot === Number(action.command.split(' ')[1]));
    return target ? { action, target, arrived: afterEntry(s, target, side) } : null;
  }).filter((o): o is NonNullable<typeof o> => !!o && !o.arrived.fainted);
  const first = (o: (typeof options)[number], move: string) => turnOrder(s, o.arrived, move)?.order === 'ours-first';
  const answer = options.map(o => ({ o, ko: (outgoingBest(s, o.target, side, 4)?.moves ?? []).find(m => m.conditionalKO === 'all-sampled-rolls' && first(o, m.move)) }))
    .find(x => x.ko);
  if (!answer) return result;
  for (const o of options) {
    if (o === answer.o) continue;
    const ability = o.arrived.abilitySuppressed ? '' : id(o.arrived.ability), item = id(o.arrived.item);
    if (o.arrived.hpPercent === 100 && (item === 'focussash' || ability === 'sturdy')) continue;
    const kill = (incomingThreats(s, o.target, side, 8)?.damagingMoves ?? [])
      .find(m => (m.revealed || (m.priorProbability ?? 0) >= 0.5) && m.conditionalKO === 'all-sampled-rolls' && !m.accuracyPercent && !m.substitute);
    const moves = o.arrived.knownMoves.length ? o.arrived.knownMoves : o.arrived.revealedMoves;
    if (!kill || moves.some(m => first(o, m))) continue;
    result.set(o.action.id, { by: 'doomed', reason: `${o.target.species} would fall to the boosted ${foe.species}'s ${kill.move} before it could act, while ${answer.o.target.species} moves first and knocks it out with ${answer.ko!.move}; a replacement comes in without taking a hit, so send the answer now` });
  }
  return result;
}

/** Moves that put their target to sleep at once. Yawn, whose drowsiness gives a turn's warning, is not one. */
const sleepMoves = new Set(['spore', 'sleeppowder', 'hypnosis', 'sing', 'lovelykiss', 'darkvoid', 'grasswhistle']);

/**
 * A sleeper spent while it is still a shield. Brute Bonnet's Spore put Magearna to sleep; at 42% and still asleep, it
 * stayed in against a faster Barraskewda over Jev's switch and fell to Waterfall without moving. While one of our
 * Pokémon sleeps from a move, Sleep Clause makes every other sleep move fail on us, so a sleeper on the bench protects
 * the whole team. With Magearna gone, Spore put Flutter Mane to sleep six turns later, and it fell the same way.
 *
 * Narrow: our active sleeps from a move rather than Rest, no other Pokémon of ours is asleep, a living opponent has
 * shown a sleep move, and one of their likely attacks knocks us out before we act at least half the time: a hit that
 * can miss, landing while we sleep on, or even if we wake whenever they move first. A switch must survive its entry.
 */
export function sleeperThrownAway(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || foe.fainted || me.status !== 'slp' || me.sleepFromRest || me.hpPercent === null) return result;
  if (ours.team.some(p => p.id !== me.id && !p.fainted && p.status === 'slp')) return result;
  const holder = theirs.team.find(p => !p.fainted && p.revealedMoves.some(m => sleepMoves.has(id(m))));
  if (!holder) return result;
  const wake = wakeChance(me);
  const likely = (incomingThreats(s, me, side, 8)?.damagingMoves ?? []).filter(m => m.revealed || (m.priorProbability ?? 0) >= 0.5);
  const worst = likely.map(m => {
    // Waking, we act first only if we certainly outspeed with our fastest option; otherwise their hit lands first either way.
    const first = input.legalActions.some(a => a.kind === 'move' && turnOrder(s, me, a.label.split(' + Tera')[0]!)?.order === 'ours-first');
    return { move: m.move, p: knockoutBefore(m.percentOfMaxHP, me.hpPercent!, (m.accuracyPercent ?? 100) / 100, 1) * (first ? 1 - wake : 1) };
  }).sort((a, b) => b.p - a.p)[0];
  if (!worst || worst.p < 0.5 || !escapable(input)) return result;
  const sleepMove = holder.revealedMoves.find(m => sleepMoves.has(id(m)))!;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    result.set(action.id, { by: 'sleep', reason: `${me.species} is asleep, and ${foe.species}'s ${worst.move} knocks it out before it acts about ${Math.round(worst.p * 100)}% of the time; while it sleeps, Sleep Clause stops ${holder.species}'s ${sleepMove} on the rest of the team, so keep it alive and switch` });
  }
  return result;
}

/** Moves that undo our boosts: forcing us out, or resetting every stat stage. */
const phazers: Record<string, string> = { whirlwind: 'forces us out', roar: 'forces us out', dragontail: 'forces us out',
  circlethrow: 'forces us out', haze: 'resets every stat change', clearsmog: 'resets the stat changes of what it hits' };

/**
 * Boosting into a Pokémon that undoes boosts. Gogoat used Bulk Up twice into a Skarmory whose Whirlwind then dragged
 * it out and threw both away. Against a phazing move already seen, or one every sampled set carries — Toxapex always
 * has Haze — a boosting move is a turn given away.
 *
 * Narrow: a status move whose only effect is raising our own stats, against an opponent with a revealed or near-certain
 * Whirlwind, Roar, Dragon Tail, Circle Throw, Haze or Clear Smog. Suction Cups and Guard Dog stop the forcing moves, and
 * Soundproof stops Roar, so those are allowed through.
 */
export function setupIntoPhazer(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, theirs = s.sides[side === 'p1' ? 'p2' : 'p1'], ours = s.sides[side];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || foe.fainted) return result;
  const ability = me.abilitySuppressed ? '' : id(me.ability);
  const stops = (m: string) => phazers[m] === 'forces us out' && (['suctioncups', 'guarddog'].includes(ability) || (m === 'roar' && ability === 'soundproof'));
  const phaze = plausibleMoves(foe).find(m => phazers[id(m.move)] && (m.revealed || (m.priorProbability ?? 0) >= 0.9) && !stops(id(m.move)));
  if (!phaze) return result;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    const raises = move.category === 'Status' && move.target === 'self' && Object.values(move.boosts ?? {}).some(v => (v ?? 0) > 0);
    if (!raises || move.heal || move.volatileStatus || move.sideCondition) continue;
    result.set(action.id, { by: 'phazer', reason: `${foe.species} ${phaze.revealed ? 'has shown' : 'almost certainly has'} ${phaze.move}, which ${phazers[id(phaze.move)]}, so the boosts from ${move.name} are likely thrown away` });
  }
  return result;
}

/**
 * Boosting in front of a sleep move. Magearna used Shift Gear, over Jev's Fleur Cannon, into a Brute Bonnet whose every
 * set carries Spore; it was asleep the next turn and spent most of the game that way. Cloyster used Shell Smash into a
 * Venomoth with Sleep Powder in every set, where an unboosted Rock Blast did 78–94%, and fell to 4%. A boost pays off only
 * once it is used, and a sleep move puts that off by one to three turns, which the opponent spends as it likes.
 *
 * Narrow: a status move whose only effect is raising our own stats, against an opponent free to act this turn with a
 * revealed or near-certain sleep move that lands at least three times in four and that nothing stops: our status, a
 * Substitute, our type, ability or item, the terrain, Safeguard or Sleep Clause. Terastallizing into a Grass type with
 * the boost gets through against Spore and powders.
 *
 * Attacking does not stop the sleep, only spends the turn before it on damage instead, so the guard stands down when
 * that damage is small and the sleep can be sat out. Magearna led into Amoonguss, where Iron Head did 24–29% into
 * Regenerator and a Rocky Helmet that took 16% back, and it was slept all the same; Shift Gear would have slept with +1
 * Attack and +2 Speed, in front of a Pokémon whose Poison moves cannot touch Steel. Against Brute Bonnet the forgone
 * Fleur Cannon did 82–98%, and against Venomoth Cloyster's Rock Blast 78–94%, which is what the guard is for.
 */
export function setupIntoSleep(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted || me.status || hasSubstitute(me)) return result;
  // Asleep, frozen, Taunted or recharging, it cannot use a sleep move this turn, nor while locked into another move.
  if (foe.status === 'slp' || foe.status === 'frz' || Object.keys(foe.volatiles).some(k => ['taunt', 'mustrecharge'].includes(id(k)))) return result;
  const lock = choiceLock(foe);
  const ability = me.abilitySuppressed ? '' : id(me.ability);
  if (['magicbounce', 'goodasgold'].includes(ability)) return result;
  const lands = (name: string) => {
    const v = effectViability(s, name, foe, foeSide, me);
    return !v?.certain.length && !v?.possible.some(p => p.probability === 1) && hitChancePercent(name, s.field.weather, foe, me) >= 75 &&
      !(lock && lock.probability >= 1 && id(lock.lockedInto) !== id(name));
  };
  const sleep = plausibleMoves(foe).find(m => sleepMoves.has(id(m.move)) && (m.revealed || (m.priorProbability ?? 0) >= 0.9) && lands(m.move));
  if (!sleep) return result;
  if (sleepCanBeSatOut(s, me, foe, side)) return result;
  const powder = !!dex.moves.get(sleep.move).flags.powder;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    const raises = move.category === 'Status' && move.target === 'self' && Object.values(move.boosts ?? {}).some(v => (v ?? 0) > 0);
    if (!raises || move.heal || move.volatileStatus || move.sideCondition) continue;
    const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    if (powder && tera === 'Grass') continue;
    result.set(action.id, { by: 'sleep', reason: `${foe.species} ${sleep.revealed ? 'has shown' : 'almost certainly has'} ${sleep.move}, and nothing stops it on ${me.species}: the boosts from ${move.name} would sit through one to three turns asleep while ${foe.species} acts freely` });
  }
  return result;
}

/** Doubled only by something the sleeper's own turns do not arrange: a failed move, a hit taken, a stat drop, a faint. */
const doubledByHistory = new Set(['stompingtantrum', 'avalanche', 'revenge', 'assurance', 'lashout', 'retaliate']);
/** Moves that undo our boosts where we stand, short of knocking us out. */
const boostErasers = new Set(['haze', 'clearsmog', 'roar', 'whirlwind', 'dragontail', 'circlethrow', 'topsyturvy', 'spectralthief']);

/**
 * Whether boosting before a sleep beats attacking before it. Two of our best hits must leave the sleeper standing, so
 * the attack is chip rather than progress; two turns of its worst hit — the expected sleep — must leave us standing;
 * and nothing it likely carries may erase the boosts while we sleep. Moves doubled by history count at base power,
 * since a sleeper gives them nothing to double on.
 */
function sleepCanBeSatOut(s: BattleState, me: PokemonState, foe: PokemonState, side: SideId) {
  const ours = outgoingBest(s, me, side, Infinity);
  if (!ours || foe.hpPercent === null || me.hpPercent === null || 2 * ours.bestCasePercentOfMaxHP >= foe.hpPercent) return false;
  const theirs = incomingThreats(s, me, side, Infinity);
  if (!theirs) return false;
  const perTurn = Math.max(0, ...theirs.damagingMoves.map(m => doubledByHistory.has(id(m.move)) ? m.percentOfMaxHP[1] / 2 : m.percentOfMaxHP[1]));
  if (me.hpPercent - 2 * perTurn <= 0) return false;
  const types = pokemonTypes(me);
  return !plausibleMoves(foe).some(m => boostErasers.has(id(m.move)) && (m.revealed || (m.priorProbability ?? 0) >= 0.5) &&
    (dex.moves.get(m.move).category === 'Status' || typeEffectiveness(dex.moves.get(m.move).type, types) !== 0));
}

/**
 * The Speed stages a move certainly gives its user: a boosting move, or an attack that raises Speed every time it hits.
 * Every such attack carries the raise as a secondary effect, which Sheer Force removes: Feraligatr's Trailblaze raised
 * nothing, yet was counted as +1 against Haxorus's Swords Dance (2687202806). Ancient Power's 10% is not a race either.
 * Contrary turns the raise into a drop and Simple doubles it.
 */
function speedGain(moveName: string, ability = '') {
  const m = dex.moves.get(moveName);
  if (!m.exists) return 0;
  const a = id(ability);
  const own = m.target === 'self' ? m.boosts?.spe ?? 0 : 0;
  const onHit = a === 'sheerforce' ? 0 : Math.max(m.self?.boosts?.spe ?? 0,
    ...(m.secondaries ?? []).filter(x => (x.chance ?? 100) >= 100).map(x => x.self?.boosts?.spe ?? 0));
  const gain = Math.max(own, onHit);
  return a === 'contrary' ? -gain : a === 'simple' ? 2 * gain : gain;
}

/**
 * Boosting in a race already lost. Polteageist used Shell Smash into an Oricorio that had used Quiver Dance; each boosted,
 * Oricorio stayed faster, and from +3 it swept the whole team. When the opponent has shown a move that raises its Speed
 * and would still outspeed us after our boost and one more of its own, a boost only hands it the next turn.
 *
 * Narrow: a status move whose only effect is raising our own stats, against an opponent with a revealed Speed-raising
 * move, whose Speed after one more use beats ours after this boost in every sampled set, outside Trick Room. A priority
 * attack of ours can win the race without outspeeding, so its holder is left alone, as is anything that hits, cripples or
 * forces the opponent out.
 *
 * Only a race we could lose counts. A boost to Defense or Special Defense is how a slower Pokémon beats a faster one, so
 * Cosmic Power, Iron Defense, Calm Mind and the like are left to the ranking: the guard skipped Chimecho's Cosmic Power
 * five times while one Dragon Dance Tropius swept the team (2687157918). A boost with no Speed in it changes the race
 * only when we move first now and one more of its boosts takes that away; when it already outspeeds us there is no
 * race to lose.
 */
export function setupRaceLost(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0] || s.field.trickRoom) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted) return result;
  // Each sampled set races with its own ability; one set whose revealed moves cannot raise its Speed means no race.
  const sets = inferOpponent(foe).candidates;
  const abilityOf = (c: Candidate | undefined) => foe.abilitySuppressed ? '' : foe.ability ?? c?.ability ?? '';
  const racerFor = (c: Candidate | undefined) => foe.revealedMoves.map(m => ({ move: dex.moves.get(m).name, gain: speedGain(m, abilityOf(c)) }))
    .sort((a, b) => b.gain - a.gain)[0];
  const racers = (sets.length ? sets : [undefined]).map(c => ({ c, racer: racerFor(c) }));
  if (racers.some(r => !r.racer || r.racer.gain <= 0)) return result;
  const racer = racers[0]!.racer!;
  const moveOf = (action: DecisionInput['legalActions'][number]) => {
    const slot = Number(action.command.split(' ')[1]) - 1;
    return dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
  };
  const moves = input.legalActions.filter(a => a.kind === 'move');
  if (moves.some(a => { const m = moveOf(a); return m.category !== 'Status' && (movePriority(s, me, m.name) ?? 0) > 0; })) return result;
  const stage = (v: number) => Math.max(-6, Math.min(6, v));
  const theirSpeeds = racers.map(({ c, racer: r }) =>
    effectiveSpeed(s, { ...foe, boosts: { ...foe.boosts, spe: stage((foe.boosts.spe ?? 0) + r!.gain) } }, foeSide, c));
  if (theirSpeeds.some(v => v === null)) return result;
  const slowest = Math.min(...(theirSpeeds as number[]));
  const theirsNow = (sets.length ? sets : [undefined]).map(c => effectiveSpeed(s, foe, foeSide, c));
  const now = effectiveSpeed(s, me, side);
  const firstNow = now !== null && theirsNow.every(v => v !== null && now > v);
  for (const action of moves) {
    const move = moveOf(action);
    const raises = move.category === 'Status' && move.target === 'self' && Object.values(move.boosts ?? {}).some(v => (v ?? 0) > 0);
    if (!raises || move.heal || move.volatileStatus || move.sideCondition) continue;
    const changes = selfStageChanges(me, move.boosts as Record<string, number>);
    if ((changes.def ?? 0) > 0 || (changes.spd ?? 0) > 0) continue;
    const gain = changes.spe ?? 0;
    if (gain <= 0 && !firstNow) continue;
    const mine = effectiveSpeed(s, { ...me, boosts: { ...me.boosts, spe: stage((me.boosts.spe ?? 0) + gain) } }, side);
    if (mine === null || mine >= slowest) continue;
    result.set(action.id, { by: 'race', reason: `${foe.species} has ${racer.move}; after ${move.name} we would have ${mine} Speed and it at least ${slowest} after one more, so it stays faster and the boost only gives it the next turn` });
  }
  return result;
}

/**
 * A pure offensive/Speed setup cannot beat the last opponent when Unaware certainly ignores the offensive stages
 * and we already move first. Speed still matters against Unaware, so an uncertain speed race is left to the ranking.
 * Defensive boosts, Mold Breaker and a Tera variant can each change the answer and are left alone as well.
 */
export function futileUnawareSetup(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || foe.fainted || remainingPokemon(theirs) !== 1 || foe.abilitySuppressed || breaksMoulds(me) ||
      speedSummary(s, me).relation !== 'faster-than-all-samples') return result;
  const candidates = inferOpponent(foe).candidates;
  if (!candidates.length || candidates.some(c => id(foe.ability ?? c.ability) !== 'unaware')) return result;
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || action.command.endsWith(' terastallize')) continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label);
    if (!move.exists || move.category !== 'Status' || move.target !== 'self' || !move.boosts || move.heal ||
        move.sideCondition || move.volatileStatus || move.weather || move.terrain || move.self?.volatileStatus) continue;
    const changes = selfStageChanges(me, move.boosts);
    const gains = Object.entries(changes).filter(([, n]) => n > 0).map(([stat]) => stat);
    if (!gains.length || gains.some(stat => !['atk', 'spa', 'spe', 'accuracy'].includes(stat))) continue;
    result.set(action.id, { by: 'unaware', reason: `${foe.species} is the last opponent and is certainly Unaware; it ignores ${me.species}'s offensive boosts, and ${me.species} already outspeeds it, so ${move.name} cannot improve this matchup` });
  }
  return result;
}

/** Items a knockout can rest on, with what they multiply its damage by; Knock Off or Trick used first takes them away. */
const damageItems: Record<string, number> = { choiceband: 1.5, choicespecs: 1.5, lifeorb: 1.3, expertbelt: 1.2, loadeddice: 2,
  muscleband: 1.1, wiseglasses: 1.1, punchingglove: 1.1 };
const itemTakers = new Set(['knockoff', 'trick', 'switcheroo', 'thief', 'covet', 'corrosivegas']);
/** How much of their HP a heal they use first can restore, in percent, where the move's own data does not say. */
const healPercent: Record<string, number> = { rest: 100, strengthsap: 100, painsplit: 100, shoreup: 67, morningsun: 67,
  synthesis: 67, moonlight: 67, lifedew: 25, junglehealing: 25, lunarblessing: 25 };
const terrainName: Record<string, string> = { electricterrain: 'Electric Terrain', grassyterrain: 'Grassy Terrain',
  mistyterrain: 'Misty Terrain', psychicterrain: 'Psychic Terrain' };
const stage = (n: number) => { const x = Math.max(-6, Math.min(6, n)); return x >= 0 ? (2 + x) / 2 : 2 / (2 - x); };
type Move = ReturnType<typeof dex.moves.get>;
type Boosts = Partial<Record<string, number>> | undefined | null;

/**
 * What a move the opponent uses before our attack does to that attack's knockout. 'stops' when the knockout can fail
 * while a status move of ours would still have worked: a Protect, a heal that lifts it out of range, a Substitute, a
 * screen, raised defences or evasion, our attacking stat or accuracy lowered, a burn on a physical attacker, weather
 * or terrain against the attack, an item the damage rests on taken away, Destiny Bond, or Disable on the attack.
 * `{ stills }` when it may stop us moving whatever we chose (sleep, paralysis, freeze, confusion, a flinch, Encore),
 * with the chance it does, which costs a status move just as much unless that move goes first. Each weakening is
 * tested against how far the attack overshoots, so a burn does not save a 1% Pyroar from an Earthquake that deals
 * half its HP when halved.
 *
 * `cases` are the knockout's worst rolls against each sampled set and Tera, as [damage, their HP] in percent.
 */
function beforeOurHit(s: BattleState, d: Move, ko: Move, me: PokemonState, foe: PokemonState, foeSide: SideId, cases: [number, number][], grace = 1): 'stops' | { stills: number } | null {
  const holds = (factor: number) => cases.every(([min, hp]) => min * factor >= hp);
  const survivesHeal = (heal: number) => cases.every(([min, hp]) => min >= Math.min(100, hp + heal));
  const ourAbility = me.abilitySuppressed ? '' : id(me.ability ?? ''), ourItem = id(me.item ?? '');
  const physical = ko.category === 'Physical', attackStat = physical ? 'atk' : 'spa';
  const defenceStat = physical || ['psyshock', 'psystrike', 'secretsword'].includes(ko.id) ? 'def' : 'spd';
  const ignoresTheirBoosts = ourAbility === 'unaware' || !!ko.ignoreDefensive || !!ko.ignoreEvasion;
  const shielded = hasSubstitute(me) && !d.flags.bypasssub && !d.flags.sound;
  if (protectMoves.has(d.id) || d.id === 'destinybond') return 'stops';
  if (d.id === 'substitute') return (foe.hpPercent ?? 100) > 25 ? 'stops' : null;
  if (d.id === 'throatchop') return ko.flags.sound ? 'stops' : null;
  if (d.id === 'disable' || d.id === 'torment') return id(me.lastMoveUsed ?? '') === ko.id ? 'stops' : null;
  if (d.id === 'encore') return { stills: 1 };
  if (d.id === 'wish' || d.id === 'healpulse' || d.id === 'floralhealing' || d.id === 'healingwish' || d.id === 'lunardance') return null;
  const heal = d.drain ? 50 : d.flags.heal ? healPercent[d.id] ?? (d.heal ? (100 * d.heal[0]!) / d.heal[1]! : 50) : 0;
  if (heal && !survivesHeal(heal)) return 'stops';
  if (d.weather || d.terrain) {
    const now = fieldFactors(ko.type, ko.id, s.field.weather, s.field.terrain);
    const next = fieldFactors(ko.type, ko.id, d.weather ?? s.field.weather, d.terrain ? terrainName[d.terrain] ?? null : s.field.terrain);
    const types = pokemonTypes(foe), w = id(d.weather ?? '');
    const guard = (w === 'sandstorm' && !physical && types.includes('Rock')) || (['snowscape', 'snow', 'hail'].includes(w) && physical && types.includes('Ice')) ? 2 / 3 : 1;
    const factor = (next.weatherIfUnsuppressed * next.terrainIfAttackerGrounded * next.terrainIfDefenderGrounded * guard) /
      (now.weatherIfUnsuppressed * now.terrainIfAttackerGrounded * now.terrainIfDefenderGrounded);
    if (d.terrain === 'psychicterrain' && (ko.priority ?? 0) > 0) return 'stops';
    if (!holds(factor)) return 'stops';
  }
  // A screen halves the hit unless one covering it is already up (and so already in the numbers); Aurora Veil needs snow.
  const up = s.sides[foeSide].conditions, covered = !!up['Aurora Veil'] || (physical ? !!up.Reflect : !!up['Light Screen']);
  const screen = d.id === 'reflect' ? physical : d.id === 'lightscreen' ? !physical
    : d.id === 'auroraveil' && ['snowscape', 'snow', 'hail'].includes(id(s.field.weather ?? ''));
  if (screen && !covered && !['brickbreak', 'psychicfangs', 'ragingbull'].includes(ko.id) && !holds(0.5)) return 'stops';
  if (itemTakers.has(d.id) && damageItems[ourItem] && ourAbility !== 'stickyhold' && !holds(1 / damageItems[ourItem]!)) return 'stops';
  // Our stats lowered: Clear Body and its kin, Clear Amulet and a Substitute block it; Contrary, Defiant and Competitive turn it around.
  const lowers = (b: Boosts) => {
    if (!b || shielded || ['clearbody', 'whitesmoke', 'fullmetalbody', 'mirrorarmor', 'contrary'].includes(ourAbility) || ourItem === 'clearamulet') return false;
    if ((b.accuracy ?? 0) < 0 && !['keeneye', 'mindseye', 'illuminate'].includes(ourAbility)) return true;
    const drop = b[attackStat] ?? 0;
    if (drop >= 0 || (attackStat === 'atk' && ourAbility === 'hypercutter')) return false;
    if ((ourAbility === 'defiant' && attackStat === 'atk') || (ourAbility === 'competitive' && attackStat === 'spa')) return false;
    const now = me.boosts[attackStat] ?? 0;
    return !holds(stage(now + drop) / stage(now));
  };
  // Their defence or evasion raised, which Unaware and moves that ignore stat changes do not see.
  const raises = (b: Boosts) => {
    if (!b || ignoresTheirBoosts) return false;
    if ((b.evasion ?? 0) > 0) return true;
    const gain = b[defenceStat] ?? 0, now = foe.boosts[defenceStat] ?? 0;
    return gain > 0 && !holds(stage(now) / stage(now + gain));
  };
  const statusOnUs = (x: string | undefined) => {
    if (!x || me.status || shielded || ourAbility === 'comatose' || ourAbility === 'purifyingsalt') return null;
    if (x === 'brn') return physical && ko.id !== 'facade' && ourAbility !== 'guts' && !pokemonTypes(me).includes('Fire') &&
      !['waterveil', 'waterbubble', 'thermalexchange'].includes(ourAbility) && !holds(0.5) ? 'stops' : null;
    // Paralysis stops a move a quarter of the time; sleep and freeze stop it outright.
    return x === 'slp' || x === 'frz' ? { stills: 1 } : x === 'par' ? { stills: 0.25 } : null;
  };
  const stills = (v: string | undefined) => (v === 'flinch' ? 1 : v === 'confusion' && !shielded ? 1 / 3 : 0);
  if (d.category === 'Status') {
    const status = statusOnUs(d.status);
    if (status) return status;
    if (stills(d.volatileStatus)) return { stills: stills(d.volatileStatus) };
    if (d.target === 'self' ? raises(d.boosts) : lowers(d.boosts) || raises(d.self?.boosts)) return 'stops';
    if (d.id === 'curse' && !pokemonTypes(foe).includes('Ghost') && raises({ def: 1 })) return 'stops';
    if (d.id === 'stockpile' && raises({ def: 1, spd: 1 })) return 'stops';
    return null;
  }
  if (raises(d.self?.boosts)) return 'stops';
  let still = 0;
  for (const x of [d.secondary, ...(d.secondaries ?? [])]) {
    if (!x) continue;
    // Serene Grace doubles every secondary chance: Jirachi's Iron Head flinches 60% of the time.
    const chance = Math.min(100, (x.chance ?? 100) * grace);
    // A burn as likely as Scald's counts; a certain stat change counts; any chance of not moving at all stills us.
    if (x.status === 'brn' && chance >= 30 && statusOnUs('brn') === 'stops') return 'stops';
    if ((chance >= 100 && lowers(x.boosts)) || (chance >= 50 && raises(x.self?.boosts))) return 'stops';
    const status = statusOnUs(x.status);
    still = Math.max(still, (chance / 100) * Math.max(status && status !== 'stops' ? status.stills : 0, stills(x.volatileStatus)));
  }
  return still ? { stills: still } : null;
}

/**
 * A certain knockout passed up for a turn of setup or utility. Search chose Quiver Dance over Revelation Dance on a 26%
 * Heatran, Rapid Spin over Ice Beam on a 20% Whiscash, and Tidy Up over Bite on a 17% Uxie; each knockout moved first
 * at every roll, so the opponent never got the turn the other move handed it.
 *
 * Moving second is the same trade. Whatever the opponent does first either leaves the knockout standing, stops it while
 * a status move would still have worked (beforeOurHit: 'stops', and then nothing is skipped), or knocks us out or stops
 * us moving, which costs the status move just as much unless it goes first. So a status move of ordinary priority is
 * skipped even when their hit might knock us out first; one that goes first (Prankster, Protect) is skipped only when
 * nothing it would beat to the punch knocks us out or stops us — at every roll with the order uncertain, as with
 * Klefki's Prankster Spikes beside a Dazzling Gleam on a 6% Baxcalibur, and at any roll once they certainly move first.
 *
 * Narrow: a move that cannot miss, and is not Sucker Punch, knocks the target out at every sampled roll, whatever Tera
 * type it could still choose (and, moving second, whatever type Protean or Libero could make it); nothing is behind a
 * Substitute. Only status moves are skipped — setup, hazards, healing, utility. Other attacks and switches are left to
 * judgement.
 */
export function freeKnockoutPassedUp(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string; prefer?: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  // Behind an Illusion the target may not be what we see, and nothing about it is certain.
  if (!me || !foe || me.fainted || foe.fainted || hasSubstitute(foe) || theirs.identityUncertain) return result;
  const moveOf = (action: DecisionInput['legalActions'][number]) => {
    const slot = Number(action.command.split(' ')[1]) - 1;
    return dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
  };
  // A side Terastallises once: after that, or once this one has, the typing we see is the one it keeps.
  const teraLeft = !foe.terastallized && !theirs.team.some(p => p.terastallized);
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  const teraTypes = teraLeft ? [...new Set(inferOpponent(foe).candidates.map(c => c.teraType).filter(Boolean))] : [];
  // Protean and Libero change its type to that of the move it uses, once per entry; used first, that is the typing our
  // attack meets.
  const proteanTypes = !Object.keys(foe.volatiles).some(k => id(k) === 'typechange') &&
    inferOpponent(foe).candidates.some(c => ['protean', 'libero'].includes(id(c.ability ?? '')))
    ? [...new Set(plausibleMoves(foe).map(m => dex.moves.get(m.move).type))] : [];
  /** The worst roll against each sampled set and type, as [damage, their HP] in percent; null unless every one knocks out. */
  const cases = (name: string, first: boolean) => {
    if (damageRange(s, name)?.conditionalKO !== 'all-sampled-rolls' || !sets.length) return null;
    const out: [number, number][] = [];
    for (const t of [undefined, ...new Set([...teraTypes, ...(first ? [] : proteanTypes)])]) for (const c of sets) {
      const r = scenario(s, me, foe, side, name, undefined, c, undefined, t);
      if (!r) return null;
      const hp = hpInterval(foe, r.defenderMaxHP)[1];
      if (r.endures || r.min < hp) return null;
      out.push([(100 * r.min) / r.defenderMaxHP, (100 * hp) / r.defenderMaxHP]);
    }
    return out;
  };
  const threat = incomingThreats(s, me, side, Infinity);
  const foeMoves = plausibleMoves(foe).map(m => dex.moves.get(m.move)).filter(m => m.exists);
  // The highest priority any sampled set gives the move, so a possible Prankster counts (null when any is unknown).
  const theirPriority = (name: string) => {
    const all = (inferOpponent(foe).candidates.length ? inferOpponent(foe).candidates : [undefined]).map(c => movePriority(s, foe, name, c));
    return all.some(p => p === null) ? null : Math.max(...(all as number[]));
  };
  const tieOurs = speedSummary(s, me).ifEqualPriority === 'ours-first';
  const grace = !foe.abilitySuppressed && (id(foe.ability ?? '') === 'serenegrace' ||
    (!foe.ability && inferOpponent(foe).candidates.some(c => id(c.ability ?? '') === 'serenegrace'))) ? 2 : 1;
  const judged = input.legalActions.filter(a => a.kind === 'move' && !a.command.endsWith(' terastallize')).map(a => ({ a, m: moveOf(a) }))
    // A knockout that fails on the opponent's choice (Sucker Punch, Thunderclap, Upper Hand), that charges first, that
    // certainly fails, or that takes us down with it (Explosion, Mind Blown) is no knockout to insist on.
    .filter(({ m }) => m.exists && m.category !== 'Status' && !['suckerpunch', 'thunderclap', 'upperhand'].includes(m.id) &&
      !m.selfdestruct && !m.mindBlownRecoil && !chargesThisTurn(m.name, s.field.weather, me) &&
      !certainFailure(s, m.name, me, side, foe) && hitChancePercent(m.name, s.field.weather, me, foe) >= 100)
    .map(({ a, m }) => {
      const order = turnOrder(s, me, m.name);
      if (!order || order.ourPriority === null) return null;
      const first = order.order === 'ours-first';
      const worst = cases(m.name, first);
      if (!worst) return null;
      // Their moves that could go before this attack, and what each does to it.
      const before = first ? [] : foeMoves.filter(f => {
        const p = theirPriority(f.name);
        return p === null || p > order.ourPriority! || (p === order.ourPriority && !tieOurs);
      }).map(f => ({ move: f, priority: theirPriority(f.name), effect: beforeOurHit(s, f, m, me, foe, foeSide, worst, grace) }));
      if (before.some(b => b.effect === 'stops')) return null;
      return { action: a, move: m, order: order.order, ourPriority: order.ourPriority, before };
    }).filter(x => !!x);
  const ko = judged[0];
  if (!ko || (ko.order !== 'ours-first' && !threat)) return result;
  const second = ko.order === 'theirs-first';
  // Their hits that could knock us out before a status move of ours that goes ahead of them. With the order uncertain,
  // a hit that knocks us out only on some rolls is a risk Klefki's case accepted; certainly second, it is not.
  const risky = new Set(second ? ['all-sampled-rolls', 'some-sampled-rolls'] : ['all-sampled-rolls']);
  // Certainly second, their Tera can add up to half again to a hit, as Baxcalibur's Tera Ground Earthquake did to a
  // full-HP Zekrom.
  const knocksUsOut = (name: string) => threat?.damagingMoves.some(t => id(t.move) === id(name) &&
    (risky.has(t.conditionalKO) || (second && teraLeft && t.percentOfMaxHP[1] * 1.5 >= (me.hpPercent ?? 100)))) ?? false;
  /**
   * Whether this status move, going ahead of some of their moves, would get its effect in where the attack would not:
   * one of those moves knocks us out, or stops us moving a quarter of the time or more once it goes before the attack
   * (half as often when that is a speed tie). Icicle Crash's 30% flinch in Klefki's tie was a risk worth taking.
   */
  const beatsThemToIt = (move: Move) => {
    const p = movePriority(s, me, move.name);
    if (p === null) return true;
    if (p <= ko.ourPriority) return false;
    return ko.before.some(b => {
      if (b.priority !== null && b.priority >= p) return false;
      const ahead = second || b.priority === null || b.priority > ko.ourPriority ? 1 : 0.5;
      return knocksUsOut(b.move.name) || (!!b.effect && b.effect !== 'stops' && ahead * b.effect.stills >= 0.25);
    });
  };
  const how = ko.order === 'ours-first' ? 'moves first and knocks' : 'knocks';
  const unless = ko.order === 'ours-first' ? ''
    : second ? `; ${foe.species} moves first, but nothing it could do first saves it, and a hit that knocks ${me.species} out or stops it moving would cost the other move just as much`
    : `, and lands unless ${foe.species} moves first and knocks ${me.species} out or stops it moving, which would cost the other move just as much`;
  // Moving second, the knockout lands only after their action; a Speed boost that makes it land first next turn costs
  // them no extra action and keeps the boost for whatever comes in next. A Dragon Dance on a Pokémon that tanks the
  // faster opponent's hit is that play, and the guard used to take it away whenever the turn order was uncertain.
  const outrunsAfter = (move: Move) => {
    const gain = move.category === 'Status' ? selfStageChanges(me, (move.boosts ?? {}) as Record<string, number>).spe ?? 0
      : speedGain(move.name, me.abilitySuppressed ? '' : me.ability ?? '');
    if (ko.order === 'ours-first' || gain <= 0) return false;
    const faster = { ...me, boosts: { ...me.boosts, spe: Math.min(6, (me.boosts.spe ?? 0) + gain) } };
    return turnOrder(s, faster, ko.move.name)?.order === 'ours-first';
  };
  // An attack that is not itself a certain knockout is the same trade with some damage attached: Rapid Spin over Ice Beam
  // on a 20% Whiscash, Great Tusk's Rapid Spin beside an Earthquake that knocked out a 56% Iron Crown, Flame Charge
  // beside a Flamethrower on a 37% Thundurus. It is held to it only when the knockout costs us nothing the other attack
  // would not: no recoil, no stat drop, no recharge, no lock into the move.
  const clean = !ko.move.recoil && !ko.move.hasCrashDamage && !Object.values(ko.move.self?.boosts ?? {}).some(v => (v ?? 0) < 0) &&
    !['mustrecharge', 'lockedmove'].includes(ko.move.self?.volatileStatus ?? '');
  const alsoKnocksOut = (action: DecisionInput['legalActions'][number], move: Move) => {
    try { return damageRange(s, move.name, action.command.endsWith(' terastallize') ? me.teraType ?? undefined : undefined)?.conditionalKO === 'all-sampled-rolls'; }
    catch { return true; }
  };
  /**
   * Whether the turn a heal hands them is worth less than the heal: of their likely moves (revealed, or in half their
   * sets) that could work, none is a status move, sleep, setup, hazards or a heal of their own, which no HP pays for,
   * and every hit takes less than the heal gives back. Protect gains them nothing but the turn itself.
   */
  const turnWorthLittle = (restores: number) => {
    const likely = plausibleMoves(foe).filter(m => m.revealed || (m.priorProbability ?? 0) >= 0.5).map(m => dex.moves.get(m.move))
      .filter(m => m.exists && !certainFailure(s, m.name, foe, foeSide, me));
    if (likely.some(m => m.category === 'Status' && !m.stallingMove)) return false;
    const hits = (threat?.damagingMoves ?? []).filter(t => t.revealed || (t.priorProbability ?? 0) >= 0.5);
    return Math.max(0, ...hits.map(t => t.percentOfMaxHP[1])) < restores;
  };
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const move = moveOf(action);
    if (!move.exists || move.id === ko.move.id || outrunsAfter(move) || beatsThemToIt(move)) continue;
    if (move.category !== 'Status' && (!clean || alsoKnocksOut(action, move))) continue;
    // A heal that gives back a quarter or more, when the turn it hands them is worth less than that, is the search's to
    // price. Registeel at 45% had Rest, with a Chesto Berry, skipped for Body Press on a 9% Cetitan whose Ice moves it
    // resists, and a judge with Cetitan's real set put Rest 0.089 ahead. In a 10-game audit three of the guard's seven
    // skips were heals, and they carried nearly all of its cost (scripts/divergence.mjs --audit). A Darkrai with Hypnosis
    // is another matter: Gogoat's Milk Drink over a certain Horn Leech (2686983295) handed it the sleep.
    const restores = move.category === 'Status' && me.hpPercent !== null
      ? Math.min(100 - me.hpPercent, move.id === 'rest' ? 100 : healPercentNow(move.name, s.field.weather) ?? 0) : 0;
    if (restores >= 25 && turnWorthLittle(restores)) continue;
    const instead = move.category === 'Status' ? move.name : `${move.name}, which does not knock it out at every roll,`;
    result.set(action.id, { by: 'knockout', prefer: ko.action.id, reason: `${ko.move.name} ${how} ${foe.species} out at every sampled roll, whatever Tera it could choose${unless}, so ${instead} gives up a knockout for a turn the opponent never had to get` });
  }
  return result;
}

/** A healing move at full HP restores nothing, which its own report already says; with Tera it is Tera and a wasted turn. */
export function healAtFullHP(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const ours = s.sides[s.mySide];
  const me = ours.team.find(p => p.id === ours.activeId);
  if (!me || me.fainted || (me.hpPercent ?? 0) < 100) return result;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    const heals = move.exists && move.category === 'Status' && move.target === 'self' && (!!move.heal || ['rest', 'moonlight', 'synthesis', 'morningsun', 'shoreup'].includes(move.id));
    // A heal that also boosts or cures does something at full HP too, so only the pure heals are skipped.
    if (!heals || move.boosts || move.self?.boosts) continue;
    // Nor is a heal idle when a faster opponent hits first: it restores that hit, as the search reckons it.
    if (move.id !== 'rest' && hitBeforeHeal(s, me, s.mySide, move.name)) continue;
    result.set(action.id, { by: 'full', reason: `${me.species} is at full HP, so ${move.name} restores nothing` });
  }
  return result;
}

/** The chance a hit, or two, lands a knockout from `hp`: rolls spread evenly over the range, and each hit can miss. */
function knockoutBefore(range: [number, number], hp: number, accuracy: number, hits: 1 | 2) {
  const [a, b] = range, width = Math.max(b - a, 1e-9);
  const one = hp <= a ? 1 : hp > b ? 0 : (b - hp) / width;
  if (hits === 1) return accuracy * one;
  const t = hp;
  const both = t <= 2 * a ? 1 : t >= 2 * b ? 0 : t <= a + b ? 1 - (t - 2 * a) ** 2 / 2 / width ** 2 : (2 * b - t) ** 2 / 2 / width ** 2;
  return accuracy ** 2 * both + 2 * accuracy * (1 - accuracy) * one;
}

/**
 * A charge move started where it will most likely never fire. With its Power Herb knocked off, Iron Jugulis began
 * Meteor Beam at 77% into a Krookodile whose near-certain Gunk Shot could land twice before it fired, for a hit that
 * Krookodile resists: about a 57% chance of losing the Pokémon for nothing. Jev had chosen to switch.
 *
 * Narrow: the move charges this turn (no Power Herb, no sun or rain to skip it), does not knock the target out at every
 * roll when it fires, and their likely attacks — revealed, or in at least half their sets — knock us out before it fires
 * at least half the time: one hit if we certainly move first, two otherwise, each allowed to miss. A switch must survive
 * its entry.
 */
export function chargeWontFire(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted || me.hpPercent === null) return result;
  const threat = incomingThreats(s, me, side, 8);
  const likely = (threat?.damagingMoves ?? []).filter(m => m.revealed || (m.priorProbability ?? 0) >= 0.5);
  if (!likely.length) return result;
  let escape: boolean | undefined;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    if (!move.exists || !chargesThisTurn(move.name, s.field.weather, me)) continue;
    const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    if (move.category !== 'Status' && damageRange(s, move.name, tera)?.conditionalKO === 'all-sampled-rolls') continue;
    const hits = turnOrder(s, me, move.name)?.order === 'ours-first' ? 1 : 2;
    const worst = likely.map(m => ({ move: m.move, p: knockoutBefore(m.percentOfMaxHP, me.hpPercent ?? 100, (m.accuracyPercent ?? 100) / 100, hits) }))
      .sort((a, b) => b.p - a.p)[0]!;
    if (worst.p < 0.5) continue;
    escape ??= escapable(input);
    if (!escape) return result;
    result.set(action.id, { by: 'charge', reason: `${move.name} spends this turn charging, and ${foe.species}'s ${worst.move} knocks ${me.species} out before it fires about ${Math.round(worst.p * 100)}% of the time (${hits === 1 ? 'one hit' : 'up to two hits'}), for a hit that is no certain knockout` });
  }
  return result;
}

/**
 * Staying in, seeded, against a Pokémon that out-lasts us. Wo-Chien seeded, paralysed and Knocked Off five of our
 * Pokémon in turn while its Leftovers and our own seed healed it a fifth of its HP a turn, and Protect blunted our hits;
 * Arceus Recovered and Calm Minded into it, seeded, until it fell. Leech Seed is cleared only by switching out, and a
 * switch makes the seeder spend a turn seeding again.
 *
 * The exchange is measured rather than guessed. Our damage per turn is our best hit's average, times its accuracy, less a
 * quarter for our paralysis and a third when they have shown Protect, net of what they regain at the end of each turn
 * (Leftovers and our seed included). What we lose per turn is their best revealed hit's average plus our own residual
 * loss, the seed among it. When knocking them out would take more than twice the turns we have left, every move that is
 * neither a certain knockout nor a stall-breaker — Taunt, Encore, Heal Block, or Knock Off while they still hold an item —
 * is skipped, healing and setup among them, provided a switch survives its entry. A pivot move clears the seed too, so it
 * stays open, and a Pokémon under 30% is left to be spent rather than saved.
 */
export function seededAndLosing(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[side], theirs = s.sides[foeSide];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  // A Pokémon with little left is a fair sacrifice rather than one worth a switch to save.
  if (!me || !foe || me.fainted || foe.fainted || me.hpPercent === null || foe.hpPercent === null || me.hpPercent < 30) return result;
  if (!Object.keys(me.volatiles).some(k => id(k) === 'leechseed')) return result;
  const high = (v: number | number[] | undefined) => (Array.isArray(v) ? v[1]! : v ?? 0);
  const low = (v: number | number[] | undefined) => (Array.isArray(v) ? v[0]! : v ?? 0);
  const theirGain = Math.max(0, high(residuals(s, foe, foeSide)?.perTurnPercentOfMaxHP));
  const ourLoss = Math.max(0, -low(residuals(s, me, side)?.perTurnPercentOfMaxHP));
  const revealed = new Set(foe.revealedMoves.map(m => id(m)));
  const hits = (incomingThreats(s, me, side, 8)?.damagingMoves ?? []).filter(m => revealed.has(id(m.move)));
  const theirHit = Math.max(0, ...hits.map(m => (m.percentOfMaxHP[0] + m.percentOfMaxHP[1]) / 2 * (m.accuracyPercent ?? 100) / 100));
  const intake = ourLoss + theirHit;
  if (intake <= 0) return result;
  const protects = foe.revealedMoves.some(m => protectMoves.has(id(m)));
  const moves = input.legalActions.filter(a => a.kind === 'move').map(action => {
    const slot = Number(action.command.split(' ')[1]) - 1;
    const move = dex.moves.get(input.request?.active?.[0]?.moves[slot]?.id ?? action.label.split(' + Tera')[0]!);
    const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
    return { action, move, range: move.exists && move.category !== 'Status' ? damageRange(s, move.name, tera) : null };
  });
  if (moves.some(m => m.range?.conditionalKO === 'all-sampled-rolls')) return result;
  const perTurn = Math.max(0, ...moves.filter(m => m.range).map(m =>
    (m.range!.percentOfMaxHP[0] + m.range!.percentOfMaxHP[1]) / 2 * hitChancePercent(m.move.name, s.field.weather, me, foe) / 100))
    * (me.status === 'par' ? 0.75 : 1) * (protects ? 2 / 3 : 1) - theirGain;
  const toLive = me.hpPercent / intake;
  const toWin = perTurn > 0 ? foe.hpPercent / perTurn : Infinity;
  if (toWin <= 2 * toLive || !escapable(input)) return result;
  const round = (v: number) => Math.round(v * 10) / 10;
  const race = Number.isFinite(toWin) ? `would take ${round(toWin)} turns to knock out` : 'outheals everything we can hit it with';
  for (const { action, move } of moves) {
    // A pivot clears the seed as surely as a switch, and hits on the way out.
    const breaker = stallBreakers.has(move.id) || (move.id === 'knockoff' && foe.item !== '') || !!move.selfSwitch;
    if (!move.exists || breaker) continue;
    result.set(action.id, { by: 'seed', reason: `${me.species} is seeded and loses about ${round(intake)}% a turn, lasting about ${round(toLive)} turns, while ${foe.species} regains ${round(theirGain)}% a turn and ${race}; switching clears the seed` });
  }
  return result;
}

const lowHPMoves = new Set(['endeavor', 'flail', 'reversal']);
const pinchBerries = new Set(['salacberry', 'petayaberry', 'liechiberry', 'ganlonberry', 'apicotberry', 'starfberry']);
/** Whether spending our own HP is what the set is built for. */
function lowHPIsThePlan(me: PokemonState) {
  return [...me.knownMoves, ...me.revealedMoves].some(m => lowHPMoves.has(id(m))) || pinchBerries.has(id(me.item ?? ''));
}

/**
 * Endeavor at high HP, with a Substitute still affordable and certain to go up first. Endeavor takes them down to our
 * HP, so every Substitute before it is worth a quarter of our HP off theirs, and a shell that stands makes the Endeavor
 * behind it safe. Luvdisc used it at 75% on a 94% Snorlax, which fell only to 47%.
 *
 * Narrow: Endeavor is on offer, no Substitute stands, our HP is above the quarter a new one costs, Substitute is legal
 * and certainly moves first, and nothing of theirs gets through a shell. Behind a Substitute, Endeavor is left alone.
 */
export function endeavorTooEarly(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const me = s.sides[side].team.find(p => p.id === s.sides[side].activeId), foe = s.sides[foeSide].team.find(p => p.id === s.sides[foeSide].activeId);
  if (!me || !foe || foe.fainted || hasSubstitute(me) || (me.hpPercent ?? 0) <= 26) return result;
  const sub = input.legalActions.find(a => a.kind === 'move' && !a.command.endsWith(' terastallize') && id(a.label) === 'substitute');
  if (!sub || turnOrder(s, me, 'Substitute')?.order !== 'ours-first') return result;
  if (sampled(foe, 'abilities', ['infiltrator']).length || plausibleMoves(foe).some(m => dex.moves.get(m.move).flags.bypasssub && dex.moves.get(m.move).category !== 'Status' && (m.revealed || (m.priorProbability ?? 0) >= 0.5))) return result;
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || id(action.label.split(' + Tera')[0]!) !== 'endeavor') continue;
    result.set(action.id, { by: 'endeavor', reason: `Endeavor takes ${foe.species} down to our HP, and at ${Math.round(me.hpPercent ?? 0)}% a Substitute that goes up first lowers it by a quarter for nothing; Endeavor is strongest at our lowest HP or from behind a Substitute` });
  }
  return result;
}

/**
 * A replacement sent in to be picked off. Mismagius at 28% came in on a Banette that had used Shadow Sneak twice, and
 * Shadow Sneak knocked it out before it moved; Drifblim and Deoxys went the same way into Palafin's Jet Punch. Four
 * of 404 logged replacements, each a free knockout. A replacement comes in without taking a hit, but priority still
 * lands before it can act on the next turn.
 *
 * Narrow: a forced replacement, a priority attack the opponent has revealed that cannot miss and knocks the candidate
 * out at every sampled roll once entry hazards are counted, and at least one other replacement that survives it.
 */
export function pickedOffOnArrival(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || !input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const foe = s.sides[foeSide].team.find(p => p.id === s.sides[foeSide].activeId);
  if (!foe || foe.fainted) return result;
  // Sucker Punch and Thunderclap fail against a status move, so a replacement can always make them miss.
  const priority = foe.revealedMoves.filter(m => (movePriority(s, foe, m) ?? 0) > 0 && dex.moves.get(m).category !== 'Status'
    && !['suckerpunch', 'thunderclap'].includes(id(m))).map(m => id(m));
  if (!priority.length) return result;
  const targets = input.legalActions.filter(a => a.kind === 'switch').map(a => ({ action: a,
    p: s.sides[side].team.find(p => p.slot === Number(a.command.split(' ')[1])) })).filter(x => x.p && !x.p.fainted);
  const doomedBy = new Map<string, string>();
  for (const { action, p } of targets) {
    let threat; try { threat = incomingThreats(s, p!, side, Infinity); } catch { continue; }
    const kill = threat?.damagingMoves.find(m => priority.includes(id(m.move)) && m.conditionalKO === 'all-sampled-rolls' && m.accuracyPercent === undefined);
    // A replacement with its own priority attack at least as quick may strike first: Wugtrio's Aqua Jet and
    // Mamoswine's Ice Shard both did. Protect only puts the knockout off a turn, so it does not count.
    const quickest = kill ? movePriority(s, foe, kill.move) ?? 1 : 99;
    const answers = p!.knownMoves.some(m => dex.moves.get(m).category !== 'Status' && (movePriority(s, p!, m) ?? 0) >= quickest);
    if (kill && !answers) doomedBy.set(action.id, kill.move);
  }
  if (!doomedBy.size || doomedBy.size === targets.length) return result;
  for (const [actionId, move] of doomedBy) {
    const species = targets.find(t => t.action.id === actionId)!.p!.species;
    result.set(actionId, { by: 'priority', reason: `${foe.species}'s ${move} moves first and knocks ${species} out at every sampled roll once it is in, before it can act; another replacement survives it` });
  }
  return result;
}

/**
 * A heal loop we are losing. Vigoroth, paralysed, used Slack Off six turns running against a Duraludon at 47%: each
 * heal of 50% met a 46% Flash Cannon, a full paralysis turned 51% into 5%, and Duraludon never lost a point
 * (2687868557). Across the logs, 19 runs of three heals or more left the opponent's HP untouched, and we won 5 of
 * them; the statused ones lost ground every time but one.
 *
 * Narrow: our active has already used the same heal twice in a row, is paralysed, poisoned or burned, and what the
 * heal gives back on average (a quarter lost to paralysis, less the poison or burn chip) is less than the least the
 * opponent's strongest revealed attack takes. Rest, which cures the status, is left alone.
 */
export function losingHealLoop(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const me = s.sides[side].team.find(p => p.id === s.sides[side].activeId), foe = s.sides[foeSide].team.find(p => p.id === s.sides[foeSide].activeId);
  if (!me || !foe || me.fainted || foe.fainted || !['par', 'psn', 'tox', 'brn'].includes(me.status ?? '')) return result;
  if ((me.sameMoveStreak ?? 0) < 2 || !me.lastMoveUsed) return result;
  let threat; try { threat = incomingThreats(s, me, side, Infinity); } catch { return result; }
  const hit = Math.max(0, ...(threat?.damagingMoves ?? []).filter(m => m.revealed && m.accuracyPercent === undefined).map(m => m.percentOfMaxHP[0]));
  if (!hit) return result;
  const ability = me.abilitySuppressed ? '' : id(me.ability);
  const chip = me.status === 'tox' ? Math.min(15, (me.toxicTurns ?? 0) + 1) * 6.25 : me.status === 'psn' ? 12.5 : me.status === 'brn' ? 6.25 : 0;
  const lost = ['magicguard', 'poisonheal'].includes(ability) ? 0 : chip;
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const move = dex.moves.get(action.label.split(' + Tera')[0]!);
    if (!move.exists || move.id === 'rest' || id(me.lastMoveUsed) !== move.id) continue;
    const heal = healPercentNow(move.name, s.field.weather);
    if (!heal) continue;
    const gives = (me.status === 'par' ? 0.75 : 1) * heal - lost;
    if (gives >= hit) continue;
    result.set(action.id, { by: 'loop', reason: `${me.species} has used ${move.name} ${me.sameMoveStreak} times running, and while ${me.status === 'par' ? 'paralysed' : me.status === 'brn' ? 'burned' : 'poisoned'} it gives back about ${Math.round(gives)}% a turn against the ${Math.round(hit)}% ${foe.species}'s revealed attack takes at least: the loop loses ground every turn, so attack or switch while there is HP to do it with` });
  }
  return result;
}

/**
 * Switching a healthier Pokémon into the hit that was about to knock out a weak one. Poliwrath at 23% faced a Flamigo
 * that had shown Close Combat; Baxcalibur came in at 57% to take it, fell to 8%, fainted next turn, and Poliwrath came
 * back to faint anyway (2687729196). Left in, Poliwrath is the only loss, and whatever replaces it comes in free.
 *
 * Narrow: a revealed attack that cannot miss knocks our active out at every sampled roll. Only a switch whose Pokémon,
 * after entry hazards, loses more HP to every such attack than switching saves (our active's HP, plus Regenerator's
 * third), and at least half of its own (or a fifth of a bar, when our active is at 35% or less), is skipped. A switch-in
 * that resists or is immune stays open, and a healthy active is never sacrificed this way, since nothing loses more.
 */
export function savingTheDoomed(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const me = s.sides[side].team.find(p => p.id === s.sides[side].activeId), foe = s.sides[foeSide].team.find(p => p.id === s.sides[foeSide].activeId);
  if (!me || !foe || me.fainted || foe.fainted || me.hpPercent === null) return result;
  // What leaving saves: the HP our active keeps, plus Regenerator's third. Cleared stat drops or effects are worth
  // something only to a Pokémon that survives, which is the very thing the switch-in pays for: Poliwrath's -1 Defense
  // going away was no reason to feed Baxcalibur to Close Combat.
  const saved = me.hpPercent + (switchRelief(s, me, side)?.regeneratorHealsPercentOfMaxHP ?? 0);
  let staying; try { staying = incomingThreats(s, me, side, Infinity); } catch { return result; }
  const doom = (staying?.damagingMoves ?? []).filter(m => m.revealed && m.conditionalKO === 'all-sampled-rolls' &&
    m.accuracyPercent === undefined && !m.substitute).map(m => m.move);
  if (!doom.length) return result;
  for (const action of input.legalActions) {
    if (action.kind !== 'switch') continue;
    const target = s.sides[side].team.find(p => p.slot === Number(action.command.split(' ')[1]));
    if (!target || target.fainted) continue;
    let threat; try { threat = incomingThreats(s, target, side, Infinity); } catch { continue; }
    const arriving = afterEntry(s, target, side).hpPercent ?? target.hpPercent ?? 100;
    // Every attack that dooms our active must cost the switch-in dearly: the opponent picks which.
    const losses = doom.map(move => {
      const hit = threat?.damagingMoves.find(m => id(m.move) === id(move));
      return hit && !hit.takesNothingBecauseOfOurAbility ? Math.min(arriving, hit.percentOfMaxHP[0]) : 0;
    });
    const least = Math.min(...losses);
    // A switch-in that loses half of what it has is always too dear. For an active at 35% or less, a fifth of a bar is:
    // Iron Leaves at 3%, doomed by Aura Wheel, was switched out to a Quaquaval that lost 26%, and came back next turn
    // to faint anyway, while each switch fed Morpeko a Speed boost (2687786966).
    const dear = least >= arriving / 2 || (me.hpPercent <= 35 && least >= 20);
    if (least <= saved || !dear) continue;
    result.set(action.id, { by: 'sack', reason: `${foe.species}'s ${doom.join(' or ')} knocks ${me.species} (${Math.round(me.hpPercent)}%) out at every sampled roll, and ${target.species} would lose at least ${Math.round(least)}% of its ${Math.round(arriving)}% taking it instead: more than switching saves, so let ${me.species} go and bring the next Pokémon in free` });
  }
  return result;
}

/**
 * Another Substitute straight after the same opponent broke the last one, into a hit that breaks this one too. Search
 * scores a standing Substitute as worth three quarters of a full HP bar, so it chose one turn after turn: Suicune put up
 * four into a +4 Florges's Moonblast, 100% down to 24%, and Darkrai three into Rhyperior's Earthquake, 79% down to 23%,
 * then fainted. All five repeats in the logs broke again the same turn.
 *
 * Narrow: our last move was Substitute, none stands now, the pairing is the one that broke it, and the opponent's best
 * sampled hit is at least the new shell's HP. A first Substitute is left alone, since it can scout or block a status
 * move, and a Tera version is left to judgement, since the new type may be what lets the shell hold.
 */
export function futileSubstitute(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const me = s.sides[side].team.find(p => p.id === s.sides[side].activeId), foe = s.sides[foeSide].team.find(p => p.id === s.sides[foeSide].activeId);
  if (!me || !foe || foe.fainted || id(me.lastMoveUsed ?? '') !== 'substitute' || hasSubstitute(me)) return result;
  const met = s.matchup;
  if (!met || met[side] !== me.id || met[foeSide] !== foe.id || met.sinceTurn >= s.turn) return result;
  const plan = substitutePlan(s, me, side, 'Substitute');
  if (!plan || plan.shellSurvivesThatHit !== false) return result;
  // A broken shell is the point when our own HP is the weapon: Endeavor, Flail and Reversal grow as it falls, and a
  // pinch berry waits for it. Luvdisc, denied a second Substitute at 75%, used Endeavor there and took a 94% Snorlax
  // only to 47%, then fell to Body Slam.
  if (lowHPIsThePlan(me)) return result;
  // Against a Pokémon losing HP every turn, the loop is a race rather than a waste: each shell costs a quarter, our own
  // end-of-turn recovery refunds most of it, and the shell takes a hit that would otherwise land on us. Serperior,
  // with Leftovers and Leech Seed on Vespiquen, lost 3.8% a cycle while Vespiquen lost 12.5%; at 49% against 27% the
  // guard switched it out and Vespiquen Roosted back to 77% (2687219758). Each shell needs more than a quarter of max HP.
  // A range (an unknown item, say) is taken at its cautious end: our smaller gain, their smaller loss.
  const perTurn = (p: PokemonState, sideOf: SideId) => { const v = residuals(s, p, sideOf)?.perTurnPercentOfMaxHP ?? 0; return typeof v === 'number' ? [v, v] : v; };
  const ourGain = Math.min(...perTurn(me, side)), theirLoss = -Math.max(...perTurn(foe, foeSide));
  if (theirLoss > 0 && me.hpPercent !== null && foe.hpPercent !== null && me.hpPercent > 25) {
    const cost = 25 - ourGain;
    const shells = cost <= 0 ? Infinity : Math.floor((me.hpPercent - 25) / cost) + 1;
    if (shells >= Math.ceil(foe.hpPercent / theirLoss)) return result;
  }
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || action.command.endsWith(' terastallize') || id(action.label) !== 'substitute') continue;
    result.set(action.id, { by: 'substitute', reason: `${foe.species} broke ${me.species}'s last Substitute, and its best sampled hit, ${plan.theirBestSampledHitDeals} HP, breaks a ${plan.substituteHP}-HP shell again, so another only spends a quarter of our HP` });
  }
  return result;
}

/**
 * A status move where the opponent moves first with a revealed attack that knocks us out at every sampled roll: the
 * heal, boost or status never happens. Replayed over the logs, 14 status moves were chosen that way, and in 8 the user
 * fainted before acting. Search's weights on heals and boosts make this its habit.
 *
 * Narrow: a status move, not an attack, because an attack that might still land is a sacrifice left to judgement; turn
 * order is theirs-first for it; a revealed attack of theirs knocks us out at every sampled roll; and some switch
 * survives its entry. Only revealed knockout moves count, since with sampled ones alone 9 of 13 users acted. A Tera
 * version is left alone when that Tera stops the knockout.
 */
export function statusIntoKnockout(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const me = s.sides[side].team.find(p => p.id === s.sides[side].activeId), foe = s.sides[foeSide].team.find(p => p.id === s.sides[foeSide].activeId);
  if (!me || !foe || me.fainted || foe.fainted || !escapable(input)) return result;
  const killers = (incomingThreats(s, me, side, Infinity)?.damagingMoves ?? []).filter(m => m.revealed && m.conditionalKO === 'all-sampled-rolls');
  if (!killers.length) return result;
  const tera = input.request?.active?.[0]?.canTerastallize;
  const saved = tera ? defensiveTera(s, me, side, tera) : null;
  const teraSaves = !!saved && (saved.stopsItFromKnockingUsOut || killers.every(k => saved.stopsTheseFromKnockingUsOut?.includes(k.move)));
  const named = killers.map(k => k.move).join(' or ');
  for (const action of input.legalActions) {
    if (action.kind !== 'move') continue;
    const move = dex.moves.get(action.label.split(' + Tera')[0]!);
    if (!move.exists || move.category !== 'Status' || (action.command.endsWith(' terastallize') && teraSaves)) continue;
    if (turnOrder(s, me, move.name)?.order !== 'theirs-first') continue;
    result.set(action.id, { by: 'order', reason: `${foe.species} moves first and its revealed ${named} knocks ${me.species} out at every sampled roll, so ${move.name} never happens; a switch survives the hit` });
  }
  return result;
}

/**
 * Knocking out a Pokémon whose Destiny Bond is still up, while we move first, faints ours with it. Froslass bonded as
 * Houndoom knocked it out. The bond ends the moment its user next tries to move and cannot be used twice in a row, so
 * one turn that does not knock it out defuses it.
 *
 * Narrow: the bond is up now, the knockout moves first and so certainly meets it, something else is on offer that does
 * not knock it out, our Pokémon is not going down to their next hit anyway, and it is not their last Pokémon, whose
 * loss ends the game whatever happens to ours. The bond not yet used is a judgement left to the payload's warning.
 */
export function destinyBondTrade(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const me = s.sides[side].team.find(p => p.id === s.sides[side].activeId), foe = s.sides[foeSide].team.find(p => p.id === s.sides[foeSide].activeId);
  if (!me || !foe || me.fainted || foe.fainted || !Object.keys(foe.volatiles).some(k => id(k) === 'destinybond')) return result;
  const left = remainingPokemon(s.sides[foeSide]);
  if (left !== null && left <= 1) return result;
  if (incomingThreats(s, me, side, Infinity)?.conditionalKO === 'all-sampled-rolls') return result;
  const tera = input.request?.active?.[0]?.canTerastallize;
  const trades = input.legalActions.filter(a => {
    if (a.kind !== 'move') return false;
    const move = dex.moves.get(a.label.split(' + Tera')[0]!);
    if (!move.exists || move.category === 'Status') return false;
    const withTera = a.command.endsWith(' terastallize') ? tera : undefined;
    const ko = damageRange(s, move.name, withTera)?.conditionalKO;
    return ko !== undefined && ko !== 'none-sampled' && turnOrder(s, me, move.name)?.order === 'ours-first';
  });
  if (!trades.length || trades.length === input.legalActions.length) return result;
  for (const action of trades) {
    result.set(action.id, { by: 'destinybond', reason: `${foe.species}'s Destiny Bond is up and ${action.label.split(' + Tera')[0]} moves first and can knock it out, so ${me.species} would faint with it; the bond ends when ${foe.species} next moves and cannot be used twice running, so one turn without the knockout defuses it` });
  }
  return result;
}

/**
 * A pivot that brings in a teammate the opponent then knocks out on arrival throws away that teammate's turn. Coming in
 * after our active fainted instead, it would enter for free and act first against a slower opponent. Flamigo U-turned
 * three times into a last Glastrier, and Garganacl, Mesprit and Magnezone each came in, took Icicle Crash without
 * acting and fed Chilling Neigh; all three outsped Glastrier and could have hit it (2687217753).
 *
 * Narrow: the pivot goes first, every teammate that could come in is knocked out on arrival at every sampled roll by a
 * revealed or likely attack (or by our hazards), and we have an attack that damages the target instead. If staying in
 * would not knock us out, the pivot only costs a teammate. If it would, the pivot is skipped only when some teammate
 * outspeeds every sampled set and so acts after a free switch; against a faster opponent the pivot's chip is all anyone
 * gets, and preserving the active can be right.
 */
export function pivotIntoKnockout(input: DecisionInput) {
  const result = new Map<string, { by: string; reason: string }>();
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
  const side = s.mySide, ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted) return result;
  const moveOf = (action: DecisionInput['legalActions'][number]) => dex.moves.get(action.label.split(' + Tera')[0]!);
  const pivots = input.legalActions.filter(a => a.kind === 'move' && moveOf(a).selfSwitch === true && moveOf(a).category !== 'Status');
  if (!pivots.length) return result;
  const bench = ours.team.filter(p => !p.fainted && p.id !== me.id);
  if (!bench.length) return result;
  const doomed = bench.every(p => {
    const threat = incomingThreats(s, p, side, Infinity);
    return !!threat && (threat.knockedOutByHazards ||
      threat.damagingMoves.some(m => (m.revealed || (m.priorProbability ?? 0) >= 0.5) && m.conditionalKO === 'all-sampled-rolls'));
  });
  if (!doomed) return result;
  const likelyKO = (threat: ReturnType<typeof incomingThreats>) => !!threat &&
    threat.damagingMoves.some(m => (m.revealed || (m.priorProbability ?? 0) >= 0.5) && m.conditionalKO === 'all-sampled-rolls');
  if (likelyKO(incomingThreats(s, me, side, Infinity))) {
    const sets = inferOpponent(foe).candidates;
    const theirSpeeds = (sets.length ? sets : [undefined]).map(c => effectiveSpeed(s, foe, side === 'p1' ? 'p2' : 'p1', c));
    const outspeeds = (p: PokemonState) => { const v = effectiveSpeed(s, p, side); return v !== null && theirSpeeds.every(t => t !== null && (s.field.trickRoom ? v < t : v > t)); };
    if (!bench.some(outspeeds)) return result;
  }
  const attack = input.legalActions.find(a => a.kind === 'move' && !moveOf(a).selfSwitch && moveOf(a).category !== 'Status' &&
    (damageRange(s, moveOf(a).name)?.percentOfMaxHP[1] ?? 0) > 0);
  if (!attack) return result;
  for (const action of pivots) {
    const move = moveOf(action);
    if (turnOrder(s, me, move.name)?.order !== 'ours-first') continue;
    result.set(action.id, { by: 'pivot', reason: `every teammate ${move.name} could bring in is knocked out by ${foe.species} on arrival, before it acts; ${attack.label} hits now instead, and a teammate that comes in after ${me.species} falls enters free` });
  }
  return result;
}

/**
 * The rules as they stood before audit-v12 and audit-v13, kept only so the self-play bench can play them against the
 * current ones: every heal at full HP skipped, and every move of a sleeper that cannot wake skipped when it has no
 * Sleep Talk or Snore. Not in GUARDS; the bench adds them by name with `extraGuards`.
 */
export const LEGACY_GUARDS: Record<string, (input: DecisionInput) => Map<string, { by: string; reason: string }>> = {
  legacyHealAtFullHP(input: DecisionInput) {
    const result = new Map<string, { by: string; reason: string }>();
    const s = input.state;
    if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
    const me = s.sides[s.mySide].team.find(p => p.id === s.sides[s.mySide!].activeId);
    if (!me || me.fainted || (me.hpPercent ?? 0) < 100) return result;
    for (const action of input.legalActions) {
      if (action.kind !== 'move') continue;
      const move = dex.moves.get(action.label.split(' + Tera')[0]!);
      const heals = move.exists && move.category === 'Status' && move.target === 'self' && (!!move.heal || ['rest', 'moonlight', 'synthesis', 'morningsun', 'shoreup'].includes(move.id));
      if (heals && !move.boosts && !move.self?.boosts) result.set(action.id, { by: 'full', reason: `legacy: ${move.name} at full HP` });
    }
    return result;
  },
  legacySleepSkip(input: DecisionInput) {
    const result = new Map<string, { by: string; reason: string }>();
    const s = input.state;
    if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return result;
    const me = s.sides[s.mySide].team.find(p => p.id === s.sides[s.mySide!].activeId);
    if (!me || me.fainted || me.status !== 'slp' || wakeChance(me) !== 0) return result;
    if (input.legalActions.some(a => a.kind === 'move' && ['sleeptalk', 'snore'].includes(id(a.label.split(' + Tera')[0]!)))) return result;
    for (const action of input.legalActions) if (action.kind === 'move') result.set(action.id, { by: 'sleep', reason: 'legacy: asleep and cannot wake' });
    return result;
  },
};
