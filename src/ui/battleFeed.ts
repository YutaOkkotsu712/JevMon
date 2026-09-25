import type { ProtocolMessage } from '../showdown/protocol.js';
import { dex, id } from '../pokemon/data.js';

/**
 * The battle as a person would narrate it, built from the public protocol lines of one room: who used what, what it
 * did to HP and stat stages, who is setting up, what happened at the end of the turn, and who won. Only public lines
 * are read — never the private request — and nothing from chat. Text is plain; the page escapes it.
 */
export type Tone = 'move' | 'damage' | 'heal' | 'boost' | 'drop' | 'status' | 'faint' | 'switch' | 'field' | 'tera' | 'info' | 'result' | 'miss';
export interface FeedEvent { seq: number; turn: number; phase: 'action' | 'end'; side: 'p1' | 'p2' | null; tone: Tone; text: string; setup?: true }
export interface BattleResult { winner: string | null; tie: boolean; turns: number; faints: { p1: number; p2: number };
  names: { p1: string | null; p2: string | null }; ratings: Record<string, { before: number; after: number }> }

const STAT: Record<string, string> = { atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', accuracy: 'accuracy', evasion: 'evasiveness' };
const STATUS: Record<string, string> = { brn: 'was burned', par: 'was paralysed', psn: 'was poisoned', tox: 'was badly poisoned', slp: 'fell asleep', frz: 'was frozen solid' };
const CANT: Record<string, string> = { slp: 'is fast asleep', par: 'is fully paralysed', frz: 'is frozen solid', flinch: 'flinched', recharge: 'must recharge', nopp: 'has no PP left' };
const RESIDUAL: Record<string, string> = { psn: 'poison', tox: 'poison', brn: 'its burn', confusion: 'confusion', recoil: 'recoil', drain: 'draining' };

const who = (ident: string) => {
  const m = /^(p[12])[a-d]?: (.+)$/.exec(ident.trim());
  return m ? { side: m[1] as 'p1' | 'p2', name: m[2]! } : null;
};
const percent = (condition: string | undefined) => {
  if (!condition) return null;
  if (/^0( |$)/.test(condition) || / fnt$/.test(condition)) return 0;
  const m = /^(\d+)\/(\d+)/.exec(condition);
  return m ? Math.round(Number(m[1]) / Number(m[2]) * 1000) / 10 : null;
};
/** `[from] item: Leftovers` → Leftovers; `[from] psn` → poison. */
const source = (parts: string[]) => {
  const from = parts.find(p => p.startsWith('[from]'))?.replace(/^\[from\] ?/, '').replace(/^(item|ability|move): /, '');
  return from ? RESIDUAL[id(from)] ?? from : null;
};
const words = (n: number, up: boolean) => (up ? (n >= 3 ? 'rose drastically' : n === 2 ? 'rose sharply' : 'rose') : (n >= 3 ? 'fell severely' : n === 2 ? 'harshly fell' : 'fell'));
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
const unescape = (s: string) => s.replace(/&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export class BattleFeed {
  readonly events: FeedEvent[] = [];
  result: BattleResult | null = null;
  private seq = 0;
  private turn = 0;
  private phase: 'action' | 'end' = 'action';
  private acted = false;
  private readonly hp = new Map<string, number>();
  private readonly stages = new Map<string, Record<string, number>>();
  private readonly active: Record<'p1' | 'p2', string | null> = { p1: null, p2: null };
  private readonly names: BattleResult['names'] = { p1: null, p2: null };
  private readonly faints = { p1: 0, p2: 0 };
  private readonly ratings: BattleResult['ratings'] = {};

  /** Reads one protocol message and returns the events it produced, in order. */
  handle(message: ProtocolMessage): FeedEvent[] {
    const out: FeedEvent[] = [];
    const parts = message.data.split('|');
    const add = (side: 'p1' | 'p2' | null, tone: Tone, text: string, setup?: boolean) => {
      const e: FeedEvent = { seq: ++this.seq, turn: this.turn, phase: this.phase, side, tone, text, ...(setup ? { setup: true as const } : {}) };
      this.events.push(e); out.push(e);
      if (this.events.length > 800) this.events.splice(0, this.events.length - 800);
    };
    const mon = who(parts[0] ?? '');
    const key = mon ? `${mon.side}:${mon.name}` : '';
    const stage = () => { let s = this.stages.get(key); if (!s) this.stages.set(key, s = {}); return s; };
    const setHP = (condition: string | undefined) => { const now = percent(condition); const was = this.hp.get(key); if (now !== null) this.hp.set(key, now); return { now, was }; };
    switch (message.type) {
      case 'player': if (/^p[12]$/.test(parts[0] ?? '') && parts[1]) this.names[parts[0] as 'p1' | 'p2'] = parts[1]; break;
      case 'turn': this.turn = Number(parts[0]) || this.turn; this.phase = 'action'; this.acted = false; break;
      // A blank line after the turn's actions opens the end-of-turn phase: Leftovers, poison, weather and the like.
      case '': if (this.acted) this.phase = 'end'; break;
      case 'switch': case 'drag': {
        if (!mon) break;
        const previous = this.active[mon.side];
        if (previous) this.stages.delete(previous);
        this.active[mon.side] = key;
        this.stages.delete(key);
        const { now } = setHP(parts[2]);
        const species = (parts[1] ?? '').split(',')[0];
        const named = species && species !== mon.name ? `${mon.name} (${species})` : mon.name;
        add(mon.side, 'switch', `${named} ${message.type === 'drag' ? 'was dragged out' : 'came in'}${now !== null ? ` at ${now}%` : ''}`);
        if (this.turn > 0) this.acted = true;
        break;
      }
      case 'move': {
        if (!mon) break;
        this.acted = true;
        const move = dex.moves.get(parts[1] ?? '');
        const target = who(parts[2] ?? '');
        const on = target && (target.side !== mon.side || target.name !== mon.name) && move.target !== 'self' ? ` on ${target.name}` : '';
        const via = source(parts.slice(3));
        const missed = parts.includes('[miss]');
        const setup = move.exists && move.category === 'Status' && move.target === 'self' && Object.values(move.boosts ?? {}).some(v => (v ?? 0) > 0);
        add(mon.side, 'move', `${mon.name} used ${parts[1]}${on}${via ? ` (through ${via})` : ''}${missed ? ', but it missed' : ''}`, setup);
        break;
      }
      case 'cant': if (mon) { this.acted = true; add(mon.side, 'miss', `${mon.name} ${CANT[id(parts[1] ?? '')] ?? `could not move (${(parts[1] ?? '').replace(/^(move|ability): /, '')})`}`); } break;
      case '-damage': case '-heal': {
        if (!mon) break;
        const { now, was } = setHP(parts[1]);
        const from = source(parts.slice(2));
        if (now === null) break;
        const delta = was === undefined ? null : Math.round((now - was) * 10) / 10;
        const size = delta === null ? '' : ` ${delta < 0 ? '−' : '+'}${Math.abs(delta)}%`;
        if (message.type === '-damage') add(mon.side, 'damage', `${mon.name}${from ? ` was hurt by ${from}` : ' took damage'}:${size} → ${now}%`);
        else add(mon.side, 'heal', `${mon.name}${from ? ` restored HP with ${from}` : ' restored HP'}:${size} → ${now}%`);
        break;
      }
      case '-sethp': if (mon) { const { now } = setHP(parts[1]); if (now !== null) add(mon.side, 'info', `${mon.name}'s HP is now ${now}%${source(parts.slice(2)) ? ` (${source(parts.slice(2))})` : ''}`); } break;
      case '-boost': case '-unboost': {
        if (!mon || !parts[1]) break;
        const n = Number(parts[2] ?? 1), up = message.type === '-boost', s = stage();
        s[parts[1]] = Math.max(-6, Math.min(6, (s[parts[1]] ?? 0) + (up ? n : -n)));
        const from = source(parts.slice(3));
        add(mon.side, up ? 'boost' : 'drop', n === 0 ? `${mon.name}'s ${STAT[parts[1]] ?? parts[1]} won't go any ${up ? 'higher' : 'lower'}`
          : `${mon.name}'s ${STAT[parts[1]] ?? parts[1]} ${words(n, up)}${from ? ` (${from})` : ''}: now ${signed(s[parts[1]]!)}`);
        break;
      }
      case '-setboost': if (mon && parts[1]) { stage()[parts[1]] = Number(parts[2]); add(mon.side, 'boost', `${mon.name}'s ${STAT[parts[1]] ?? parts[1]} is now ${signed(Number(parts[2]))}${source(parts.slice(3)) ? ` (${source(parts.slice(3))})` : ''}`); } break;
      case '-clearboost': if (mon) { this.stages.delete(key); add(mon.side, 'info', `${mon.name}'s stat changes were removed`); } break;
      case '-clearallboost': this.stages.clear(); add(null, 'field', 'All stat changes were removed'); break;
      case '-clearnegativeboost': if (mon) { const s = stage(); for (const k of Object.keys(s)) if (s[k]! < 0) delete s[k]; add(mon.side, 'info', `${mon.name}'s lowered stats were restored`); } break;
      case '-clearpositiveboost': if (mon) { const s = stage(); for (const k of Object.keys(s)) if (s[k]! > 0) delete s[k]; add(mon.side, 'info', `${mon.name}'s raised stats were removed`); } break;
      case '-invertboost': if (mon) { const s = stage(); for (const k of Object.keys(s)) s[k] = -s[k]!; add(mon.side, 'info', `${mon.name}'s stat changes were inverted`); } break;
      case '-status': if (mon) add(mon.side, 'status', `${mon.name} ${STATUS[parts[1] ?? ''] ?? `got ${parts[1]}`}${source(parts.slice(2)) ? ` (${source(parts.slice(2))})` : ''}`); break;
      case '-curestatus': if (mon) add(mon.side, 'heal', `${mon.name} ${parts[1] === 'slp' ? 'woke up' : parts[1] === 'frz' ? 'thawed out' : 'was cured of its status'}`); break;
      case 'faint': if (mon) { this.faints[mon.side]++; this.hp.set(key, 0); add(mon.side, 'faint', `${mon.name} fainted`); } break;
      case '-terastallize': if (mon) add(mon.side, 'tera', `${mon.name} Terastallized into the ${parts[1]} type`); break;
      case '-weather': {
        const w = parts[0] ?? '';
        if (parts.includes('[upkeep]')) break;
        add(null, 'field', w === 'none' ? 'The weather cleared' : `${w.replace(/([a-z])([A-Z])/g, '$1 $2')} started${source(parts.slice(1)) ? ` (${source(parts.slice(1))})` : ''}`);
        break;
      }
      case '-fieldstart': add(null, 'field', `${(parts[0] ?? '').replace(/^move: /, '')} started`); break;
      case '-fieldend': add(null, 'field', `${(parts[0] ?? '').replace(/^move: /, '')} ended`); break;
      case '-sidestart': case '-sideend': {
        const side = /^(p[12])/.exec(parts[0] ?? '')?.[1] as 'p1' | 'p2' | undefined;
        add(side ?? null, 'field', `${(parts[1] ?? '').replace(/^move: /, '')} ${message.type === '-sidestart' ? 'was set' : 'ended'} on ${this.names[side!] ?? side}'s side`);
        break;
      }
      case '-start': case '-end': {
        if (!mon) break;
        const effect = (parts[1] ?? '').replace(/^(move|ability|item): /, '');
        if (id(effect) === 'typechange') { add(mon.side, 'info', `${mon.name} became ${parts[2]} type`); break; }
        if (/^perish/.test(id(effect))) { add(mon.side, 'status', `${mon.name}: Perish count ${effect.replace(/\D/g, '')}`); break; }
        add(mon.side, message.type === '-start' ? 'status' : 'info', `${mon.name}: ${effect} ${message.type === '-start' ? 'started' : 'ended'}`);
        break;
      }
      case '-activate': {
        const effect = (parts[1] ?? '').replace(/^(move|ability|item): /, '');
        if (mon && ['Protect', 'Detect', 'King\'s Shield', 'Spiky Shield', 'Baneful Bunker', 'Silk Trap', 'Burning Bulwark'].includes(effect)) add(mon.side, 'info', `${mon.name} protected itself`);
        else if (mon && effect) add(mon.side, 'info', `${mon.name}: ${effect}`);
        break;
      }
      case '-crit': if (mon) add(mon.side, 'damage', `A critical hit on ${mon.name}!`); break;
      case '-supereffective': if (mon) add(mon.side, 'info', `It's super effective on ${mon.name}`); break;
      case '-resisted': if (mon) add(mon.side, 'info', `${mon.name} resisted it`); break;
      case '-immune': if (mon) add(mon.side, 'miss', `${mon.name} is immune${source(parts.slice(1)) ? ` (${source(parts.slice(1))})` : ''}`); break;
      case '-miss': { const t = who(parts[1] ?? ''); if (t) add(t.side, 'miss', `${t.name} avoided the attack`); break; }
      case '-fail': if (mon) add(mon.side, 'miss', 'But it failed'); break;
      case '-item': if (mon) add(mon.side, 'info', `${mon.name}'s ${parts[1]} was revealed${source(parts.slice(2)) ? ` (${source(parts.slice(2))})` : ''}`); break;
      case '-enditem': if (mon) add(mon.side, 'info', `${mon.name} lost its ${parts[1]}${source(parts.slice(2)) ? ` (${source(parts.slice(2))})` : parts.includes('[eat]') ? ' (eaten)' : ''}`); break;
      case '-ability': if (mon) add(mon.side, 'info', `${mon.name}'s ${parts[1]}${source(parts.slice(2)) ? ` (${source(parts.slice(2))})` : ''}`); break;
      case '-transform': { const t = who(parts[1] ?? ''); if (mon && t) add(mon.side, 'info', `${mon.name} transformed into ${t.name}`); break; }
      case 'detailschange': case '-formechange': if (mon) add(mon.side, 'info', `${mon.name} changed form: ${(parts[1] ?? '').split(',')[0]}`); break;
      case 'win': case 'tie': {
        this.result = { winner: message.type === 'win' ? parts[0] ?? null : null, tie: message.type === 'tie', turns: this.turn,
          faints: { ...this.faints }, names: { ...this.names }, ratings: this.ratings };
        add(null, 'result', message.type === 'tie' ? 'The battle ended in a tie' : `${parts[0]} won the battle`);
        break;
      }
      case 'raw': {
        // The ladder's rating line, and only that: the rest of a raw line is HTML and is never shown.
        const m = /^(.{1,40}?)(?:'|&apos;|&#39;)s rating: (\d{1,5}) &rarr; <strong>(\d{1,5})<\/strong>/.exec(message.data);
        if (!m) break;
        const name = unescape(m[1]!), before = Number(m[2]), after = Number(m[3]);
        this.ratings[name] = { before, after };
        add(null, 'result', `${name}'s rating: ${before} → ${after} (${after >= before ? '+' : ''}${after - before})`);
        break;
      }
    }
    return out;
  }
  /** Current stat stages by `side:name`, for the arena to show beside each active Pokémon. */
  stagesOf(side: 'p1' | 'p2', name: string) { return { ...(this.stages.get(`${side}:${name}`) ?? {}) }; }
}
