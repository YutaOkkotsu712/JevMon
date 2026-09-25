import { isRecord } from './parser.js';
import type { ProtocolMessage } from './protocol.js';
import { isBattleRoom } from '../battle/BattleManager.js';

/**
 * Plays the Gen 9 Random Battle ladder one game at a time: one search once logged in, and another after each battle
 * ends. The server picks the opponent, so unlike a challenge there is no one to vet; what keeps it bounded is the one
 * format, never searching while a battle is on or pending, and the caller's run count.
 *
 * A search the server refuses — throttling, or a search already running from an earlier connection — arrives as a
 * popup rather than a search update, so a popup before the search is confirmed is treated as a refusal and retried a
 * minute later, a few times at most, instead of leaving the queue waiting on a search that never started.
 *
 * A match empties the search a moment before its battle begins, so an empty search is not taken as a lost one: the
 * queue keeps waiting for the battle, and only gives the search up if none begins within half a minute. Treating the
 * empty update as the end once let a second search start while the first match was still opening.
 */
export const LADDER_FORMAT = 'gen9randombattle';
const RETRY_MS = 60_000, MAX_REFUSALS = 5;
export class LadderQueue {
  private ready = false;
  private searching = false;
  private confirmed = false;
  private refusals = 0;
  private gaveUp = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private settle: ReturnType<typeof setTimeout> | undefined;
  awaitingBattle = false;
  constructor(private readonly options: { dryRun: boolean; send: (command: string) => boolean; onStatus: (status: string) => void;
    /** A battle the server says we are already in, as after a restart mid-game. */
    onGameInProgress?: (room: string) => void;
    /** A confirmed search that ended with no battle, so the caller can decide whether to search again. */
    onEnded?: () => void;
    retryMs?: number; settleMs?: number }) {}
  /** A fresh login is a fresh attempt, so earlier refusals no longer count against it. */
  authenticate(): void { this.ready = true; this.refusals = 0; this.gaveUp = false; }
  disconnect(): void { clearTimeout(this.retry); clearTimeout(this.settle); this.ready = false; this.searching = false; this.confirmed = false; this.awaitingBattle = false; }
  /** Start one search, unless one is running or a battle it found has not begun. */
  search(): boolean {
    if (!this.ready || this.searching || this.awaitingBattle || this.gaveUp) return false;
    clearTimeout(this.retry);
    if (this.options.dryRun) { this.options.onStatus(`dry-run: would search the ${LADDER_FORMAT} ladder; not searching`); return false; }
    // Random formats bring their own team; clearing ours keeps a stale one from being validated against the format.
    if (!this.options.send('|/utm null') || !this.options.send(`|/search ${LADDER_FORMAT}`)) return false;
    this.searching = true; this.confirmed = false; this.awaitingBattle = true;
    this.options.onStatus(`searching the ${LADDER_FORMAT} ladder`);
    return true;
  }
  cancel(): void {
    clearTimeout(this.retry); clearTimeout(this.settle);
    if (this.searching) this.options.send(`|/cancelsearch`);
    this.searching = false; this.confirmed = false; this.awaitingBattle = false;
  }
  /** The battle the search asked for has begun. */
  started(): void { clearTimeout(this.retry); clearTimeout(this.settle); this.searching = false; this.confirmed = false; this.awaitingBattle = false; this.refusals = 0; }
  handle(message: ProtocolMessage): void {
    if (!this.ready || message.room !== null) return;
    if (message.type === 'updatesearch') {
      let data: unknown;
      try { data = JSON.parse(message.data); } catch { this.options.onStatus('malformed search update ignored'); return; }
      if (!isRecord(data)) return;
      const searching = Array.isArray(data.searching) && data.searching.includes(LADDER_FORMAT);
      const games = isRecord(data.games) ? Object.keys(data.games).filter(isBattleRoom) : [];
      if (searching) { this.confirmed = true; clearTimeout(this.settle); return; }
      if (this.searching && this.confirmed) {
        // No longer searching on the server, but still waiting: this is how a match looks before its battle opens.
        this.searching = false;
        clearTimeout(this.settle);
        this.settle = setTimeout(() => {
          if (!this.awaitingBattle) return;
          this.awaitingBattle = false; this.confirmed = false;
          this.options.onStatus('ladder search ended without a battle');
          this.options.onEnded?.();
        }, this.options.settleMs ?? 30_000);
      }
      // Only a queue with nothing pending reads the list as games to rejoin; while a match opens, its battle is on the way.
      if (!this.searching && !this.awaitingBattle) for (const room of games) this.options.onGameInProgress?.(room);
      return;
    }
    if (message.type === 'popup' && this.searching && !this.confirmed) {
      const text = message.data.replace(/\|\|/g, ' ').replace(/[^\x20-\x7E]/g, '').slice(0, 160);
      this.searching = false; this.awaitingBattle = false;
      this.refusals++;
      if (this.refusals > MAX_REFUSALS) { this.gaveUp = true; this.options.onStatus(`ladder search refused ${MAX_REFUSALS} times; not searching again: ${text}`); return; }
      this.options.onStatus(`ladder search refused (${text}); retrying in a minute`);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.search(), this.options.retryMs ?? RETRY_MS);
    }
  }
}
