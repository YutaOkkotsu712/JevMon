import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BattleState } from '../battle/BattleState.js';
import type { DecisionRecord } from '../battle/DecisionLoop.js';
import { isBattleRoom } from '../battle/BattleManager.js';
import type { ProtocolMessage } from '../showdown/protocol.js';

export class BattleLogger {
  readonly path: string;
  private failed = false;
  constructor(directory: string, battleId: string, private readonly onError: () => void) {
    if (!isBattleRoom(battleId)) throw new Error('Invalid battle ID');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, `${battleId}-${randomUUID()}.jsonl`);
  }
  snapshot(event: string, state: BattleState, decision?: DecisionRecord): void {
    this.append({ event, state, ...(decision ? { decision } : {}) });
  }
  provider(event: { status: string; metrics: import('../decisions/DecisionProvider.js').ProviderMetrics }): void {
    this.append({ event: 'provider', ...event });
  }
  /**
   * One public battle line, as the server sent it, so a review can see what the snapshots cannot: a miss, a critical hit,
   * a flinch, an item or ability activating. The caller passes only battle lines, never the private request or chat.
   */
  line(message: ProtocolMessage): void { this.append({ event: 'line', line: `|${message.type}|${message.data}` }); }
  /** Only pass internally generated status text, not server payloads or exception messages. */
  status(message: string): void { this.append({ event: 'status', message }); }
  private append(record: object): void {
    if (this.failed) return;
    try {
      appendFileSync(this.path, JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
    } catch {
      this.failed = true;
      this.onError();
    }
  }
}
