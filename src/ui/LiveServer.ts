import { createServer, type Server, type ServerResponse } from 'node:http';
import { decisionView, type DecisionView } from './view.js';
import type { BattleState } from '../battle/BattleState.js';
import type { DecisionRecord } from '../battle/DecisionLoop.js';
import { PANEL_HTML } from './panel.js';
import { BattleFeed, type FeedEvent } from './battleFeed.js';
import { arenaView, type ArenaView } from './arena.js';
import type { ProtocolMessage } from '../showdown/protocol.js';
import { ResultLogIndex, resultFromFeed, type SessionResult } from './results.js';
import { buildReplay } from './replay.js';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Bump when the replay's shape changes, so cached replays are rebuilt. */
const REPLAY_FORMAT = 1;

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * A local, read-only window into what the bot is deciding and why, for the browser extension and for anyone
 * who would rather open a tab than tail a log. It only ever serves what already went to the log, it binds to
 * the loopback interface, and a failure to start is never allowed to take the battle down with it.
 */
export class LiveServer {
  private readonly decisions: DecisionView[] = [];
  private readonly streams = new Set<ServerResponse>();
  private server: Server | undefined;
  private status: string[] = [];
  private live = { room: null as string | null, turn: 0, connected: false, lastEvent: null as string | null };
  private feed: BattleFeed | null = null;
  private feedRoom: string | null = null;
  private readonly feeds = new Map<string, BattleFeed>();
  private readonly seenRooms = new Set<string>();
  private arena: ArenaView | null = null;
  private readonly results: SessionResult[] = [];
  private readonly resultLog: ResultLogIndex | null;
  constructor(private readonly options: { port: number; host?: string; onStatus: (status: string) => void; username?: string; logDirectory?: string }) {
    this.resultLog = options.username && options.logDirectory ? new ResultLogIndex(options.logDirectory, options.username) : null;
  }

  /** The port actually bound, which is what a caller needs when it asked for an ephemeral one. */
  get boundPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }
  start(): void {
    const server = createServer((request, response) => {
      // No CORS header: the page is same-origin and the extension reads it through its host permission, so any
      // other site the browser has open gets nothing. That matters because it shows our team and our choices.
      const headers = { 'cache-control': 'no-store' };
      // A site can rebind its own name to 127.0.0.1 to become same-origin, but its requests still carry that
      // name, so only loopback names are answered. Through an SSH tunnel the browser still sends 127.0.0.1.
      const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
      if (!LOOPBACK_NAMES.has(host)) { response.writeHead(403, headers).end(); return; }
      const url = (request.url ?? '/').split('?')[0];
      if (request.method !== 'GET') { response.writeHead(405, headers).end(); return; }
      if (url === '/state') {
        response.writeHead(200, { ...headers, 'content-type': 'application/json' });
        response.end(JSON.stringify({ live: this.live, status: this.status.slice(-12), decisions: this.decisions,
          arena: this.arena, feed: this.feed?.events.slice(-400) ?? [], result: this.summary(), results: this.results }));
        return;
      }
      if (url === '/events') {
        response.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
        response.write(`data: ${JSON.stringify({ live: this.live, decisions: this.decisions, arena: this.arena,
          feed: this.feed?.events.slice(-400) ?? [], result: this.summary(), results: this.results, reset: true })}\n\n`);
        this.streams.add(response);
        request.on('close', () => this.streams.delete(response));
        return;
      }
      if (url === '/battles') {
        void this.battles().then(list => {
          response.writeHead(200, { ...headers, 'content-type': 'application/json' }); response.end(JSON.stringify(list));
        }).catch(() => response.writeHead(500, headers).end());
        return;
      }
      const replayRoom = /^\/replay\/(battle-[a-z0-9-]{1,120})$/.exec(url ?? "")?.[1];
      if (replayRoom) {
        void this.replay(replayRoom).then(replay => {
          if (!replay) { response.writeHead(404, headers).end(); return; }
          response.writeHead(200, { ...headers, 'content-type': 'application/json' }); response.end(replay);
        }).catch(() => response.writeHead(500, headers).end());
        return;
      }
      if (url === '/' || url === '/index.html') {
        response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
        response.end(PANEL_HTML);
        return;
      }
      response.writeHead(404, headers).end();
    });
    // A port already in use, or any other listen failure, must not stop the bot from playing.
    server.on('error', error => {
      this.options.onStatus(`live view unavailable: ${error instanceof Error ? error.message.slice(0, 80) : 'listen failed'}`);
      this.server = undefined;
    });
    server.listen(this.options.port, this.options.host ?? '127.0.0.1', () => {
      this.options.onStatus(`live view on http://${this.options.host ?? '127.0.0.1'}:${this.options.port}`);
    });
    server.unref();
    this.server = server;
    if (this.resultLog) void this.resultLog.refresh().then(history => {
      for (const result of history) this.storeResult(result);
      this.push({ results: this.results });
    }).catch(() => this.options.onStatus('live view could not read past results'));
  }
  /** Every recorded battle with its log, newest last: the replay list and the performance view read this. */
  private async battles(): Promise<SessionResult[]> {
    if (!this.resultLog) return this.results;
    const history = await this.resultLog.refresh();
    for (const result of history) this.storeResult(result);
    return this.results;
  }
  private readonly replays = new Map<string, { key: string; json: Promise<string> }>();
  /**
   * A recorded battle's replay, as JSON. Building one reruns the decision view on every logged decision, about ten
   * seconds for a long battle, so each is kept in memory and in logs/replays, keyed to its log's size.
   */
  private async replay(room: string): Promise<string | null> {
    const dir = this.options.logDirectory;
    if (!dir) return null;
    const found = (await this.battles()).find(r => r.room === room && r.file);
    if (!found?.file) return null;
    const path = join(dir, found.file);
    const info = await stat(path);
    const key = `${REPLAY_FORMAT}:${found.file}:${info.size}`;
    const cached = this.replays.get(room);
    if (cached?.key === key) return cached.json;
    const cacheFile = join(dir, 'replays', `${room}.json`);
    const json = (async () => {
      try {
        const disk = JSON.parse(await readFile(cacheFile, 'utf8')) as { key?: string; replay?: unknown };
        if (disk.key === key && disk.replay) return JSON.stringify(disk.replay);
      } catch { /* not cached yet */ }
      const replay = await buildReplay(path, room);
      await mkdir(join(dir, 'replays'), { recursive: true }).catch(() => undefined);
      await writeFile(cacheFile, JSON.stringify({ key, replay })).catch(() => undefined);
      return JSON.stringify(replay);
    })();
    this.replays.set(room, { key, json });
    if (this.replays.size > 8) this.replays.delete(this.replays.keys().next().value!);
    return json;
  }
  private push(extra: Record<string, unknown> = { decisions: this.decisions.slice(-1) }): void {
    const frame = `data: ${JSON.stringify({ live: this.live, ...extra })}\n\n`;
    for (const stream of this.streams) { try { stream.write(frame); } catch { this.streams.delete(stream); } }
  }
  /** The result of the battle on show, from our side: who won, the knockouts each way, and our rating change. */
  private summary(feed = this.feed, room = this.feedRoom): SessionResult | null {
    return feed && room ? resultFromFeed(room, feed, this.options.username,
      this.arena?.room === room ? this.arena.us.side : null) : null;
  }
  private storeResult(result: SessionResult): void {
    const at = this.results.findIndex(r => r.room === result.room);
    if (at < 0) this.results.push(result);
    else {
      const old = this.results[at]!;
      const finishedAt = result.finishedAt ?? old.finishedAt;
      this.results[at] = { ...result, ...(finishedAt ? { finishedAt } : {}), rating: result.rating ?? old.rating };
    }
    this.results.sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '') || a.room.localeCompare(b.room));
  }
  /**
   * One public protocol line from the battle room, for the play-by-play. The caller passes only battle lines: never the
   * private request, never chat. A new room starts a new feed; the last battle's stays on show until then.
   */
  protocol(message: ProtocolMessage): void {
    try {
      if (!message.room) return;
      let feed = this.feeds.get(message.room);
      const newRoom = !feed;
      if (!feed) {
        if (this.seenRooms.has(message.room)) return;
        feed = new BattleFeed(); this.feeds.set(message.room, feed); this.seenRooms.add(message.room);
        if (this.feeds.size > 3) this.feeds.delete(this.feeds.keys().next().value!);
      }
      const shown = newRoom || message.room === this.feedRoom;
      if (newRoom) {
        this.feed = feed; this.feedRoom = message.room; this.arena = null;
        this.decisions.splice(0, this.decisions.length);
        this.push({ reset: true, decisions: [], arena: null, feed: [], result: null, results: this.results });
      }
      const hadResult = !!feed.result;
      const events: FeedEvent[] = feed.handle(message);
      const result = this.summary(feed, message.room);
      // The record is kept once per battle, and its rating filled in when the ladder's line arrives after the result.
      if (result) this.storeResult({ ...result, ...(!hadResult ? { finishedAt: new Date().toISOString() } : {}) });
      if (events.length || result) this.push({ ...(shown && events.length ? { feed: events } : {}),
        ...(shown && result ? { result } : {}), ...(result ? { results: this.results } : {}) });
    } catch { this.options.onStatus('live view could not read a battle line'); }
  }
  decision(record: DecisionRecord, state: BattleState, room: string): void {
    try {
      this.live = { room, turn: state.turn, connected: true, lastEvent: 'decision' };
      this.decisions.push(decisionView(record, state, room));
      // A long battle must not grow without bound; the log keeps the full history.
      if (this.decisions.length > 60) this.decisions.splice(0, this.decisions.length - 60);
      this.push();
    } catch { this.options.onStatus('live view could not render a decision'); }
  }
  snapshot(event: string, state: BattleState, room: string): void {
    this.live = { room, turn: state.turn, connected: true, lastEvent: event };
    try { this.arena = arenaView(state, room); } catch { this.options.onStatus('live view could not render the arena'); }
    this.push({ arena: this.arena });
  }
  note(status: string): void {
    this.status.push(`${new Date().toISOString().slice(11, 19)} ${status}`);
    if (this.status.length > 40) this.status.splice(0, this.status.length - 40);
  }
  stop(): void { for (const s of this.streams) s.end(); this.streams.clear(); this.server?.close(); }
}
