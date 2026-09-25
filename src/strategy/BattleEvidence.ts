import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import type { ProtocolMessage } from '../showdown/protocol.js';
import { sideId } from '../showdown/parser.js';
import { inferOpponent } from './inference.js';
import { effectiveSpeed, movePriority } from './speed.js';
import { hpInterval, scenario, supportedSpeed, supportedState } from './calcCore.js';
import type { Candidate } from './setTypes.js';
const active = (s: BattleState, side: SideId) => s.sides[side].team.find(p => p.id === s.sides[side].activeId);
const snapshot = (s: BattleState) => { const c = structuredClone(s); for (const side of Object.values(c.sides)) for (const p of side.team) delete p.inference; return c; };
function record(p: PokemonState, kind: 'speed' | 'damage', turn: number, candidates: Candidate[], rejected: Candidate[], note: string) {
  if (!candidates.length) return;
  p.inference ??= { excluded: [], contradictions: 0, observations: [] };
  // Ruling out every remaining set falsifies our model, not the opponent's set: the true set may simply be
  // unsampled, or a rounding chain may disagree by a point. Keep the candidates and record the contradiction,
  // rather than emptying the hypothesis space and silently blanking every downstream estimate.
  const contradiction = rejected.length === candidates.length;
  if (contradiction) p.inference.contradictions++;
  else p.inference.excluded = [...new Set([...p.inference.excluded, ...rejected.map(c => c.key!)])];
  p.inference.observations.push({ kind, turn, before: candidates.length,
    after: contradiction ? candidates.length : candidates.length - rejected.length,
    ...(contradiction ? { contradiction: true as const } : {}),
    note: contradiction ? `${note} Every sampled set was ruled out, so none were eliminated.` : note });
  p.inference.observations = p.inference.observations.slice(-12);
}
function speedFingerprint(s: BattleState) {
  return JSON.stringify([s.field, ...(['p1','p2'] as const).map(side => {
    const p = active(s, side);
    return [s.sides[side].conditions, p?.id, p?.species, p?.boosts, p?.status, p?.item, p?.ability, p?.abilitySuppressed, p?.volatiles, p?.terastallized];
  })]);
}
interface MoveObservation { state: BattleState; side: SideId; move: string; attackerId: string; defenderId: string; invalid: boolean; afterHP?: PokemonState }
/** Only public events and our private requests. Evidence is conservative, bounded and rebuilt on reconnect. */
export class BattleEvidence {
  private firstMove: { state: BattleState; side: SideId; move: string } | undefined;
  private movesThisTurn = 0;
  private pending: MoveObservation | undefined;
  before(s: BattleState, message: ProtocolMessage) {
    const parts = message.data.split('|'), side = sideId(parts[0] ?? '');
    if (['move','turn','upkeep','request','win','tie','switch','drag','replace','detailschange','-formechange','-transform'].includes(message.type)) this.flushDamage(s);
    // They moved first and ours then fainted or flinched without acting: the move we chose was outsped all the same.
    // Heracross, a Choice Band set at 182 Speed or a Scarf set at 273, knocked out a 214-Speed Serperior before its
    // Leaf Storm, and nothing was learned, because only a turn where both sides move was read for order.
    if (s.mySide && side === s.mySide && this.movesThisTurn === 1 && this.firstMove && this.firstMove.side !== side &&
      (message.type === 'faint' || (message.type === 'cant' && /flinch/.test(parts[1] ?? ''))) &&
      s.ourChoice?.turn === s.turn && s.ourChoice.move && active(s, side) && speedFingerprint(this.firstMove.state) === speedFingerprint(s)) {
      this.inferSpeed(s, this.firstMove, s.ourChoice.move);
      this.firstMove = undefined;
    }
    if (['init','turn','switch','drag','replace','detailschange','-formechange','-transform','cant'].includes(message.type)) {
      this.firstMove = undefined; this.movesThisTurn = 0;
    }
    if (['replace','detailschange','-formechange','-transform'].includes(message.type) && side) {
      const p = active(s, side); if (p) delete p.inference;
    }
    if (this.pending && ['-crit','-hitcount','-activate','-enditem','-immune','-fail','-miss','-boost','-unboost','-setboost','-ability','-endability','-start','-end'].includes(message.type)) this.pending.invalid = true;
    if (message.type !== 'move' || !side || !s.mySide) return;
    const foeSide = side === 'p1' ? 'p2' : 'p1', attacker = active(s, side), defender = active(s, foeSide);
    if (!attacker || !defender || parts.some(x => x.startsWith('[from]')) || !parts[1]) { this.firstMove = undefined; return; }
    this.movesThisTurn++;
    if (this.movesThisTurn === 1) this.firstMove = { state: snapshot(s), side, move: parts[1] };
    else if (this.movesThisTurn === 2 && this.firstMove && this.firstMove.side !== side && speedFingerprint(this.firstMove.state) === speedFingerprint(s)) {
      this.inferSpeed(s, this.firstMove, parts[1]);
      this.firstMove = undefined;
    }
    if (sideId(parts[2] ?? '') !== foeSide) return;
    this.pending = { state: snapshot(s), side, move: parts[1], attackerId: attacker.id, defenderId: defender.id, invalid: false };
  }
  after(s: BattleState, message: ProtocolMessage) {
    if (!this.pending || message.type !== '-damage') return;
    const parts = message.data.split('|'), side = sideId(parts[0] ?? '');
    if (!side || parts.some(x => x.startsWith('[from]'))) return; // recoil, poison, weather, hazards, etc.
    const p = active(s, side);
    if (p?.id !== this.pending.defenderId) return;
    if (this.pending.afterHP) this.pending.invalid = true; // multi-hit/duplicate damage cannot be one roll
    this.pending.afterHP = structuredClone(p);
  }
  private inferSpeed(current: BattleState, first: {state: BattleState; side: SideId; move: string}, secondMove: string) {
    const s = first.state, ownSide = s.mySide!, enemySide = ownSide === 'p1' ? 'p2' : 'p1';
    const me = active(s, ownSide)!, foe = active(s, enemySide)!, live = active(current, enemySide)!;
    // Turn order stays observable behind a Substitute, so only speed-relevant states are excluded here.
    if (!supportedSpeed(s, me, foe)) return;
    const ownMove = first.side === ownSide ? first.move : secondMove, enemyMove = first.side === enemySide ? first.move : secondMove;
    const ownSpeed = effectiveSpeed(s, me, ownSide), ownPriority = movePriority(s, me, ownMove);
    if (ownSpeed === null || ownPriority === null) return;
    const candidates = inferOpponent(live).candidates;
    let tested = 0;
    const rejected = candidates.filter(c => {
      const speed = effectiveSpeed(s, foe, enemySide, c), priority = movePriority(s, foe, enemyMove, c);
      // Unequal/unknown priorities convey no speed information. Ties never eliminate either order.
      if (speed === null || priority === null || priority !== ownPriority) return false;
      tested++;
      const enemyFirst = first.side === enemySide;
      return s.field.trickRoom ? enemyFirst ? speed > ownSpeed : speed < ownSpeed : enemyFirst ? speed < ownSpeed : speed > ownSpeed;
    });
    if (tested) record(live, 'speed', s.turn, candidates, rejected, 'Equal-priority observed order; ties retained; speed modifiers and Trick Room included. Candidates with ambiguous order effects retained.');
  }
  private flushDamage(current: BattleState) {
    const o = this.pending; this.pending = undefined;
    if (!o || o.invalid || !o.afterHP || !o.state.mySide) return;
    const s = o.state, ownSide = s.mySide!, enemySide = ownSide === 'p1' ? 'p2' : 'p1';
    const attacker = active(s, o.side)!, defender = active(s, o.side === 'p1' ? 'p2' : 'p1')!;
    const hidden = active(s, enemySide)!, live = current.sides[enemySide].team.find(p => p.id === hidden.id);
    if (!live || !supportedState(s, attacker, defender) || defender.hpPercent === null || o.afterHP.hpPercent === null) return;
    const candidates = inferOpponent(live).candidates;
    let tested = 0;
    const rejected = candidates.filter(c => {
      const r = scenario(s, attacker, defender, o.side, o.move, o.side === enemySide ? c : undefined, o.side === ownSide ? c : undefined);
      if (!r) return false;
      tested++;
      const before = hpInterval(defender, r.defenderMaxHP), after = hpInterval(o.afterHP!, r.defenderMaxHP);
      const minLoss = Math.max(0, before[0] - after[1]), maxLoss = Math.max(0, before[1] - after[0]);
      // One HP of slack: the damage formula chains several roundings, so a single-point disagreement is
      // model error rather than evidence. Fainting censors overkill: damage has a lower bound, never an upper one.
      return r.max < minLoss - 1 || (!o.afterHP!.fainted && r.min > maxLoss + 1);
    });
    if (tested) record(live, 'damage', s.turn, candidates, rejected, `Observed ${o.move}: noncritical single hit; public HP rounding and censored overkill included. Unmodeled scenarios retained.`);
  }
}
