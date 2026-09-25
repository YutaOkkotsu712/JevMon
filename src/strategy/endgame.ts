import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { accumulate, dedupeCandidates, scenario, supportedMove } from './calcCore.js';
import { inferOpponent } from './inference.js';
import { plausibleMoves } from './setPriors.js';
import { effectiveSpeed } from './speed.js';
import { remainingPokemon } from '../battle/BattleState.js';
import { dex } from '../pokemon/data.js';

type Sets = (ReturnType<typeof dedupeCandidates>[number] | undefined)[];
/** Exactly one side is hidden in any pair, so its sampled sets go on whichever side that is. */
const best = (s: BattleState, attacker: PokemonState, defender: PokemonState, side: SideId,
  moves: string[], attackerSets: Sets, defenderSets: Sets) => {
  let top = 0, ko = false;
  for (const name of moves) {
    const move = dex.moves.get(name);
    if (!move.exists || !supportedMove(move.name)) continue;
    const rolls = [];
    let maxHP = 0, attempted = 0;
    for (const a of attackerSets) for (const d of defenderSets) {
      attempted += (a?.probability ?? 1) * (d?.probability ?? 1);
      const r = scenario(s, attacker, defender, side, move.name, a, d);
      if (r) { rolls.push({ ...r, probability: (a?.probability ?? 1) * (d?.probability ?? 1) }); maxHP = r.defenderMaxHP; }
    }
    const result = accumulate(rolls, defender, maxHP, attempted);
    if (result && result.percentOfMaxHP[1] > top) { top = result.percentOfMaxHP[1]; ko = result.conditionalKO === 'all-sampled-rolls'; }
  }
  return top > 0 ? { percent: top, ko } : null;
};

/**
 * Which of our Pokémon beat which of theirs, past the pair currently on the field. A battle is won by having
 * an answer to everything left rather than by winning this turn, and a Pokémon with no answer on our side is
 * the thing to play around.
 *
 * Coarse on purpose: best move each way, turns to knock out from the HP each side has now, faster side winning the
 * race. From full health it called a 20% Pokémon an answer to anything it could beat when fresh, which is what the
 * decisions about preserving or sacrificing a Pokémon lean on.
 * It ignores switching, hazards, status, items that trigger once and anything the opponent does in between,
 * and it can only judge Pokémon that have been revealed.
 */
export function endgame(s: BattleState, ourSide: SideId) {
  const theirSide = ourSide === 'p1' ? 'p2' : 'p1';
  const ours = s.sides[ourSide], theirs = s.sides[theirSide];
  const mine = ours.team.filter(p => !p.fainted);
  const revealed = theirs.team.filter(p => !p.fainted);
  if (!mine.length || !revealed.length) return null;
  const unanswered: string[] = [];
  const defensive: { foe: PokemonState; ours: { pokemon: PokemonState; worstHitPercent: number }[] }[] =
    revealed.map(foe => ({ foe, ours: [] }));
  const summary = mine.map(me => {
    const beats: string[] = [], losesTo: string[] = [];
    for (const foe of revealed) {
      const sets = dedupeCandidates(inferOpponent(foe).candidates);
      if (!sets.length) continue;
      const outgoing = best(s, me, foe, ourSide, me.knownMoves.length ? me.knownMoves : me.revealedMoves, [undefined], sets);
      const incoming = best(s, foe, me, theirSide, plausibleMoves(foe).map(m => m.move), sets, [undefined]);
      if (incoming) defensive.find(x => x.foe.id === foe.id)!.ours.push({ pokemon: me, worstHitPercent: incoming.percent });
      if (!outgoing || !incoming) continue;
      const ourTurns = Math.ceil(Math.max(1, foe.hpPercent ?? 100) / outgoing.percent), theirTurns = Math.ceil(Math.max(1, me.hpPercent ?? 100) / incoming.percent);
      const ourSpeed = effectiveSpeed(s, me, ourSide);
      const theirSpeed = sets.map(c => effectiveSpeed(s, foe, theirSide, c)).filter((v): v is number => v !== null);
      const faster = ourSpeed !== null && theirSpeed.length ? ourSpeed > Math.max(...theirSpeed) : null;
      if (ourTurns < theirTurns || (ourTurns === theirTurns && faster === true)) beats.push(foe.species);
      else if (theirTurns < ourTurns || (ourTurns === theirTurns && faster === false)) losesTo.push(foe.species);
    }
    return { species: me.species, beats, losesTo };
  });
  for (const foe of revealed) {
    if (!summary.some(x => x.beats.includes(foe.species))) unanswered.push(foe.species);
  }
  // A strict race can mark a team as having no answer even when one Pokémon is uniquely able to absorb that
  // opponent's attacks. Keep the defensive fact separate from the win/loss estimate, because paralysis, future
  // chip and switching all change the race without changing how hard the revealed foe hits each teammate.
  const soleDurableInto = defensive.flatMap(({ foe, ours: hits }) => {
    if (hits.length !== mine.length) return [];
    const durable = hits.filter(x => x.worstHitPercent <= 35);
    if (durable.length !== 1 || hits.some(x => x !== durable[0] && x.worstHitPercent < 50)) return [];
    const only = durable[0]!;
    return [{ opposingPokemon: foe.species, ourPokemon: only.pokemon.species,
      theirWorstModeledHitPercentOfOurMaxHP: only.worstHitPercent,
      ourCurrentHPPercent: only.pokemon.hpPercent }];
  });
  return {
    remaining: { ours: remainingPokemon(ours), theirs: remainingPokemon(theirs) },
    revealedOpposingPokemon: revealed.length,
    ourPokemon: summary.filter(x => x.beats.length || x.losesTo.length),
    ...(soleDurableInto.length ? { soleDurableInto } : {}),
    ...(unanswered.length ? { theirsWeHaveNoAnswerTo: unanswered } : {}),
  };
}
