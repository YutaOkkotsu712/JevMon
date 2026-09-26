import { id } from '../pokemon/data.js';
import { DecisionLoop, type DecisionLoopOptions, type DecisionRecord } from './DecisionLoop.js';
import type { DecisionProvider } from '../decisions/DecisionProvider.js';
import { BattleTracker } from './BattleTracker.js';
import type { BattleState } from './BattleState.js';
import type { ProtocolMessage } from '../showdown/protocol.js';

export const isBattleRoom = (room: string) => /^battle-gen9randombattle-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room);
interface Options {
  room: string;
  username?: string;
  send: (command: string) => boolean;
  onStatus: (status: string) => void;
  onSnapshot: (event: string, state: BattleState) => void;
  joinTimeoutMs?: number;
  play?: { dryRun: boolean; timeoutMs?: number; provider?: DecisionProvider; search?: DecisionLoopOptions['search'];
    guards?: DecisionLoopOptions['guards']; planning?: boolean; onDecision: (record: DecisionRecord, state: BattleState) => void };
  /** Called once when this battle is decided, so a caller can free the room and take the next challenge. */
  /** Whether we won, going by the winner's name on the result line; 'tie' for a tie. */
  onFinished?: (outcome: 'won' | 'lost' | 'tie') => void;
}
/** Tracks one room; optional decisions use private server requests, never inferred state. */
export class BattleManager {
  private tracker: BattleTracker;
  private loop: DecisionLoop | undefined;
  private formatConfirmed = false;
  private singlesConfirmed = false;
  private joined = false;
  private requested = false;
  private finished = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The battle timer, asked for as soon as a request shows we are playing. The server keeps it on while any player
   * wants it, so ours holds it on against an opponent who would sooner wait us out; if it is ever reported off, it is
   * asked for again, a bounded number of times so a server that refuses cannot make it loop.
   */
  private timerAsked = false;
  private timerAsks = 0;
  constructor(private readonly options: Options) {
    if (!isBattleRoom(options.room)) throw new Error('Expected a Gen 9 Random Battle room ID');
    this.tracker = new BattleTracker(options.room, options.username);
    if (options.play && options.username) this.loop = new DecisionLoop({
      room: options.room, username: options.username, dryRun: options.play.dryRun,
      send: options.send, state: () => this.tracker.state, onStatus: options.onStatus,
      onDecision: record => {
        if (record.executedAction) this.tracker.state.ourChoice = { turn: this.tracker.state.turn,
          move: record.selectedAction.kind === 'move' ? record.selectedAction.label.split(' + Tera')[0]! : null };
        options.play!.onDecision(record, structuredClone(this.tracker.state));
      },
      ...(options.play.timeoutMs ? { timeoutMs: options.play.timeoutMs } : {}),
      ...(options.play.provider ? { provider: options.play.provider } : {}),
      ...(options.play.search ? { search: options.play.search } : {}),
      // Both reach the loop as given. Only `guards: false` used to, so the bench's skipGuards and extraGuards sides, and
      // its planning off side, played the same bot as the other side.
      ...(options.play.guards !== undefined ? { guards: options.play.guards } : {}),
      ...(options.play.planning !== undefined ? { planning: options.play.planning } : {}),
    });
  }
  ready(): void {
    if (this.requested) return;
    if (!this.options.send(`|/join ${this.options.room}`)) {
      this.options.onStatus('battle join could not be sent'); return;
    }
    this.requested = true;
    this.options.onStatus('joining configured battle');
    this.timer = setTimeout(() => {
      this.options.onStatus('battle join timed out; check room ID and access');
    }, this.options.joinTimeoutMs ?? 15_000);
  }
  disconnect(): void {
    clearTimeout(this.timer);
    this.requested = false;
    this.timerAsked = false;
    this.joined = false;
    this.formatConfirmed = false; this.singlesConfirmed = false;
    this.loop?.disconnect();
    // A rejoin replays history. Rebuild rather than applying events twice.
    this.tracker = new BattleTracker(this.options.room, this.options.username);
  }
  /** Only a player who is really choosing turns it on: in dry-run no choice is sent, so the timer would lose the game. */
  private askForTimer(): void {
    if (this.timerAsked || !this.loop || this.options.play?.dryRun || this.tracker.state.ended || this.timerAsks >= 5) return;
    if (this.options.send(`${this.options.room}|/timer on`)) {
      this.timerAsked = true; this.timerAsks++;
      this.options.onStatus('battle timer requested');
    }
  }
  handle(message: ProtocolMessage): void {
    if (message.room !== this.options.room) return;
    if (message.type === 'noinit' || message.type === 'deinit') {
      clearTimeout(this.timer); this.joined = false; this.loop?.disconnect();
      this.options.onStatus('battle unavailable or access denied'); return;
    }
    if (message.type === 'init' && message.data === 'battle') {
      clearTimeout(this.timer); this.joined = true;
      this.options.onStatus(this.loop ? 'battle joined; request-based decisions enabled' : 'battle joined; observing only');
    }
    if (!this.joined) return;
    this.tracker.handle(message);
    if (message.type === 'tier') this.formatConfirmed = message.data === '[Gen 9] Random Battle';
    if (message.type === 'gametype') this.singlesConfirmed = message.data === 'singles';
    if (message.type === 'sentchoice') this.loop?.sentChoice();
    if (message.type === 'error') this.loop?.error(message.data);
    if (message.type === 'win' || message.type === 'tie') {
      this.loop?.stop();
      // Once only: a room can repeat the result line, and rearming twice would take two challenges.
      // `|win|` names the winner, whoever it is: the log used to say "battle finished (win)" after losses too.
      const won = !!this.options.username && id(message.data) === id(this.options.username);
      if (!this.finished) { this.finished = true; this.options.onFinished?.(message.type === 'tie' ? 'tie' : won ? 'won' : 'lost'); }
    }
    if (message.type === 'request' && this.formatConfirmed && this.singlesConfirmed && !this.tracker.state.ended) {
      this.askForTimer();
      this.loop?.request(message.data);
    }
    if (message.type === 'inactiveoff' && !this.finished) { this.timerAsked = false; this.askForTimer(); }
    if (message.type === 'inactive' && /^Battle timer is ON/.test(message.data)) this.options.onStatus('battle timer is on');
    if (['turn', 'request', 'win', 'tie'].includes(message.type)) {
      this.options.onSnapshot(message.type, structuredClone(this.tracker.state));
    }
  }
}
