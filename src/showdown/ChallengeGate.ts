import { isRecord } from './parser.js';
import type { ProtocolMessage } from './protocol.js';
const identity = (name: string) => name.replace(/^[^a-zA-Z0-9]/, '').split('@')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '');
/** `ACCEPT_CHALLENGES_FROM=*` opens the gate to whoever challenges first. */
export const ANY_CHALLENGER = '*';

export class ChallengeGate {
  private ready = false;
  private consumed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  awaitingBattle = false;
  /** A challenge held for later, when `hold` is on: the bot takes it once it is free. */
  pending: string | null = null;
  constructor(private readonly options: { username: string; opponent: string; dryRun: boolean; send: (command: string) => boolean; onStatus: (status: string) => void;
    /**
     * Hold a challenge instead of accepting it at once, for a bot that ladders too: it is taken between ladder games,
     * never during one, so a ladder game is never abandoned for it.
     */
    hold?: boolean; onPending?: (who: string) => void;
    /** An accepted challenge whose battle never began, as when the challenger withdrew first. */
    onGaveUp?: () => void; acceptTimeoutMs?: number }) {}
  authenticate(): void { this.ready = true; }
  /** Take challenges again after a battle has finished, so the bot can stay up between games. */
  rearm(): void { clearTimeout(this.timer); this.consumed = false; this.awaitingBattle = false; }
  // An accepted challenge survives a reconnect, so it is never accepted twice; only a held one is dropped.
  disconnect(): void { this.ready = false; this.pending = null; }
  /** The battle the accepted challenge asked for has begun. */
  started(): void { clearTimeout(this.timer); this.awaitingBattle = false; }
  /** Accept the held challenge, if there is one and nothing else is under way. */
  acceptPending(): boolean {
    if (!this.ready || this.consumed || !this.pending) return false;
    const who = this.pending;
    this.pending = null;
    return this.accept(who);
  }
  private accept(who: string): boolean {
    if (this.options.dryRun) {
      this.consumed = true;
      this.options.onStatus('dry-run: matching challenge observed; not accepted'); return false;
    }
    if (!this.options.send(`|/accept ${who}`)) return false;
    this.consumed = true; this.awaitingBattle = true;
    this.options.onStatus('accepted one Gen 9 Random Battle challenge');
    // A challenge withdrawn just before our accept never becomes a battle; waiting on it forever would stall the bot.
    this.timer = setTimeout(() => {
      if (!this.awaitingBattle) return;
      this.awaitingBattle = false; this.consumed = false;
      this.options.onStatus('the accepted challenge never started a battle; taking challenges again');
      this.options.onGaveUp?.();
    }, this.options.acceptTimeoutMs ?? 20_000);
    this.timer.unref?.();
    return true;
  }
  /** The challenger this gate would accept, or null when the challenge is not one we take. */
  private challenger(message: ProtocolMessage): string | null {
    const anyone = this.options.opponent === ANY_CHALLENGER;
    const us = identity(this.options.username);
    if (message.type === 'pm') {
      // Current servers send structured /challenge PMs (ordinary chat is escaped).
      const [from = '', to = '', command, format, , acceptButton, rejectButton] = message.data.split('|');
      const who = identity(from);
      if (identity(to) !== us || command !== '/challenge gen9randombattle' || format !== 'gen9randombattle' ||
          acceptButton !== '' || rejectButton !== '') return null;
      // Never answer our own challenge, however the gate is configured.
      if (!who || who === us) return null;
      return anyone || who === this.options.opponent ? who : null;
    }
    if (message.type === 'updatechallenges') {
      // Compatibility with older servers documented in PROTOCOL.md.
      let data: unknown;
      try { data = JSON.parse(message.data); } catch { this.options.onStatus('malformed challenge update ignored'); return null; }
      if (!isRecord(data) || !isRecord(data.challengesFrom)) return null;
      const from = data.challengesFrom as Record<string, unknown>;
      // Take the first name offering the one format we play, so the set is never partially accepted.
      const who = Object.keys(from).sort()
        .find(name => from[name] === 'gen9randombattle' && identity(name) && identity(name) !== us &&
          (anyone || identity(name) === this.options.opponent));
      return who ? identity(who) : null;
    }
    return null;
  }
  /** A held challenge the challenger has since withdrawn: a bare `/challenge` PM, or a challenge list without them. */
  private withdrawn(message: ProtocolMessage): boolean {
    if (!this.pending) return false;
    if (message.type === 'pm') {
      const [from = '', , command, format] = message.data.split('|');
      return identity(from) === this.pending && command === '/challenge' && !format;
    }
    if (message.type === 'updatechallenges') {
      try {
        const data = JSON.parse(message.data) as { challengesFrom?: Record<string, unknown> };
        return !!data.challengesFrom && !Object.keys(data.challengesFrom).some(name => identity(name) === this.pending);
      } catch { return false; }
    }
    return false;
  }
  handle(message: ProtocolMessage): void {
    if (!this.ready || message.room !== null) return;
    if (this.withdrawn(message)) { this.options.onStatus(`the challenge from ${this.pending} was withdrawn`); this.pending = null; return; }
    if (this.consumed) return;
    const who = this.challenger(message);
    if (!who) return;
    if (this.options.hold) {
      if (this.pending === who) return;
      this.pending = who;
      this.options.onStatus(`challenge from ${who} held until the bot is free`);
      this.options.onPending?.(who);
      return;
    }
    this.accept(who);
  }
}
