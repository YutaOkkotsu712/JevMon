import type { BattleState, PokemonState, SideId, SwitchRecord } from '../battle/BattleState.js';
import { accumulate, dedupeCandidates, scenario, supportedMove } from './calcCore.js';
import { inferOpponent } from './inference.js';
import { plausibleMoves } from './setPriors.js';
import { pokemonTypes } from '../pokemon/mechanics.js';
import { dex, id } from '../pokemon/data.js';
import { behindSubstitute, intimidated, intimidateResponse } from './intimidate.js';

/** One attack against one specific Pokémon, over the sampled sets of whichever side is hidden. */
function against(s: BattleState, attacker: PokemonState, defender: PokemonState, side: SideId,
  moveName: string, attackerSet?: ReturnType<typeof dedupeCandidates>[number], defenderSets?: ReturnType<typeof dedupeCandidates>,
  attackerFor?: (defenderSet: ReturnType<typeof dedupeCandidates>[number] | undefined) => PokemonState) {
  const move = dex.moves.get(moveName);
  if (!move.exists || move.category === 'Status' || !supportedMove(move.name)) return null;
  const rolls = [];
  let maxHP = 0, attempted = 0;
  for (const d of defenderSets?.length ? defenderSets : [undefined]) {
    attempted += (attackerSet?.probability ?? 1) * (d?.probability ?? 1);
    const r = scenario(s, attackerFor ? attackerFor(d) : attacker, defender, side, move.name, attackerSet, d);
    if (r) { rolls.push({ ...r, probability: (attackerSet?.probability ?? 1) * (d?.probability ?? 1) }); maxHP = r.defenderMaxHP; }
  }
  return accumulate(rolls, defender, maxHP, attempted);
}

/**
 * What each of our moves does to one opposing Pokémon arriving on the field. An arriving Intimidate lands before
 * our move, so the hit on it comes from our lowered Attack, set by set.
 */
function ourDamageInto(s: BattleState, me: PokemonState, ourSide: SideId, foe: PokemonState, usable: string[]) {
  const sets = dedupeCandidates(inferOpponent(foe).candidates);
  const intimidating = (d: (typeof sets)[number] | undefined) => id(foe.ability ?? d?.ability) === 'intimidate';
  const ourResponse = intimidateResponse(me.abilitySuppressed ? '' : me.ability ?? '', me.item ?? '', behindSubstitute(me));
  const lowered = intimidated(me, ourResponse);
  // Their Pokémon is arriving, so our Stakeout, if we have it, doubles the hit it takes coming in.
  const attackerFor = (d: (typeof sets)[number] | undefined) => ({ ...(intimidating(d) ? lowered : me), stakeoutActive: true });
  const mass = sets.reduce((n, c) => n + c.probability, 0);
  const intimidateShare = foe.ability !== null ? (intimidating(undefined) ? 1 : 0)
    : mass > 0 ? Math.round(sets.filter(intimidating).reduce((n, c) => n + c.probability, 0) / mass * 1000) / 1000 : 0;
  const ourDamage: Record<string, { percentOfItsMaxHP: [number, number]; conditionalKO?: string }> = {};
  let bestAnswer: { move: string; percent: number; ko: boolean } | null = null;
  for (const name of usable) {
    const r = against(s, me, foe, ourSide, name, undefined, sets, attackerFor);
    if (!r) continue;
    const ko = r.conditionalKO === 'all-sampled-rolls';
    ourDamage[dex.moves.get(name).name] = { percentOfItsMaxHP: r.percentOfMaxHP,
      ...(r.conditionalKO ? { conditionalKO: r.conditionalKO } : {}) };
    if (!bestAnswer || r.percentOfMaxHP[1] > bestAnswer.percent) bestAnswer = { move: dex.moves.get(name).name, percent: r.percentOfMaxHP[1], ko };
  }
  return { ourDamage, bestAnswer, intimidateShare, ourResponse };
}

/**
 * What the opponent has actually done with its switches, which is evidence rather than a matchup ranking. Against
 * Rotom-Heat it swapped Dewgong and Excadrill on four turns running, each one taking the attack the other was weak
 * to — Excadrill the Electric moves, Thick Fat Dewgong the Overheat — while two Overheats cut our Special Attack to
 * -4. The arrival it has chosen before from the Pokémon now out is what our move is likeliest to land on, so its
 * damage is priced here, where the minimal payload still carries it. Our own run of switches is counted too: when
 * both sides keep switching, every one of our entries pays a hit and nothing is attacked.
 */
export function switchingPattern(s: BattleState, me: PokemonState, ourSide: SideId, moves: string[]) {
  const theirSide: SideId = ourSide === 'p1' ? 'p2' : 'p1';
  const theirs = s.sides[theirSide], ours = s.sides[ourSide];
  if (theirs.identityUncertain) return null;
  const chosen = (x: SwitchRecord) => !!x.from && !x.afterFaint && !x.dragged && x.turn >= 1;
  const theirSwitches = (theirs.switches ?? []).filter(chosen), ourSwitches = (ours.switches ?? []).filter(chosen);
  // Consecutive turns, ending with the one just played, on which that side made a switch of its own choosing.
  const streak = (list: SwitchRecord[]) => { let n = 0; for (let t = s.turn - 1; t >= 1 && list.some(x => x.turn === t); t--) n++; return n; };
  const recent = theirSwitches.filter(x => x.turn >= s.turn - 6);
  const theirStreak = streak(theirSwitches), ourStreak = streak(ourSwitches);
  if (recent.length < 2 && ourStreak < 2) return null;
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  // Where they have gone from this Pokémon before, weighting the switches made against the Pokémon we have out.
  const tally = new Map<string, number>();
  for (const x of theirSwitches.filter(x => x.from === foe?.species)) {
    // A destination that has fainted cannot answer this move again. Keeping it at the top of the tally
    // used to hide the living Alcremie behind a fainted Rotom-Fan in the Noctowl loop.
    if (!theirs.team.some(p => p.species === x.to && !p.fainted && p.id !== theirs.activeId)) continue;
    tally.set(x.to, (tally.get(x.to) ?? 0) + (x.facing === me.species ? 2 : 1));
  }
  const [next] = [...tally].sort((a, b) => b[1] - a[1]);
  const arrival = next && theirs.team.find(p => p.species === next[0] && !p.fainted && p.id !== theirs.activeId);
  const usable = moves.filter(m => { const d = dex.moves.get(m); return d.exists && d.category !== 'Status' && supportedMove(d.name); });
  const into = arrival && usable.length ? ourDamageInto(s, me, ourSide, arrival, usable).ourDamage : null;
  return {
    theirChosenSwitchesInLast6Turns: recent.length,
    ...(theirStreak >= 2 ? { theyHaveSwitchedOnEachOfTheLast: theirStreak } : {}),
    recent: recent.slice(-4).map(x => `t${x.turn} ${x.from}->${x.to}${x.via ? ` by ${x.via}` : ''}${x.facing ? ` facing ${x.facing}` : ''}`),
    ...(arrival ? { fromThisOneTheyHaveGoneTo: arrival.species, timesFromThisOne: theirSwitches.filter(x => x.from === foe?.species && x.to === arrival.species).length,
      ...(into && Object.keys(into).length ? { ourMovesIntoIt: Object.fromEntries(Object.entries(into).map(([k, v]) =>
        [k, v.conditionalKO && v.conditionalKO !== 'none-sampled' ? [...v.percentOfItsMaxHP, v.conditionalKO] : v.percentOfItsMaxHP])) } : {}) } : {}),
    ...(ourStreak >= 2 ? { weHaveSwitchedOnEachOfTheLast: ourStreak } : {}),
    observedNotCertain: true,
  };
}

/**
 * What each of our moves would do to the Pokémon the opponent might bring in, rather than only to the one
 * in front of us. This is the read behind clicking a move that the current target shrugs off: the Pokémon
 * that answers our active Pokémon is the one likely to arrive, and some of our moves catch it and some miss
 * it entirely.
 *
 * `likelyToComeIn` is a matchup ranking, not a prediction of their choice: it scores each revealed bench
 * Pokémon by how much it threatens our active Pokémon less how much our best move hurts it, which is the
 * trade a switch is made on. Damage is against its current HP and ignores the entry hazards it would take
 * on the way in, so it is a floor. Unrevealed Pokémon cannot be scored and are absent.
 */
export function switchPunish(s: BattleState, me: PokemonState, ourSide: SideId, moves: string[], limit = 3) {
  const theirSide: SideId = ourSide === 'p1' ? 'p2' : 'p1';
  const theirs = s.sides[theirSide];
  if (theirs.identityUncertain) return null;
  const bench = theirs.team.filter(p => !p.fainted && p.id !== theirs.activeId);
  const usable = moves.filter(m => { const d = dex.moves.get(m); return d.exists && d.category !== 'Status' && supportedMove(d.name); });
  if (!bench.length || !usable.length) return null;

  const scored = bench.map(foe => {
    const sets = dedupeCandidates(inferOpponent(foe).candidates);
    const { ourDamage, bestAnswer, intimidateShare, ourResponse } = ourDamageInto(s, me, ourSide, foe, usable);
    // What it would do to us on arrival, over its plausible attacks: the other half of the trade.
    let threat = 0, threatMove = '';
    for (const m of plausibleMoves(foe, 4)) {
      for (const set of sets.length ? sets : [undefined]) {
        const r = against(s, foe, me, theirSide, m.move, set, undefined);
        if (r && r.percentOfMaxHP[1] > threat) { threat = r.percentOfMaxHP[1]; threatMove = dex.moves.get(m.move).name; }
      }
    }
    return { foe, ourDamage, bestAnswer, threat, threatMove, intimidateShare, ourResponse, score: threat - (bestAnswer?.percent ?? 0) };
  }).filter(x => x.bestAnswer || x.threat > 0);
  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score);
  const lowered = (x: (typeof scored)[number]) => intimidated(me, x.ourResponse).boosts.atk ?? 0;
  return {
    likelyToComeIn: scored.slice(0, limit).map(x => ({
      species: x.foe.species, types: pokemonTypes(x.foe), hp: x.foe.hpPercent, status: x.foe.status,
      ...(x.threat > 0 ? { itsBestSampledHitOnUsPercent: Math.round(x.threat * 10) / 10, itsBestSampledMove: x.threatMove } : {}),
      ourMoveDamage: x.ourDamage,
      ...(x.intimidateShare > 0 ? { intimidatesUsOnArrival: { probability: x.intimidateShare,
        ourAttackStageAfter: lowered(x), ...(x.ourResponse.because ? { because: x.ourResponse.because } : {}) } } : {}),
      ...(x.bestAnswer ? { ourBestAnswer: x.bestAnswer.move, ourBestAnswerKnocksItOut: x.bestAnswer.ko } : {}),
    })),
    rankedBy: 'how much it threatens our active Pokémon less how much our best move hurts it; a matchup ranking, not a prediction of their choice',
  };
}
