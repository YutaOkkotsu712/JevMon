import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isBattleRoom } from '../battle/BattleManager.js';
import { id } from '../pokemon/data.js';
import { parseFrame } from '../showdown/protocol.js';
import { BattleFeed } from './battleFeed.js';

export interface SessionResult {
  room: string;
  opponent: string | null;
  outcome: 'win' | 'loss' | 'tie';
  turns: number;
  knockouts: { dealt: number; taken: number };
  rating: { before: number; after: number } | null;
  finishedAt?: string;
  /** The opponent's rating before the battle, from the ladder's line, for performance ratings. */
  opponentRating?: number;
  /** The build that played it, from its decisions' instructions version. */
  version?: string;
  /** The log file it was read from, which a replay is built from. */
  file?: string;
}

/** Read the result from the same public lines used by the live feed. */
export function resultFromFeed(room: string, feed: BattleFeed, username?: string, ourSide?: 'p1' | 'p2' | null): SessionResult | null {
  const r = feed.result;
  if (!r) return null;
  const us = ourSide ?? (username && id(r.names.p1) === id(username) ? 'p1' :
    username && id(r.names.p2) === id(username) ? 'p2' : null);
  if (!us) return null;
  const them = us === 'p1' ? 'p2' : 'p1';
  const ours = r.names[us];
  const rating = Object.entries(r.ratings).find(([name]) => id(name) === id(ours))?.[1] ?? null;
  const theirs = Object.entries(r.ratings).find(([name]) => id(name) === id(r.names[them] ?? ''))?.[1];
  return { room, opponent: r.names[them], outcome: r.tie ? 'tie' : id(r.winner) === id(ours) ? 'win' : 'loss',
    turns: r.turns, knockouts: { dealt: r.faints[them], taken: r.faints[us] }, rating,
    ...(theirs ? { opponentRating: theirs.before } : {}) };
}

interface LogEntry { size: number; mtimeMs: number; result: SessionResult | null }

/** Keeps the UI record across bot restarts by indexing the existing public battle logs. */
export class ResultLogIndex {
  private readonly files = new Map<string, LogEntry>();
  constructor(private readonly directory: string, private readonly username: string) {}

  async refresh(): Promise<SessionResult[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch { return []; }
    const candidates = names.flatMap(name => {
      const match = /^(battle-[a-z0-9-]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.exec(name);
      return match && isBattleRoom(match[1]!) ? [{ name, room: match[1]!, path: join(this.directory, name) }] : [];
    });
    await Promise.all(candidates.map(async file => {
      try {
        const info = await stat(file.path);
        const old = this.files.get(file.name);
        if (old?.size === info.size && old.mtimeMs === info.mtimeMs) return;
        const read = await this.read(file.path, file.room);
        const result = read ? { ...read, file: file.name } : null;
        this.files.set(file.name, { size: info.size, mtimeMs: info.mtimeMs, result });
      } catch { /* A log being removed or written must not interrupt the live view. */ }
    }));
    const byRoom = new Map<string, SessionResult>();
    for (const { result } of this.files.values()) {
      if (!result) continue;
      const previous = byRoom.get(result.room);
      if (!previous || (!previous.rating && result.rating) ||
        (Boolean(previous.rating) === Boolean(result.rating) && (result.finishedAt ?? '') > (previous.finishedAt ?? ''))) byRoom.set(result.room, result);
    }
    return [...byRoom.values()].sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '') || a.room.localeCompare(b.room));
  }

  private async read(path: string, room: string): Promise<SessionResult | null> {
    const feed = new BattleFeed();
    let finishedAt: string | undefined, version: string | undefined;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!version) version = /"instructionsVersion":"([^"]{1,80})"/.exec(line)?.[1];
      if (!line.includes('"event":"line"')) continue;
      try {
        const entry = JSON.parse(line) as { event?: string; line?: string; time?: string };
        if (entry.event !== 'line' || !entry.line) continue;
        const messages = parseFrame(`>${room}\n${entry.line}`);
        for (const message of messages) {
          if (!['player', 'turn', 'faint', 'win', 'tie', 'raw'].includes(message.type)) continue;
          feed.handle(message);
          if ((message.type === 'win' || message.type === 'tie') && entry.time) finishedAt = entry.time;
        }
      } catch { /* A partial trailing line may be in the middle of a write. */ }
    }
    const result = resultFromFeed(room, feed, this.username);
    return result ? { ...result, ...(finishedAt ? { finishedAt } : {}), ...(version ? { version } : {}) } : null;
  }
}
