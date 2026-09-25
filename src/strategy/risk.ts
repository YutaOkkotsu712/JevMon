import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { typeEffectiveness, pokemonTypes } from '../pokemon/mechanics.js';
import { inferOpponent } from './inference.js';
import { dex, id } from '../pokemon/data.js';
import { sampled } from './sampled.js';
import { plausibleMoves } from './setPriors.js';
import { movePriority, speedSummary } from './speed.js';

const has = (p: PokemonState, volatile: string) => Object.keys(p.volatiles).some(k => id(k) === volatile);

/**
 * The chance a Pokémon simply loses its turn to the status it is carrying. Every projection elsewhere assumes
 * the move happens; this is the probability that it does not, which is what makes staying in on a paralysed
 * Pokémon a gamble rather than a plan.
 *
 * Sleep is the one that narrows with evidence. Gen 9 sleep costs one to three turns, chosen when it lands, so
 * each turn already lost rules out a duration: the first attempt never wakes, and after three lost turns the next
 * always does. Rest is exactly two turns and is not a gamble at all.
 */
/**
 * The moves Sleep Talk can call for a sleeping Pokémon, from what it knows (ours) or has shown (theirs). Sleep Talk
 * does not call itself, and Rest fails while the user is already asleep. Suicune with Calm Mind, Scald, Rest and Sleep
 * Talk kept acting through its sleep, boosting a third of the time and attacking a third.
 */
export function sleepTalkMoves(p: PokemonState) {
  const moves = (p.knownMoves.length ? p.knownMoves : p.revealedMoves).map(m => dex.moves.get(m)).filter(m => m.exists);
  if (!moves.some(m => m.id === 'sleeptalk')) return null;
  const picks = moves.filter(m => m.id !== 'sleeptalk' && !m.flags.nosleeptalk && !m.flags.charge);
  return { picks: picks.map(m => m.name), restFailsWhileAsleep: picks.some(m => m.id === 'rest'),
    ...(!p.knownMoves.length && moves.length < 4 ? { plusMovesNotYetRevealed: true } : {}) };
}
/** Sleep turns still to come and the chance it wakes this turn, shared by the risk and the switch-turn read. */
export function wakeChance(p: PokemonState) {
  const lost = p.sleepTurns ?? 0;
  // The counter is set to two to four when sleep lands and falls by one before each check, so one to three turns are
  // lost and the first attempt never wakes: a third wake on the second, half the rest on the third, all on the fourth.
  // Cacturne, slept by Yawn and sent back in against a 26% Magearna, was given a 33% chance to Sucker Punch it on its
  // first attempt; it had none. Early Bird takes two off each time. Rest is a fixed two turns.
  if (p.sleepFromRest) return lost >= 2 ? 1 : 0;
  if (!p.abilitySuppressed && id(p.ability) === 'earlybird') return lost >= 1 ? 1 : 1 / 3;
  return lost === 0 ? 0 : lost >= 3 ? 1 : 1 / (4 - lost);
}
/**
 * At most how likely a sleeping opponent is to use `moveName` this turn: if it wakes it may choose anything, and while
 * asleep only Sleep Talk's random pick can bring it. A sleeper without Sleep Talk that cannot wake gives a free turn.
 */
export function asleepChanceOfMove(p: PokemonState, moveName: string) {
  if (p.status !== 'slp' || p.fainted) return null;
  const wake = wakeChance(p), talk = sleepTalkMoves(p), target = dex.moves.get(moveName).id;
  let picked: number;
  if (p.knownMoves.length) {
    picked = talk && talk.picks.includes(dex.moves.get(moveName).name) ? 1 / talk.picks.length : 0;
  } else {
    // Revealed moves are not the whole Sleep Talk pool. Weigh each compatible full set, whether Sleep Talk has been
    // shown yet or not, so one revealed Rest is not treated as half the pool when two moves are still hidden.
    const sets = inferOpponent(p).candidates, mass = sets.reduce((n, c) => n + c.probability, 0);
    picked = mass > 0 ? sets.reduce((n, c) => {
      if (!c.moves.includes('sleeptalk')) return n;
      const picks = c.moves.filter(m => m !== 'sleeptalk' && !dex.moves.get(m).flags.nosleeptalk && !dex.moves.get(m).flags.charge);
      return n + (picks.includes(target) ? c.probability / picks.length : 0);
    }, 0) / mass : talk && talk.picks.includes(dex.moves.get(moveName).name)
      ? 1 / (talk.picks.length + (talk.plusMovesNotYetRevealed ? Math.max(0, 4 - p.revealedMoves.length) : 0)) : 0;
  }
  return Math.round((wake + (1 - wake) * picked) * 1000) / 10;
}
/** For an opponent that has not shown Sleep Talk, the share of its still-possible sets that carry it. */
export function sleepTalkProbability(p: PokemonState) {
  if (sleepTalkMoves(p)) return 1;
  if (p.knownMoves.length) return 0;
  const sets = inferOpponent(p).candidates, mass = sets.reduce((n, c) => n + c.probability, 0);
  return mass > 0 ? sets.reduce((n, c) => n + (c.moves.includes('sleeptalk') ? c.probability : 0), 0) / mass : 0;
}

export function statusRisk(p: PokemonState, turn?: number) {
  if (p.fainted) return null;
  // Truant allows every other turn, and which one is public: a Pokémon that acted last turn loafs this one.
  // That is a certainty rather than a roll, so it is stated as a schedule and never as a gamble.
  const truant = turn === undefined ? undefined : sampled(p, 'abilities', ['truant'])[0];
  const loafs = !!truant && typeof p.lastActedTurn === 'number' && p.lastActedTurn === turn! - 1;
  const confused = has(p, 'confusion');
  const parts: { source: string; chanceItLosesTheTurnPercent: number; note?: string }[] = [];
  if (p.status === 'par') parts.push({ source: 'paralysis', chanceItLosesTheTurnPercent: 25, note: 'speed is also halved in Gen 9' });
  if (p.status === 'frz') parts.push({ source: 'freeze', chanceItLosesTheTurnPercent: 80, note: 'a 20% thaw each turn, and a fire move thaws it immediately' });
  let sleep: Record<string, unknown> | undefined;
  if (p.status === 'slp') {
    const lost = p.sleepTurns ?? 0, wake = wakeChance(p), talk = sleepTalkMoves(p);
    // With Sleep Talk the turn is not lost, only its move is random; unshown, it is weighed by the sets still possible.
    const maybe = talk ? 1 : sleepTalkProbability(p);
    const loses = Math.round((1 - wake) * (1 - maybe) * 1000) / 10;
    if (!talk && loses > 0) parts.push({ source: 'sleep', chanceItLosesTheTurnPercent: loses });
    sleep = { turnsAlreadyLostToSleep: lost, chanceItWakesAndMovesThisTurnPercent: Math.round(wake * 1000) / 10,
      ...(talk ? { actsThroughSleepTalk: talk } : maybe > 0 ? { mayHaveSleepTalkPercent: Math.round(maybe * 1000) / 10 } : {}),
      ...(p.sleepFromRest ? { fromRest: true, why: 'Rest sleeps for exactly two turns, so this is certain rather than a gamble' }
        : { why: 'sleep costs one to three turns, fixed when it landed: the first attempt never wakes, and every turn already lost rules out a shorter duration' }) };
  }
  if (confused) parts.push({ source: 'confusion', chanceItLosesTheTurnPercent: 33.3, note: 'a self-hit instead of the move, and it wears off after two to five turns' });
  // Recharging after Hyper Beam or Giga Impact is certain, and it is the same turn a Truant user would loaf.
  const recharging = has(p, 'mustrecharge');
  if (recharging) parts.push({ source: 'recharge', chanceItLosesTheTurnPercent: 100, note: 'it used a recharge move last turn, so this turn is lost for certain' });
  if (loafs && !recharging) parts.push({ source: 'Truant', chanceItLosesTheTurnPercent: Math.round((truant!.probability ?? 1) * 1000) / 10, note: 'it acted last turn, and Truant allows only every other turn' });
  const schedule = truant ? { truant: loafs ? 'loafs this turn, acts next turn' : 'acts this turn, loafs next turn' } : {};
  if (!parts.length) return truant || sleep ? { sources: parts, chanceItActsAtAllPercent: 100, ...schedule, ...(sleep ? { sleep } : {}), thisIsAGambleNotAPlan: false } : null;
  // Independent rolls, so the chance of acting is the product of surviving each one.
  const acts = parts.reduce((n, x) => n * (1 - x.chanceItLosesTheTurnPercent / 100), 1);
  return { sources: parts, chanceItActsAtAllPercent: Math.round(acts * 1000) / 10,
    ...(sleep ? { sleep } : {}), ...schedule,
    thisIsAGambleNotAPlan: acts < 0.9 && !recharging && !(loafs && truant!.probability === 1) };
}

/** Items the target is rewarded for being hit by, which turn a good attack into a bad trade. */
const rewards: Record<string, { needs: 'super-effective' | 'contact'; gain: string }> = {
  weaknesspolicy: { needs: 'super-effective', gain: '+2 Attack and +2 Special Attack' },
  rockyhelmet: { needs: 'contact', gain: 'a sixth of our max HP back at us' },
};

/**
 * Whether this attack pays the target for landing. Weakness Policy is the sharp case: a super-effective hit
 * that does not knock the holder out hands it +2/+2 and usually the game, so it is worth knowing before the
 * hit rather than after. The item is rarely known outright, so it is reported with its sampled frequency.
 */
export function activatesTheirItem(s: BattleState, side: SideId, moveName: string, teraType?: string, me?: PokemonState) {
  const move = dex.moves.get(moveName);
  const theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const target = theirs.team.find(p => p.id === theirs.activeId);
  if (!move.exists || !target || target.fainted || move.category === 'Status') return null;
  const type = teraType && dex.types.get(teraType).exists ? teraType : move.type;
  const effectiveness = typeEffectiveness(type, pokemonTypes(target));
  const out: { item: string; probability: number; itIsKnown: boolean; theyGain: string; why: string }[] = [];
  const known = target.item !== null ? id(target.item) : null;
  const candidates = inferOpponent(target).candidates;
  const mass = candidates.reduce((n, c) => n + c.probability, 0);
  for (const [key, spec] of Object.entries(rewards)) {
    if (spec.needs === 'super-effective' && !(effectiveness !== null && effectiveness > 1)) continue;
    if (spec.needs === 'contact' && !move.flags.contact) continue;
    const probability = known !== null ? (known === key ? 1 : 0)
      : mass > 0 ? candidates.filter(c => id(c.item) === key).reduce((n, c) => n + c.probability, 0) / mass : 0;
    if (probability <= 0) continue;
    // Rocky Helmet is a number, not a warning: a sixth of our own max HP for every contact move we throw.
    const ourMax = me?.exactHP?.max ?? null;
    const helmet = key === 'rockyhelmet';
    out.push({ item: dex.items.get(key).name, probability: Math.round(probability * 1000) / 1000, itIsKnown: known !== null,
      theyGain: spec.gain,
      ...(helmet ? { costsUsPercentOfMaxHP: Math.round(100 / 6 * 10) / 10,
        ...(ourMax ? { costsUsHP: Math.floor(ourMax / 6) } : {}) } : {}),
      why: spec.needs === 'super-effective'
        ? 'it triggers on a super-effective hit that the holder survives, so it is only paid if this does not knock them out'
        : 'it triggers on every contact move, whether or not the holder survives, so it is paid again on each one' });
  }
  // A Weakness Policy is not paid when the hit knocks the holder out; Rocky Helmet always is.
  return out.length ? { pays: out, weaknessPolicyNotPaidIfTheAttackKnocksThemOut: true } : null;
}

/** A surviving Sitrus holder can heal during our hit, then Harvest can grow and eat it again that turn. */
export function berryRecoveryAfterHit(s: BattleState, target: PokemonState, damagePercent: [number, number]) {
  const hp = target.hpPercent;
  if (id(target.item) !== 'sitrusberry' || hp === null || hp <= 50 || damagePercent[1] <= 0 ||
      damagePercent[0] >= hp || hp - damagePercent[1] > 50) return null;
  const round = (n: number) => Math.round(n * 10) / 10;
  const survivingHP: [number, number] = [Math.max(0.1, hp - damagePercent[1]), Math.min(50, hp - damagePercent[0])];
  const afterFirst: [number, number] = [round(survivingHP[0] + 25), round(Math.min(100, survivingHP[1] + 25))];
  const harvest = sampled(target, 'abilities', ['harvest'])[0]?.probability ?? 0;
  const sun = ['SunnyDay', 'DesolateLand'].includes(s.field.weather ?? '');
  const regrow = Math.round(harvest * (sun ? 100 : 50) * 10) / 10;
  const second = afterFirst[0] <= 50 && regrow > 0;
  return { triggersIfTheHitLeavesThemAtOrBelowHalfHP: true, onlyIfTheySurviveTheHit: true,
    firstBerryHealsPercentOfMaxHP: 25, hpAfterFirstBerryPercentRange: afterFirst,
    ...(regrow > 0 ? { harvestRegrowsBerryAtEndOfTurnPercent: regrow } : {}),
    ...(second ? { canEatRegrownBerryThisTurn: true,
      hpAfterSecondBerryPercentRange: [round(afterFirst[0] + 25), round(Math.min(75, afterFirst[1] + 25))] } : {}) };
}

/**
 * Flinching costs a turn as surely as paralysis, but only when the flincher moves first. Registeel paralysed us,
 * which halves Speed, then outsped Gothitelle, Lokix and Ariados with Iron Head's 30% flinch; they lost most of
 * their turns while Leftovers healed it, and Lokix chose a U-turn that was lost three times running. The chance is
 * conditional on their using the move, so each move is named. A switch happens before any move and cannot be lost.
 */
export function flinchRisk(s: BattleState, me: PokemonState, side: SideId) {
  const theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!foe || foe.fainted || me.fainted) return null;
  const ability = me.abilitySuppressed ? '' : id(me.ability);
  if (['innerfocus', 'shielddust'].includes(ability) || id(me.item) === 'covertcloak') return null;
  const speed = speedSummary(s, me), order = 'ifEqualPriority' in speed ? speed.ifEqualPriority : 'uncertain';
  const grace = sampled(foe, 'abilities', ['serenegrace'])[0];
  const doubled = grace?.probability === 1;
  const moves = plausibleMoves(foe).flatMap(m => {
    const move = dex.moves.get(m.move);
    const chance = move.secondaries?.find(e => e.volatileStatus === 'flinch')?.chance;
    // Fake Out only works on the user's first turn out.
    if (!chance || (move.id === 'fakeout' && foe.activeSinceTurn !== s.turn - 1)) return [];
    const first = (movePriority(s, foe, move.name) ?? move.priority) > 0 ? 'yes' : order === 'theirs-first' ? 'yes' : order === 'ours-first' ? 'no' : 'uncertain';
    if (first === 'no') return [];
    return [{ move: move.name, flinchChancePercent: Math.min(100, chance * (doubled ? 2 : 1)), revealed: m.revealed,
      ...(first === 'uncertain' ? { onlyIfTheyMoveFirst: true } : {}) }];
  });
  if (!moves.length) return null;
  const worst = Math.max(...moves.map(m => m.flinchChancePercent));
  const paralysed = me.status === 'par' ? 0.75 : 1;
  return { moves: moves.slice(0, 3), ifTheyUseTheWorstWeActPercent: Math.round((1 - worst / 100) * paralysed * 1000) / 10,
    ...(grace && !doubled ? { sereneGraceDoublesItWithProbability: grace.probability } : {}),
    aSwitchCannotBeLost: true };
}
