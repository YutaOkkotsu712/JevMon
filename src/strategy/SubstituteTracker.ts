import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import type { ProtocolMessage } from '../showdown/protocol.js';
import { sideId } from '../showdown/parser.js';
import { id } from '../pokemon/data.js';
import { inferOpponent } from './inference.js';
import { buildPokemon, dedupeCandidates, scenario } from './calcCore.js';
import { hasSubstitute } from './substituteState.js';
const active = (s: BattleState, side: SideId) => s.sides[side].team.find(p => p.id === s.sides[side].activeId);
/** Substitute HP is private simulator state: keep intervals, never invent an exact hidden damage roll. */
export class SubstituteTracker {
  private move: { state: BattleState; side: SideId; name: string; uncertain: boolean } | undefined;
  private transferring = false;
  private transfer: PokemonState['substitute'];
  before(s: BattleState, m: ProtocolMessage) {
    const a = m.data.split('|'), side = sideId(a[0] ?? '');
    if (m.type === 'init' || m.type === 'turn' || m.type === 'upkeep') { this.move = undefined; this.transferring = false; this.transfer = undefined; }
    if (m.type === 'move' && side) {
      this.transferring = ['Baton Pass', 'Shed Tail'].includes(a[1] ?? '');
      this.move = { state: structuredClone(s), side, name: a[1] ?? '', uncertain: a.some(x => x.startsWith('[from]')) };
    }
    if (['-crit','-hitcount','-boost','-unboost','-setboost','-formechange','-transform','-sideend','-sidestart','-weather','-fieldstart','-fieldend','-ability','-endability','-item','-enditem','-status','-curestatus'].includes(m.type) && this.move) this.move.uncertain = true;
    if (['switch','drag','replace'].includes(m.type) && side) {
      const p = active(s, side);
      this.transfer = this.transferring && this.move?.side === side && p?.substitute ? structuredClone(p.substitute) : undefined;
      if (p) delete p.substitute;
      this.move = undefined;
    }
  }
  after(s: BattleState, m: ProtocolMessage) {
    const a = m.data.split('|'), side = sideId(a[0] ?? '');
    if (!side) return;
    const p = active(s, side); if (!p) return;
    if (['switch','drag'].includes(m.type) && this.transfer) {
      p.substitute = { ...this.transfer, source: 'unknown-transfer' };
      p.volatiles.Substitute = { sinceTurn: s.turn, data: null };
      this.transfer = undefined; this.transferring = false;
    }
    if (m.type === '-start' && id((a[1] ?? '').replace(/^move: /, '')) === 'substitute') {
      const sizes = p.exactHP ? [p.exactHP.max] : dedupeCandidates(inferOpponent(p).candidates).flatMap(c => {
        try { return [buildPokemon(p, c).maxHP()]; } catch { return []; }
      });
      const lo = sizes.length ? Math.max(1, Math.floor(Math.min(...sizes) / 4)) : 1;
      // Missing max HP or a transfer has an unknown donor size. Gen 9 maximum possible HP is <= 714.
      const hi = sizes.length && !this.transferring && !a.some(v => v.includes('Shed Tail')) ? Math.max(1, Math.floor(Math.max(...sizes) / 4)) : 178;
      const unknown = !sizes.length || this.transferring || a.some(v => v.includes('Shed Tail'));
      p.substitute = { hp: [unknown ? 1 : lo, hi], initialHP: [unknown ? 1 : lo, hi], hits: 0, source: unknown ? 'unknown-transfer' : 'created' };
    }
    if (m.type === '-end' && id((a[1] ?? '').replace(/^move: /, '')) === 'substitute' || m.type === 'faint') delete p.substitute;
    if (m.type !== '-activate' || id((a[1] ?? '').replace(/^move: /, '')) !== 'substitute' || !a.includes('[damage]')) return;
    if (!hasSubstitute(p)) return;
    const sub = p.substitute ?? { hp: [1, 178] as [number, number], initialHP: [1, 178] as [number, number], hits: 0, source: 'unknown-transfer' as const };
    const o = this.move;
    let low = 1, high = Math.max(1, sub.hp[1]);
    if (o && !o.uncertain && o.side !== side && s.mySide) {
      const attacker = active(o.state, o.side), defender = active(o.state, side);
      if (attacker && defender && defender.id === p.id) {
        const hidden = o.side === s.mySide ? defender : attacker;
        const candidates = dedupeCandidates(inferOpponent(hidden).candidates);
        const rolls = candidates.flatMap(c => {
          const r = scenario(o.state, attacker, defender, o.side, o.name, o.side === s.mySide ? undefined : c, side === s.mySide ? undefined : c);
          return r?.substitute ? [r.substitute.damageHP] : [];
        });
        if (rolls.length && rolls.length === candidates.length) {
          low = Math.max(1, sub.hp[0] - Math.max(...rolls.map(r => r[1])));
          high = Math.max(1, sub.hp[1] - Math.min(...rolls.map(r => r[0])));
          if (low > high) { low = 1; high = sub.hp[1]; }
        }
      }
    }
    p.substitute = { ...sub, hp: [low, high], hits: sub.hits + 1 };
    // A second hit in the same move is unsupported: never reuse the first-hit estimate as exact state.
    if (this.move) this.move.uncertain = true;
  }
}
