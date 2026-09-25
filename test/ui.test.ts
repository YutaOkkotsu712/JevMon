import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionView } from '../src/ui/view.js';
import { LiveServer } from '../src/ui/LiveServer.js';
import type { DecisionRecord } from '../src/battle/DecisionLoop.js';
import { battle, ours } from './helpers.js';
import { buildJevPayload, PAYLOAD_BUDGET_BYTES } from '../src/decisions/JevDecisionProvider.js';

function fixture() {
  const b = battle([
    ours('Garganacl', 80, ['Protect', 'Salt Cure', 'Body Press'], 'Purifying Salt', 'Leftovers', 'Fairy'),
    ours('Banette', 93, ['Poltergeist'], 'Insomnia', 'Life Orb', 'Ghost'),
  ], 'Keldeo');
  const legalActions = [
    { id: 'move-1', kind: 'move' as const, command: 'move 1', label: 'Protect', uncertain: false },
    { id: 'move-2', kind: 'move' as const, command: 'move 2', label: 'Salt Cure', uncertain: false },
    { id: 'switch-2', kind: 'switch' as const, command: 'switch 2', label: 'Switch to Banette, L93', uncertain: false },
  ];
  const record: DecisionRecord = {
    rqid: 7, legalActions, selectedAction: legalActions[1]!, executedAction: 'move 2',
    dryRun: false, fallback: false, latencyMs: 412,
    providerResult: { chosenAction: 'move-2', provider: 'jev', confidence: 0.6,
      probabilities: { 'move-1': 0.1, 'move-2': 0.6, 'switch-2': 0.3 } } as never,
    skippedDominatedMove: { from: 'move-1', to: 'move-2', reason: 'protected three turns in a row' },
  } as DecisionRecord;
  return { b, record };
}

test('a decision view carries the choice, the ranking and the guard that overruled it', () => {
  const { b, record } = fixture();
  const v = decisionView(record, b.state, 'battle-gen9randombattle-test');
  assert.equal(v.choice.label, 'Salt Cure');
  assert.equal(v.choice.executed, 'move 2');
  assert.equal(v.guard!.kind, 'move');
  assert.equal(v.guard!.from, 'move-1');
  // Ranked by the provider's own probabilities, so the reader sees what it actually preferred.
  assert.deepEqual(v.ranked.map(a => a.id), ['move-2', 'switch-2', 'move-1']);
  assert.equal(v.ranked[0]!.chosen, true);
  assert.equal(v.ranked.find(a => a.id === 'move-1')!.skippedByGuard, 'protected three turns in a row');
  assert.equal(v.featuresUnavailable, false, 'the request is rebuilt from the state, as the replay script does');
  assert.equal(v.us!.team.length, 2);
  assert.ok(v.them!.team.some(p => p.species === 'Keldeo'));
});

test('a view is still produced when the feature layer cannot run', () => {
  const { b, record } = fixture();
  // A state with no side of our own is the shape a reconnect can briefly produce.
  const broken = structuredClone(b.state) as typeof b.state & { mySide: null };
  broken.mySide = null;
  const v = decisionView(record, broken, 'room');
  assert.equal(v.featuresUnavailable, true);
  assert.equal(v.choice.label, 'Salt Cure', 'the decision itself is never lost to a feature failure');
  assert.equal(v.us, null);
});

test('the live view serves state and the page, and refuses everything else', async (t) => {
  const statuses: string[] = [];
  // Port 0 lets the OS pick a free one, so this can never collide with a real run or another test.
  const server = new LiveServer({ port: 0, onStatus: s => statuses.push(s) });
  server.start();
  t.after(() => server.stop());
  let base = '';
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      if (server.boundPort) {
        base = `http://127.0.0.1:${server.boundPort}`;
        try { return await fetch(`${base}/state`); } catch { /* still coming up */ }
      }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('the live view never started');
  };
  const empty = await (await ready()).json() as { decisions: unknown[] };
  assert.deepEqual(empty.decisions, []);
  const { b, record } = fixture();
  server.decision(record, b.state, 'battle-gen9randombattle-test');
  const after = await (await fetch(`${base}/state`)).json() as { decisions: { choice: { label: string } }[] };
  assert.equal(after.decisions.length, 1);
  assert.equal(after.decisions[0]!.choice.label, 'Salt Cure');
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await page.text(), /Jev's choice/);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/state`, { method: 'POST' })).status, 405, 'nothing here accepts a write');
  // Other sites must not be able to read our team and choices while the view is open.
  assert.equal(page.headers.get('access-control-allow-origin'), null, 'no cross-origin reads');
  const rebound = await new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.boundPort!, path: '/state', headers: { host: 'attacker.example:8733' } },
      res => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
  });
  assert.equal(rebound, 403, 'a DNS-rebound name is refused even though the connection is loopback');
  const tunnelled = await new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port: server.boundPort!, path: '/state', headers: { host: 'localhost:9000' } },
      res => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
  });
  assert.equal(tunnelled, 200, 'a loopback name on another local port, as a tunnel gives, is answered');
});

test('an oversized payload is sent at the smallest tier rather than discarded for a random move', () => {
  const b = battle([
    ours('Garganacl', 80, ['Protect', 'Salt Cure', 'Body Press'], 'Purifying Salt', 'Leftovers', 'Fairy'),
    ours('Banette', 93, ['Poltergeist'], 'Insomnia', 'Life Orb', 'Ghost'),
  ], 'Keldeo');
  const request = { rqid: 1, active: [{ moves: [{ move: 'Protect', id: 'protect' }] }],
    side: { id: 'p1', name: 'Test Bot', pokemon: [] } } as never;
  const small = [
    { id: 'move-1', kind: 'move' as const, command: 'move 1', label: 'Protect', uncertain: false },
    { id: 'switch-2', kind: 'switch' as const, command: 'switch 2', label: 'Switch to Banette', uncertain: false },
  ];
  const fits = buildJevPayload({ state: b.state, legalActions: small, request })!;
  assert.ok(fits, 'an ordinary turn always produces a payload');
  assert.equal(fits.overBudget, false);
  assert.ok(fits.bytes <= PAYLOAD_BUDGET_BYTES);
  // The criteria map grows with the action set, which is what pushes a crowded turn over our own budget.
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `move-${i + 1}`, kind: 'move' as const,
    command: `move ${i + 1}`, label: `A deliberately long action label used to inflate the request body ${i}`, uncertain: false }));
  const huge = buildJevPayload({ state: b.state, legalActions: many, request });
  assert.ok(huge, 'an oversized turn is still asked; discarding it would mean playing at random');
  assert.equal(huge.detail, 'minimal', 'it falls to the smallest tier first');
  assert.equal(huge.overBudget, true);
  assert.ok(huge.bytes > PAYLOAD_BUDGET_BYTES);
});

import { BattleFeed } from '../src/ui/battleFeed.js';
import { arenaView, spriteId } from '../src/ui/arena.js';
import { parseFrame } from '../src/showdown/protocol.js';
import { ResultLogIndex, type SessionResult } from '../src/ui/results.js';

const ROOM = 'battle-gen9randombattle-9';
const lines = (text: string) => parseFrame(`>${ROOM}\n${text}`);
const MATCH = [
  '|player|p1|TheNameIsJev|1|1090', '|player|p2|Rival|2|1100',
  '|switch|p1a: Reshiram|Reshiram, L76|100/100', '|switch|p2a: Darkrai|Darkrai, L77|100/100', '|turn|1',
  '|', '|t:|1', '|move|p2a: Darkrai|Nasty Plot|p2a: Darkrai', '|-boost|p2a: Darkrai|spa|2',
  '|move|p1a: Reshiram|Blue Flare|p2a: Darkrai', '|-damage|p2a: Darkrai|55/100',
  '|', '|-heal|p2a: Darkrai|61/100|[from] item: Leftovers', '|-damage|p1a: Reshiram|88/100|[from] psn', '|upkeep', '|turn|2',
  '|', '|move|p2a: Darkrai|Dark Pulse|p1a: Reshiram', '|-supereffective|p1a: Reshiram', '|-damage|p1a: Reshiram|0 fnt', '|faint|p1a: Reshiram',
  '|win|Rival', '|raw|TheNameIsJev&apos;s rating: 1090 &rarr; <strong>1071</strong><br />(-19 for losing)',
].join('\n');

test('the play-by-play narrates moves, stat stages, the end of the turn and the result', () => {
  const feed = new BattleFeed();
  for (const m of lines(MATCH)) feed.handle(m);
  const text = feed.events.map(e => `${e.turn}:${e.phase}:${e.side ?? '-'}:${e.tone}:${e.text}${e.setup ? ' [setup]' : ''}`);
  assert.ok(text.includes('1:action:p2:move:Darkrai used Nasty Plot [setup]'), 'a self-boosting move is marked as setting up');
  assert.ok(text.includes('1:action:p2:boost:Darkrai\'s Sp. Atk rose sharply: now +2'));
  assert.ok(text.includes('1:action:p2:damage:Darkrai took damage: −45% → 55%'));
  assert.ok(text.includes('1:end:p2:heal:Darkrai restored HP with Leftovers: +6% → 61%'), 'residual healing is placed at the end of the turn');
  assert.ok(text.includes('1:end:p1:damage:Reshiram was hurt by poison: −12% → 88%'));
  assert.ok(text.includes('2:action:p1:faint:Reshiram fainted'));
  assert.ok(text.includes('2:action:-:result:Rival won the battle'));
  assert.ok(text.includes('2:action:-:result:TheNameIsJev\'s rating: 1090 → 1071 (-19)'));
  assert.deepEqual(feed.result, { winner: 'Rival', tie: false, turns: 2, faints: { p1: 1, p2: 0 }, names: { p1: 'TheNameIsJev', p2: 'Rival' },
    ratings: { TheNameIsJev: { before: 1090, after: 1071 } } });
  assert.deepEqual(feed.stagesOf('p2', 'Darkrai'), { spa: 2 });
});

test('the ladder rating line accepts the apostrophe Showdown actually sends', () => {
  const feed = new BattleFeed();
  for (const m of lines(MATCH.replace('&apos;s rating', "'s rating"))) feed.handle(m);
  assert.deepEqual(feed.result?.ratings.TheNameIsJev, { before: 1090, after: 1071 });
});

test('recorded wins and ratings survive a restart and refresh as a log grows', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-ui-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, `${ROOM}-871e3ecc-dfd9-447b-af05-a6d77150c8ca.jsonl`);
  const source = MATCH.replace('&apos;s rating', "'s rating").split('\n');
  const first = source.filter(line => !line.startsWith('|raw|'));
  const record = (line: string) => JSON.stringify({ time: '2026-09-24T15:00:00.000Z', event: 'line', line }) + '\n';
  writeFileSync(file, first.map(record).join(''));
  const index = new ResultLogIndex(directory, 'then ame is jev');
  assert.deepEqual((await index.refresh()).map(r => [r.outcome, r.rating]), [['loss', null]]);
  appendFileSync(file, source.filter(line => line.startsWith('|raw|')).map(record).join(''));
  const latest = await index.refresh();
  assert.equal(latest.length, 1);
  assert.deepEqual(latest[0]!.rating, { before: 1090, after: 1071 });
});

test('nothing but the rating is taken from a raw line, and chat never becomes an event', () => {
  const feed = new BattleFeed();
  for (const m of lines('|raw|<img src=x onerror=alert(1)>\n|c|Someone|hello\n|html|<b>hi</b>')) feed.handle(m);
  assert.deepEqual(feed.events, []);
});

test('the arena shows sprites, stat stages and effects for both sides, ours first', () => {
  assert.equal(spriteId('Keldeo-Resolute'), 'keldeo-resolute');
  assert.equal(spriteId('Tauros-Paldea-Aqua'), 'tauros-paldeaaqua');
  assert.equal(spriteId('Iron Bundle'), 'ironbundle');
  const { b } = fixture();
  b.feed('|-boost|p2a: Foe|spa|2'); b.feed('|-start|p1a: Garganacl|Substitute'); b.feed('|-sidestart|p2: Foe|move: Stealth Rock');
  const a = arenaView(b.state, ROOM)!;
  assert.equal(a.us.side, 'p1');
  assert.equal(a.us.active!.sprite, 'garganacl');
  assert.deepEqual(a.them.active!.boosts, { spa: 2 });
  assert.ok(a.us.active!.effects.includes('Substitute'));
  assert.ok(Object.keys(a.them.hazards).includes('Stealth Rock'));
  assert.equal(a.outcome, null);
});

test('the live view keeps the play-by-play, the arena and the session record', async (t) => {
  const server = new LiveServer({ port: 0, onStatus: () => {}, username: 'TheNameIsJev' });
  server.start();
  t.after(() => server.stop());
  for (let i = 0; i < 200 && !server.boundPort; i++) await new Promise(r => setTimeout(r, 20));
  const base = `http://127.0.0.1:${server.boundPort}`;
  for (const m of lines(MATCH)) server.protocol(m);
  const { b } = fixture();
  server.snapshot('turn', b.state, ROOM);
  const s = await (await fetch(`${base}/state`)).json() as { feed: unknown[]; arena: { room: string } | null;
    result: { outcome: string; knockouts: { dealt: number; taken: number }; rating: { after: number } | null };
    results: unknown[] };
  assert.ok(s.feed.length > 8);
  assert.equal(s.arena!.room, ROOM);
  assert.equal(s.result.outcome, 'loss');
  assert.deepEqual(s.result.knockouts, { dealt: 0, taken: 1 });
  assert.equal(s.result.rating!.after, 1071, 'the rating line after the result fills in the record');
  assert.equal(s.results.length, 1, 'one battle, one entry, however many lines follow the result');
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /Play-by-play/); assert.match(page, /Watch live/); assert.match(page, /Jev's choice/);
});

test('the live view loads past results and a late rating cannot replace the current room', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-live-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const record = (line: string) => JSON.stringify({ time: '2026-09-24T15:00:00.000Z', event: 'line', line }) + '\n';
  writeFileSync(join(directory, `${ROOM}-871e3ecc-dfd9-447b-af05-a6d77150c8ca.jsonl`),
    MATCH.replace('&apos;s rating', "'s rating").split('\n').map(record).join(''));
  const server = new LiveServer({ port: 0, onStatus: () => {}, username: 'TheNameIsJev', logDirectory: directory });
  server.start();
  t.after(() => server.stop());
  for (let i = 0; i < 200 && !server.boundPort; i++) await new Promise(r => setTimeout(r, 20));
  const base = `http://127.0.0.1:${server.boundPort}`;
  let loaded = false;
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch(`${base}/state`)).json() as { results: SessionResult[] };
    if (s.results.length) { loaded = true; break; }
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(loaded, true, 'the persisted record is available through /state');
  for (const m of lines(MATCH)) server.protocol(m);
  const nextRoom = 'battle-gen9randombattle-10';
  for (const m of parseFrame(`>${nextRoom}\n|player|p1|TheNameIsJev|1|1071`)) server.protocol(m);
  server.protocol({ room: ROOM, type: 'raw', data: "TheNameIsJev's rating: 1090 &rarr; <strong>1071</strong>" });
  const state = await (await fetch(`${base}/state`)).json() as { result: SessionResult | null; results: SessionResult[]; feed: unknown[] };
  assert.equal(state.result, null, 'the old result does not return on the new room');
  assert.deepEqual(state.feed, [], 'the old room cannot replace the current feed');
  assert.equal(state.results.length, 1, 'replayed lines cannot duplicate a recorded battle');
  assert.equal(state.results[0]!.rating!.after, 1071);
});

test('feed events carry their effects as data, for a replay to move the arena', () => {
  const feed = new BattleFeed();
  for (const m of lines(MATCH)) feed.handle(m);
  const fx = (tone: string, text: RegExp) => feed.events.find(e => e.tone === tone && text.test(e.text))?.fx;
  assert.deepEqual(fx('switch', /Darkrai came in/), { species: 'Darkrai', sprite: 'darkrai', hp: 100, status: null });
  assert.deepEqual(fx('boost', /Darkrai/), { stat: 'spa', stage: 2 });
  assert.deepEqual(fx('damage', /Darkrai took damage/), { hp: 55 });
  assert.deepEqual(fx('faint', /Reshiram/), { hp: 0, faint: true });
});

test('a decision view puts the search beside Jev and says who decided', () => {
  const { b, record } = fixture();
  const searched = { ...record,
    search: { mode: 'blend', values: { 'move-1': { visitShare: 0.1, meanScore: 0.4 }, 'move-2': { visitShare: 0.2, meanScore: 0.5 }, 'switch-2': { visitShare: 0.7, meanScore: 0.6 } },
      worldsSearched: 16, msTotal: 800 },
    blended: { 'move-1': 0.1, 'move-2': 0.32, 'switch-2': 0.58 }, decidedBy: 'blend',
    nearTie: { searchBest: 'switch-2', chosen: 'move-2' } } as DecisionRecord;
  const v = decisionView(searched, b.state, 'battle-gen9randombattle-test');
  assert.deepEqual(v.ranked.map(a => a.id), ['switch-2', 'move-2', 'move-1'], 'ranked by the blend the choice was made on');
  assert.deepEqual(v.ranked[0]!.search, { share: 0.7, score: 0.6 });
  assert.equal(v.how.jevPick, 'Salt Cure');
  assert.equal(v.how.searchPick, 'Switch to Banette, L93');
  assert.equal(v.how.agreed, false);
  assert.deepEqual(v.how.nearTie, { searchBest: 'Switch to Banette, L93', chosen: 'Salt Cure' });
  assert.deepEqual(v.how.search, { worlds: 16, ms: 800 });
});

test('a recorded battle is listed and replayed from its log, and nothing else is served', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { b, record } = fixture();
  const state = structuredClone(b.state); state.battleId = ROOM;
  const at = (event: string, extra: object) => JSON.stringify({ time: '2026-09-25T10:00:00.000Z', event, ...extra }) + '\n';
  const source = MATCH.replace('&apos;s rating', "'s rating").split('\n');
  writeFileSync(join(directory, `${ROOM}-871e3ecc-dfd9-447b-af05-a6d77150c8cb.jsonl`),
    source.slice(0, 5).map(line => at('line', { line })).join('') + at('turn', { state }) +
    at('decision', { state, decision: { ...record, providerResult: { ...record.providerResult, instructionsVersion: 'test-v1' } } }) +
    source.slice(5).map(line => at('line', { line })).join(''));
  const server = new LiveServer({ port: 0, onStatus: () => {}, username: 'TheNameIsJev', logDirectory: directory });
  server.start();
  t.after(() => server.stop());
  let base = '';
  for (let i = 0; i < 200 && !base; i++) { if (server.boundPort) base = `http://127.0.0.1:${server.boundPort}`; else await new Promise(r => setTimeout(r, 20)); }
  const battles = await (await fetch(`${base}/battles`)).json() as SessionResult[];
  assert.equal(battles.length, 1);
  assert.equal(battles[0]!.version, 'test-v1');
  assert.equal(battles[0]!.outcome, 'loss');
  const replay = await (await fetch(`${base}/replay/${ROOM}`)).json() as { steps: { type: string }[]; result: SessionResult | null; version: string };
  assert.ok(replay.steps.some(s => s.type === 'arena') && replay.steps.some(s => s.type === 'decision') && replay.steps.some(s => s.type === 'event'));
  assert.equal(replay.result?.outcome, 'loss');
  assert.equal(replay.version, 'test-v1');
  assert.equal((await fetch(`${base}/replay/battle-gen9randombattle-404`)).status, 404, 'only a logged battle can be replayed');
  assert.equal((await fetch(`${base}/replay/..%2F..%2Fetc`)).status, 404, 'a path is never read from the request');
});
