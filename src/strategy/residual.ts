import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { grounded, pokemonTypes } from '../pokemon/mechanics.js';
import { inferOpponent } from './inference.js';
import { buildPokemon } from './calcCore.js';

const sixteenth = 100 / 16, eighth = 100 / 8;
// Round by magnitude, so a sixteenth gained and a sixteenth lost are shown as the same number.
const tenth = (v: number) => Math.sign(v) * Math.round(Math.abs(v) * 10) / 10;
const has = (p: PokemonState, volatile: string) => Object.keys(p.volatiles).some(k => id(k) === volatile);

/** The protocol names weather by the move that set it; residual effects care only about the kind. */
const weatherKinds: Record<string, string> = { SunnyDay: 'sun', DesolateLand: 'sun', RainDance: 'rain',
  PrimordialSea: 'rain', Sandstorm: 'sand', Snow: 'snow', Snowscape: 'snow', Hail: 'hail' };

/**
 * End-of-turn HP change as a percentage of max HP, and where it comes from. This is what decides whether a
 * Pokémon climbs out of a damage range or slides into one, and whether stalling behind Protect gains ground.
 *
 * Item and ability are often unknown for the opponent, so when either is, every sampled pairing is covered
 * and the result is a range; `sources` then describes the likeliest pairing rather than all of them.
 * Percentages are of max HP and ignore the final rounding to whole HP, so they are close rather than exact.
 * Rarer residual effects are not modelled.
 */
/** Max HP, exact for our side and from the likeliest sampled set for theirs. */
function maxHP(p: PokemonState) {
  if (p.exactHP?.max) return p.exactHP.max;
  try { return buildPokemon(p, inferOpponent(p).candidates[0]).maxHP(); } catch { return null; }
}
export function residuals(s: BattleState, p: PokemonState, side: SideId) {
  if (p.fainted) return null;
  const types = pokemonTypes(p);
  const weather = weatherKinds[s.field.weather ?? ''];
  // Leech Seed on the opposing active heals whoever holds our slot by what it drains: an eighth of the seeded Pokémon's
  // max HP, or what it has left, in our own percentage. Liquid Ooze turns that into damage; Magic Guard stops the drain.
  const opposing = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const seeded = opposing.team.find(x => x.id === opposing.activeId);
  let seedGain = 0;
  if (seeded && !seeded.fainted && has(seeded, 'leechseed')) {
    const seededAbility = seeded.abilitySuppressed ? '' : id(seeded.ability ?? inferOpponent(seeded).candidates[0]?.ability ?? '');
    const ours = maxHP(p), theirs = maxHP(seeded);
    if (ours && theirs && seededAbility !== 'magicguard') {
      const left = seeded.exactHP ? seeded.exactHP.current : Math.ceil(theirs * (seeded.hpPercent ?? 100) / 100);
      seedGain = Math.min(Math.floor(theirs / 8), left) / ours * 100 * (seededAbility === 'liquidooze' ? -1 : 1);
    }
  }

  const compute = (ability: string, item: string) => {
    if (has(p, 'embargo') || ability === 'klutz') item = '';
    const sources: { source: string; percent: number }[] = [];
    // Magic Guard stops everything indirect, leaving only the item's healing.
    const shielded = ability === 'magicguard';
    // Poison Heal inverts the sign of the largest number on the turn, and the toxic counter stops mattering.
    const poisonHeal = ability === 'poisonheal' && (p.status === 'psn' || p.status === 'tox');
    if (poisonHeal) sources.push({ source: `Poison Heal on ${p.status === 'tox' ? 'toxic' : 'poison'}, which heals instead of damaging and does not grow`, percent: eighth });
    if (!shielded) {
      if (weather === 'sand' && !types.some(t => ['Rock', 'Ground', 'Steel'].includes(t)) &&
          !['sandveil', 'sandrush', 'sandforce', 'overcoat'].includes(ability) && item !== 'safetygoggles') {
        sources.push({ source: 'Sandstorm', percent: -sixteenth });
      }
      if (weather === 'hail' && !types.includes('Ice') && !['icebody', 'snowcloak', 'overcoat'].includes(ability) && item !== 'safetygoggles') {
        sources.push({ source: 'Hail', percent: -sixteenth });
      }
      // Weather abilities that pay out or cost every turn they are up.
      if ((weather === 'snow' || weather === 'hail') && ability === 'icebody') sources.push({ source: 'Ice Body', percent: sixteenth });
      if (weather === 'rain' && ability === 'dryskin') sources.push({ source: 'Dry Skin in rain', percent: eighth });
      if (weather === 'rain' && ability === 'raindish') sources.push({ source: 'Rain Dish', percent: sixteenth });
      if (weather === 'sun' && ability === 'dryskin') sources.push({ source: 'Dry Skin in sun', percent: -eighth });
      if (weather === 'sun' && ability === 'solarpower') sources.push({ source: 'Solar Power in sun', percent: -eighth });
    }
    if (s.field.terrain === 'Grassy Terrain' && grounded(p)) sources.push({ source: 'Grassy Terrain', percent: sixteenth });
    if (!shielded) {
      if (p.status === 'brn' && ability !== 'heatproof') sources.push({ source: 'burn', percent: -sixteenth });
      if (p.status === 'brn' && ability === 'heatproof') sources.push({ source: 'burn, halved by Heatproof', percent: -sixteenth / 2 });
      if (!poisonHeal) {
        if (p.status === 'psn') sources.push({ source: 'poison', percent: -eighth });
        // Toxic grows by a sixteenth each turn it stays in place, so the counter is what makes it accurate.
        if (p.status === 'tox') {
          const ticks = Math.min(15, (p.toxicTurns ?? 0) + 1);
          sources.push({ source: `toxic, turn ${ticks} of it`, percent: -sixteenth * ticks });
        }
      }
      if (has(p, 'leechseed')) sources.push({ source: 'Leech Seed', percent: -eighth });
      if (has(p, 'saltcure')) sources.push({ source: 'Salt Cure', percent: types.some(t => ['Water', 'Steel'].includes(t)) ? -25 : -eighth });
      if (has(p, 'nightmare') && p.status === 'slp') sources.push({ source: 'Nightmare', percent: -25 });
      if (has(p, 'curse')) sources.push({ source: 'Curse', percent: -25 });
      if (has(p, 'partiallytrapped')) {
        const opposing = s.sides[side === 'p1' ? 'p2' : 'p1'];
        const source = opposing.team.find(x => x.id === opposing.activeId);
        sources.push({ source: 'partial trapping', percent: -100 / (id(source?.item ?? '') === 'bindingband' ? 6 : 8) });
      }
    }
    // Item healing is the part that commonly decides a damage range, so it is covered per possibility.
    const fromItem = item === 'leftovers' ? sixteenth
      : item === 'blacksludge' ? (types.includes('Poison') ? sixteenth : shielded ? 0 : -eighth) : 0;
    if (fromItem) sources.push({ source: item === 'leftovers' ? 'Leftovers' : 'Black Sludge', percent: fromItem });
    if (seedGain > 0) sources.push({ source: 'Leech Seed draining the opponent', percent: seedGain * (item === 'bigroot' ? 1.3 : 1) });
    if (seedGain < 0 && !shielded) sources.push({ source: 'Leech Seed draining a Liquid Ooze user', percent: seedGain });
    // Harvest grows back a berry it ate half the time at the end of a turn, and always in sun; a Sitrus Berry is eaten again
    // at once while HP is at half or below. As an expected value per turn, that is a quarter of max HP times the chance.
    if (ability === 'harvest' && !item && id(p.lastBerry ?? '') === 'sitrusberry' && (p.hpPercent ?? 100) <= 50) {
      const chance = weather === 'sun' ? 1 : 0.5;
      sources.push({ source: `Harvest regrowing its Sitrus Berry (${chance * 100}% a turn)`, percent: 25 * chance });
    }
    if (has(p, 'aquaring')) sources.push({ source: 'Aqua Ring', percent: sixteenth * (item === 'bigroot' ? 1.3 : 1) });
    if (has(p, 'ingrain')) sources.push({ source: 'Ingrain', percent: sixteenth * (item === 'bigroot' ? 1.3 : 1) });
    if (has(p, 'healblock')) for (let i = sources.length - 1; i >= 0; i--) {
      if (sources[i]!.percent > 0) sources.splice(i, 1);
    }
    return { sources, percent: sources.reduce((n, x) => n + x.percent, 0), heals: fromItem > 0 };
  };

  // Both unknowns come from the same sampled set, so they are paired rather than combined independently.
  const ability = p.abilitySuppressed ? '' : p.ability !== null ? id(p.ability) : null;
  const item = p.item !== null ? id(p.item) : null;
  const sampled = ability === null || item === null
    ? inferOpponent(p).candidates.map(c => ({ ability: ability ?? id(c.ability), item: item ?? id(c.item), probability: c.probability }))
    : [];
  const pairs = sampled.length ? sampled : [{ ability: ability ?? '', item: item ?? '', probability: 1 }];
  const computed = pairs.map(pr => ({ ...pr, ...compute(pr.ability, pr.item) }));
  const totals = [...new Set(computed.map(c => tenth(c.percent)))].sort((a, b) => a - b);
  if (!totals.length) return null;
  const likeliest = computed.reduce((a, b) => (b.probability > a.probability ? b : a));
  const healingItems = [...new Set(computed.filter(c => c.heals).map(c => c.item))];
  return {
    perTurnPercentOfMaxHP: totals.length === 1 ? totals[0]! : [totals[0]!, totals.at(-1)!],
    itemIsKnown: p.item !== null,
    abilityIsKnown: p.ability !== null || p.abilitySuppressed,
    ...(healingItems.length ? { healingItemPossibilities: healingItems } : {}),
    sources: likeliest.sources.map(x => ({ ...x, percent: tenth(x.percent) })),
    ...(totals.length > 1 ? { sourcesDescribeTheMostLikelySetOnly: true } : {}),
  };
}

/**
 * How many more turns this Pokémon survives the worst incoming damage once end-of-turn healing and chip are
 * counted. Worst case throughout, so it is a floor rather than a prediction, and it assumes the opponent
 * keeps attacking with its hardest hitting sampled move.
 */
export function survivalTurns(hpPercent: number | null, worstIncomingPercent: number | null, residualPercent: number) {
  if (hpPercent === null || worstIncomingPercent === null) return null;
  const net = worstIncomingPercent - residualPercent;
  let hp = hpPercent;
  for (let turn = 1; turn <= 30; turn++) {
    hp -= worstIncomingPercent;
    if (hp <= 0) return { turns: turn, note: 'under repeated worst-case attacks; a lethal hit occurs before end-of-turn healing' };
    hp = Math.min(100, hp + residualPercent);
    if (hp <= 0) return { turns: turn, note: 'under repeated worst-case attacks and end-of-turn chip' };
    if (net <= 0) return { turns: null, note: 'the hit is survived, then healing matches or beats the worst incoming damage' };
  }
  return { turns: null, note: 'survives the 30-turn estimation horizon under repeated worst-case attacks' };
}
