import type { DecisionInput } from '../decisions/DecisionProvider.js';
import { dex, id } from '../pokemon/data.js';
import { damageRange } from './damage.js';
import { turnOrder } from './speed.js';
import { plausibleMoves } from './setPriors.js';
import { protectMoves } from '../battle/BattleTracker.js';

const pivots = new Set(['uturn', 'voltswitch', 'flipturn']);
const contactPunishers = { items: ['rockyhelmet'], abilities: ['roughskin', 'ironbarbs'] };

/**
 * A faster damaging pivot does everything a hard switch does, and more. We move first, so the replacement still
 * enters before their attack; the pivot adds its damage and lets us pick the replacement after seeing whether they
 * switched. Across the logs we hard-switched 12 times with such a pivot on offer, among them Bellibolt leaving a
 * 52-61% Volt Switch unused.
 *
 * Narrow: the pivot certainly moves first, deals damage (not Volt Switch into a Ground type or an absorbing ability),
 * is not likely to meet a Protect, and is not punished by a contact item or ability they are known to have.
 */
export function fasterPivot(input: DecisionInput) {
  const s = input.state;
  if (!s.mySide || s.requestKind !== 'move' || input.request?.forceSwitch?.[0]) return null;
  const ours = s.sides[s.mySide], theirs = s.sides[s.mySide === 'p1' ? 'p2' : 'p1'];
  const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
  if (!me || !foe || me.fainted || foe.fainted) return null;
  if (plausibleMoves(foe).some(m => protectMoves.has(id(m.move)) && (m.revealed || (m.priorProbability ?? 0) >= 0.5))) return null;
  for (const action of input.legalActions) {
    if (action.kind !== 'move' || action.command.endsWith(' terastallize')) continue;
    const move = dex.moves.get(action.label);
    if (!pivots.has(move.id)) continue;
    if (move.flags.contact && (contactPunishers.items.includes(id(foe.item ?? '')) || contactPunishers.abilities.includes(id(foe.ability ?? '')))) continue;
    if (turnOrder(s, me, move.name)?.order !== 'ours-first') continue;
    const range = damageRange(s, move.name);
    if (!range || range.percentOfMaxHP[1] <= 0 || (range.takesNothingFromIt?.probability ?? 0) > 0) continue;
    return { action, reason: `${move.name} moves first and does ${range.percentOfMaxHP.join('-')}% before switching, so the replacement still comes in ahead of their attack` };
  }
  return null;
}
