import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { switchRelief } from './switchRelief.js';
import { incomingThreats } from './threat.js';
import { id } from '../pokemon/data.js';

/** A two-Pokémon route already tried twice against the same two opposing Pokémon. The opponent
 * answered our switch both times and we switched back; repeating it with a nearly spent target
 * gives away another turn without changing the matchup. */
function repeatedPairRoute(s: BattleState, side: SideId, me: PokemonState, target: PokemonState, foe: PokemonState) {
  const ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const chosen = (x: { afterFaint: boolean; dragged: boolean; via: string | null; turn: number }) =>
    !x.afterFaint && !x.dragged && !x.via && x.turn >= s.turn - 10;
  const outgoing = (ours.switches ?? []).filter(x => chosen(x) && x.from === me.species &&
    x.to === target.species && x.facing === foe.species);
  if (outgoing.length < 2 || (target.hpPercent ?? 100) > 35) return null;
  for (const reply of (theirs.switches ?? []).filter(x => chosen(x) && x.from === foe.species &&
    x.facing === target.species && x.turn >= outgoing[0]!.turn &&
    theirs.team.some(p => p.species === x.to && !p.fainted))) {
    const replies = (theirs.switches ?? []).filter(x => chosen(x) && x.from === foe.species &&
      x.to === reply.to && x.facing === target.species && x.turn >= outgoing[0]!.turn);
    const returns = (ours.switches ?? []).filter(x => chosen(x) && x.from === target.species &&
      x.to === me.species && x.facing === reply.to && x.turn >= outgoing[0]!.turn);
    if (replies.length >= 2 && returns.length >= 2 && replies.at(-1)!.turn >= s.turn - 4) {
      return `${me.species} to ${target.species} against ${foe.species} has already led twice to ${reply.to} and a switch straight back; ${target.species} is at ${Math.round(target.hpPercent ?? 0)}% HP`;
    }
  }
  return null;
}

/**
 * Switching out a Pokémon that only just arrived, while it still faces the very opponent it was sent in to
 * answer, spends a turn undoing the previous turn and gives up a free hit for nothing. Repeated, it is a
 * loop that never attacks. Describing the cost in the payload did not stop it, so this recognises it directly.
 *
 * Deliberately narrow, because double switching is ordinary play. It never applies to a forced switch, nor to a
 * Pokémon that came in to replace a fainted one, nor once a Pokémon has settled in, nor when the opponent has changed since we arrived — re-pivoting against a
 * new opponent is a real decision — nor when staying in is a certain knockout, which is worth a turn to escape.
 * Returns the reason to skip, or null to allow.
 */
export function cyclicSwitch(s: BattleState, side: SideId, target: PokemonState): string | null {
  const ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId);
  if (!me || me.fainted || target.id === me.id) return null;
  const foe = theirs.team.find(p => p.id === theirs.activeId);
  // This longer loop survives the one-turn guard below because each Pokémon attacks once between switches.
  // A certain knockout against our current Pokémon can still justify breaking the route with a switch.
  if (foe && incomingThreats(s, me, side, 1)?.conditionalKO !== 'all-sampled-rolls') {
    const repeated = repeatedPairRoute(s, side, me, target, foe);
    if (repeated) return repeated;
  }
  // Clearing a new affliction, a stat drop or healing on exit is a concrete gain, not an empty cycle.
  if (switchRelief(s, me, side)?.hasRelief) return null;
  // So is Zero to Hero: Palafin leaves as its Hero forme. Called a cycle, the switch out of a Palafin that had just come in
  // was penalised, and it used Wave Crash with base 70 Attack instead (2688264365).
  if (!me.abilitySuppressed && !me.transformedInto && id(me.ability ?? '') === 'zerotohero' && id(me.species) === 'palafin') return null;
  // A deliberate sacrifice ends the cycle and can buy a replacement after the opposing attack.
  if (incomingThreats(s, target, side, 1)?.conditionalKO === 'all-sampled-rolls') return null;
  const arrived = me.activeSinceTurn;
  if (typeof arrived !== 'number' || s.turn - arrived > 1) return null;
  // The opening lead did not arrive by switching, so there is no previous turn for this to undo.
  if (arrived === 0) return null;
  // Nor did a replacement for a fainted teammate: it cost no turn, and when both sides replaced at once it was chosen
  // without seeing what it faces. Blastoise, sent in blind as Wo-Chien replaced Pawmot, was held in to be paralysed.
  if (ours.team.some(p => p.fainted && p.lastActiveTurn === arrived)) return null;
  const facing = foe?.activeSinceTurn;
  // A new opponent since we arrived means this is a fresh matchup, not a retreat from our own choice. One that came in
  // on the same turn counts too: both switches were chosen blind, so we never picked this Pokémon for this opponent.
  // Sawsbuck, sent to face Latias as Morpeko came in, was held in against Aura Wheel by this guard, though the search
  // put 68% of its visits and Jev 62% on Florges, and was knocked out (2687703481). A pivot chosen after their switch
  // is the exception: its replacement was picked seeing them.
  const pivotedIn = (ours.switches ?? []).some(x => x.turn === arrived && x.to === me.species && !!x.via);
  if (!foe || typeof facing !== 'number' || facing > arrived || (facing === arrived && !pivotedIn)) return null;
  if (incomingThreats(s, me, side, 1)?.conditionalKO === 'all-sampled-rolls') return null;
  const returning = typeof target.lastActiveTurn === 'number' && s.turn - target.lastActiveTurn <= 2;
  return returning
    ? `would undo last turn's switch: ${me.species} arrived on turn ${arrived} to face ${foe.species}, and ${target.species} left on turn ${target.lastActiveTurn}`
    : `${me.species} arrived on turn ${arrived} to face ${foe.species} and has not acted, so switching again spends a second turn on the same matchup`;
}
