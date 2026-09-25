import { Pokemon } from '@smogon/calc';
import { BattleTracker } from '../src/battle/BattleTracker.js';
import { parseFrame } from '../src/showdown/protocol.js';
export const room = 'battle-gen9randombattle-test';

/** One private roster row for our own side, fitted to real random-battle stats so the calculator accepts it. */
export function ours(species: string, level: number, moves: string[], ability: string, item: string, tera: string) {
  const calc = new Pokemon(9, species, { level, nature: 'Serious',
    evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } });
  return { ident: `p1: ${species}`, details: `${species}, L${level}`, maxHP: calc.maxHP(), moves,
    stats: { atk: calc.rawStats.atk, def: calc.rawStats.def, spa: calc.rawStats.spa, spd: calc.rawStats.spd, spe: calc.rawStats.spe },
    ability, item, tera };
}
export type Row = ReturnType<typeof ours>;

/** A joined Gen 9 singles battle where our side's private stats are known and the opponent's are not. */
export function battle(roster: Row[], foe: string, foeLevel = 82) {
  const t = new BattleTracker(room, 'Test Bot');
  const feed = (lines: string) => { for (const m of parseFrame(`>${room}\n${lines}`)) t.handle(m); };
  const payload = (rqid: number, hp: number, activeIndex = 0) => ({ rqid,
    active: [{ moves: roster[activeIndex]!.moves.map(m => ({ move: m, id: m.toLowerCase().replace(/[^a-z0-9]/g, '') })) }],
    side: { id: 'p1', name: 'Test Bot', pokemon: roster.map((p, i) => ({ ident: p.ident, details: p.details,
      condition: `${i === activeIndex ? hp : p.maxHP}/${p.maxHP}`, active: i === activeIndex, stats: p.stats, moves: p.moves,
      baseAbility: p.ability, ability: p.ability, item: p.item, teraType: p.tera })) } });
  const request = (rqid: number, hp: number, activeIndex = 0) => `|request|${JSON.stringify(payload(rqid, hp, activeIndex))}`;
  feed(['|init|battle', '|player|p1|Test Bot|1|', '|player|p2|Foe|2|', `|teamsize|p1|${roster.length}`, '|teamsize|p2|6',
    '|gametype|singles', '|tier|[Gen 9] Random Battle', request(1, roster[0]!.maxHP),
    `|switch|p2a: Foe|${foe}, L${foeLevel}|100/100`,
    `|switch|p1a: ${roster[0]!.details.split(',')[0]}|${roster[0]!.details}|${roster[0]!.maxHP}/${roster[0]!.maxHP}`,
    '|turn|1'].join('\n'));
  return { state: t.state, feed, request, payload,
    foe: () => t.state.sides.p2.team[0]!, me: () => t.state.sides.p1.team.find(p => p.id === t.state.sides.p1.activeId)! };
}
