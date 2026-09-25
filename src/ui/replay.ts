import { readFile } from 'node:fs/promises';
import type { BattleState } from '../battle/BattleState.js';
import type { DecisionRecord } from '../battle/DecisionLoop.js';
import { parseFrame } from '../showdown/protocol.js';
import { arenaView, type ArenaView } from './arena.js';
import { BattleFeed, type FeedEvent } from './battleFeed.js';
import { resultFromFeed, type SessionResult } from './results.js';
import { decisionView, type DecisionView } from './view.js';

export type ReplayStep =
  | { type: 'arena'; arena: ArenaView }
  | { type: 'decision'; decision: DecisionView }
  | { type: 'event'; event: FeedEvent };

/**
 * One logged battle as a timeline the live view can play back: the arena as the log recorded it at each turn and
 * decision, each decision with Jev's and the search's numbers, and every public event between them. Events carry
 * their effects as data, so the arena moves hit by hit between the recorded states and snaps back to each one.
 * Everything comes from the log; nothing is re-simulated.
 */
export async function buildReplay(path: string, room: string) {
  const text = await readFile(path, 'utf8');
  const feed = new BattleFeed();
  const steps: ReplayStep[] = [];
  let ourSide: 'p1' | 'p2' | null = null;
  let version: string | null = null;
  const snap = (state: BattleState) => {
    ourSide ??= state.mySide ?? null;
    const arena = arenaView(state, room);
    if (arena) steps.push({ type: 'arena', arena });
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row: { event?: string; line?: string; state?: BattleState; decision?: DecisionRecord; time?: string };
    try { row = JSON.parse(line); } catch { continue; }
    if (row.event === 'line' && row.line) {
      for (const message of parseFrame(`>${room}\n${row.line}`)) for (const event of feed.handle(message)) steps.push({ type: 'event', event });
    } else if ((row.event === 'turn' || row.event === 'win') && row.state) {
      snap(row.state);
    } else if (row.event === 'decision' && row.state && row.decision) {
      snap(row.state);
      try {
        const decision = decisionView(row.decision, row.state, room);
        version ??= decision.choice.instructionsVersion;
        steps.push({ type: 'decision', decision: { ...decision, time: row.time ?? decision.time } });
      } catch { /* A decision the view cannot rebuild is left out; the events around it still play. */ }
    }
  }
  const result: SessionResult | null = resultFromFeed(room, feed, undefined, ourSide);
  return { room, ourSide, version, result, steps };
}
export type Replay = Awaited<ReturnType<typeof buildReplay>>;
