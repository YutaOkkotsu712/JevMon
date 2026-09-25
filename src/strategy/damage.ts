import type { BattleState } from '../battle/BattleState.js';
import { inferOpponent } from './inference.js';
import { accumulate, dedupeCandidates, scenario } from './calcCore.js';
import { absorbedBy } from './abilities.js';
import { dex } from '../pokemon/data.js';
import { afterTerastallizing } from './forme.js';
import { pokemonTypes, typeEffectiveness } from '../pokemon/mechanics.js';
/** These return damage they have taken, so the calculator's zero is a condition, priced in conditionalDamage. */
const returnsDamageTaken = ['counter', 'mirrorcoat', 'metalburst', 'comeuppance'];
export function damageRange(s: BattleState, moveName: string, tera?: string) {
  if (!s.mySide) return null;
  const ours = s.sides[s.mySide], theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted) return null;
  const candidates = dedupeCandidates(inferOpponent(foe).candidates);
  const rolls = [];
  const subRolls: { hpBefore: [number, number]; damageHP: [number, number]; breaks: 'all-rolls' | 'some-rolls' | 'no-rolls' }[] = [];
  const zero: typeof candidates = [];
  let maxHP = 0, tested = 0;
  for (const c of candidates) {
    // Ogerpon's Embody Aspect and Terapagos's Stellar form apply on the turn it Terastallises.
    const r = scenario(s, tera ? afterTerastallizing(me, tera) : me, foe, s.mySide, moveName, undefined, c, tera);
    if (!r) continue;
    rolls.push({ ...r, probability: c.probability });
    if (r.substitute) subRolls.push(r.substitute);
    maxHP = r.defenderMaxHP;
    tested += c.probability;
    // Taken from the calculator's own verdict rather than re-deriving the rule, so Mold Breaker,
    // type immunity and anything else that overrides an ability are all honoured for free.
    if (r.max === 0 && !r.substitute) zero.push(c);
  }
  const result = accumulate(rolls, foe, maxHP, candidates.reduce((n, c) => n + c.probability, 0));
  if (!result) return null;
  // A zero from an ability is not a low roll, and the two are indistinguishable from the envelope alone.
  const named = [...new Set(zero.map(c => absorbedBy(foe.ability ?? c.ability, moveName)).filter((v): v is string => !!v))];
  // Name a cause only when it is actually known: calling every other zero a type immunity told the model a
  // Mirror Coat target was immune to it.
  const move = dex.moves.get(moveName);
  const cause = named.length ? { abilities: named }
    : typeEffectiveness(move.type, pokemonTypes(foe)) === 0 ? { cause: 'type immunity' }
    : move.id === 'endeavor' ? { cause: 'Endeavor only cuts the target down to our current HP, and it has no more than that' }
    : { cause: 'the calculator gives no damage in this matchup' };
  const absorbed = zero.length && tested > 0 && !returnsDamageTaken.includes(move.id)
    ? { probability: Math.round(zero.reduce((n, c) => n + c.probability, 0) / tested * 1000) / 1000, ...cause }
    : null;
  const substituteDamage = subRolls.length ? {
    hpBefore: [Math.min(...subRolls.map(r => r.hpBefore[0])), Math.max(...subRolls.map(r => r.hpBefore[1]))],
    damageHP: [Math.min(...subRolls.map(r => Math.min(r.damageHP[0], r.hpBefore[0]))), Math.max(...subRolls.map(r => Math.min(r.damageHP[1], r.hpBefore[1])))],
    breaks: subRolls.every(r => r.breaks === 'all-rolls') ? 'all-sampled-rolls' : subRolls.some(r => r.breaks !== 'no-rolls') ? 'some-sampled-rolls' : 'none-sampled',
    laterHitsCanReachHolder: rolls.some(r=>r.substitute?.laterHitsCanReachHolder),
    holderHPDamage: result.hp,
    excessDamageSpillsThrough: false,
    note: 'The breaking hit does not spill through; later hits of a multi-hit move can damage the holder. Breaking a Substitute alone is not a KO. HP may be a range after unobserved rolls or transfer.',
  } : null;
  return { ...result, ...(substituteDamage ? { substituteDamage } : {}), targetMaxHP: maxHP, ...(absorbed ? { takesNothingFromIt: absorbed } : {}) };
}
