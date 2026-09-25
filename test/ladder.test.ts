import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LadderQueue } from '../src/showdown/LadderQueue.js';
import { parseFrame } from '../src/showdown/protocol.js';
import { readConfig } from '../src/config/env.js';

const frame = (line: string) => parseFrame(line)[0]!;
/** Polls rather than sleeping a fixed time, so a busy machine delays the test instead of failing it. */
const until = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(r => setTimeout(r, 10)); };
/** The first search update after login, listing no games: the server's word that a search may start. */
const synced = (q: LadderQueue) => q.handle(frame('|updatesearch|{"searching":[],"games":null}'));
const queue = (dryRun = false, retryMs = 5) => {
  const sent: string[] = [], status: string[] = [], games: string[] = [];
  const q = new LadderQueue({ dryRun, retryMs, send: c => { sent.push(c); return true; }, onStatus: s => status.push(s), onGameInProgress: r => games.push(r) });
  return { q, sent, status, games };
};

test('the server messages the queue reads arrive as global protocol messages', () => {
  assert.deepEqual(frame('|updatesearch|{"searching":["gen9randombattle"],"games":null}'),
    { room: null, type: 'updatesearch', data: '{"searching":["gen9randombattle"],"games":null}' });
  assert.equal(frame('|popup|You are already searching.').type, 'popup');
});

test('one search at a time, only once logged in, and never in dry-run', () => {
  const { q, sent } = queue();
  assert.equal(q.search(), false, 'not before authentication');
  q.authenticate();
  assert.equal(q.search(), false, 'nor before the server lists the games we are in');
  synced(q);
  assert.equal(q.search(), true);
  assert.deepEqual(sent, ['|/utm null', '|/search gen9randombattle']);
  assert.equal(q.search(), false, 'a second search while one runs is refused locally');
  q.started();
  assert.equal(q.awaitingBattle, false);
  const dry = queue(true); dry.q.authenticate(); synced(dry.q);
  assert.equal(dry.q.search(), false); assert.deepEqual(dry.sent, []);
  q.disconnect(); dry.q.disconnect();
});

test('a match empties the search before its battle opens, so the queue keeps waiting for it', async () => {
  const ended: number[] = [];
  const sent: string[] = [], games: string[] = [];
  const q = new LadderQueue({ dryRun: false, settleMs: 30, send: c => { sent.push(c); return true; }, onStatus: () => {},
    onGameInProgress: r => games.push(r), onEnded: () => ended.push(1) });
  q.authenticate(); synced(q); q.search();
  q.handle(frame('|updatesearch|{"searching":["gen9randombattle"],"games":null}'));
  // What Showdown sent on 23 September: the search emptied with no game listed, then the game, then the battle.
  q.handle(frame('|updatesearch|{"searching":[],"games":null}'));
  assert.equal(q.awaitingBattle, true, 'an empty search is how a match looks before its battle opens');
  assert.equal(q.search(), false, 'so no second search starts');
  q.handle(frame('|updatesearch|{"searching":[],"games":{"battle-gen9randombattle-2686420235":"[Gen 9] Random Battle"}}'));
  assert.deepEqual(games, [], 'the opening battle is not mistaken for one to rejoin');
  q.started();
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(ended, [], 'a battle began, so the search did not end empty-handed');

  // A confirmed search that vanishes with no battle is given up after the settling time, and the caller decides what next.
  q.search();
  q.handle(frame('|updatesearch|{"searching":["gen9randombattle"],"games":null}'));
  q.handle(frame('|updatesearch|{"searching":[],"games":null}'));
  await until(() => ended.length === 1);
  assert.equal(q.awaitingBattle, false);
  // With nothing pending, a listed game is one we are in and not playing: after a restart, say.
  q.handle(frame('|updatesearch|{"searching":[],"games":{"battle-gen9randombattle-456-abcpw":"[Gen 9] Random Battle","battle-gen9ou-1":"[Gen 9] OU"}}'));
  assert.deepEqual(games, ['battle-gen9randombattle-456-abcpw'], 'only a Random Battle room is rejoined');
  q.disconnect();
});

test('after a restart the game in progress is rejoined before any search, and silence still lets one start', async () => {
  // 2687707629: a restart mid-game searched at once; the running game was taken for the match and the search, still
  // open on the server, matched a second game that the timer lost.
  const order: string[] = [];
  const q = new LadderQueue({ dryRun: false, send: () => true, onStatus: () => {},
    onGameInProgress: r => order.push(`rejoin ${r}`), onSynced: () => order.push('synced') });
  q.authenticate();
  q.handle(frame('|updatesearch|{"searching":[],"games":{"battle-gen9randombattle-2687705634":"[Gen 9] Random Battle"}}'));
  assert.deepEqual(order, ['rejoin battle-gen9randombattle-2687705634', 'synced'], 'the game first, then the go-ahead');
  q.handle(frame('|updatesearch|{"searching":[],"games":null}'));
  assert.equal(order.length, 2, 'synced once per login');
  q.disconnect();
  const quiet: string[] = [];
  const r = new LadderQueue({ dryRun: false, syncMs: 10, send: () => true, onStatus: () => {}, onSynced: () => quiet.push('synced') });
  r.authenticate();
  assert.equal(r.search(), false);
  await until(() => quiet.length === 1);
  assert.equal(r.search(), true, 'a server that never lists games does not block the ladder');
  r.disconnect();
});

test('a refused search is retried a minute later, and given up after repeated refusals', async () => {
  const { q, sent, status } = queue(false, 5);
  q.authenticate(); synced(q); q.search();
  q.handle(frame('|popup|Due to high load, you are limited to 12 battles every 3 minutes.'));
  assert.match(status.at(-1)!, /refused \(Due to high load.*retrying/);
  await until(() => sent.filter(c => c.startsWith('|/search')).length === 2);
  assert.equal(sent.filter(c => c.startsWith('|/search')).length, 2, 'retried');
  q.handle(frame('|updatesearch|{"searching":["gen9randombattle"],"games":null}'));
  q.handle(frame('|popup|An unrelated message.'));
  assert.equal(q.awaitingBattle, true, 'a popup after the search is confirmed is not a refusal');
  q.cancel();
  assert.equal(sent.at(-1), '|/cancelsearch');
  for (let i = 0; i < 6; i++) { q.search(); q.handle(frame('|popup|Refused.')); }
  await new Promise(r => setTimeout(r, 50));
  assert.match(status.at(-1)!, /refused 5 times; not searching again/);
  q.disconnect();
});

test('LADDER_BATTLES is validated and needs a decision mode', () => {
  const credentials = { SHOWDOWN_USERNAME: 'Bot', SHOWDOWN_PASSWORD: 'password', BATTLE_MODE: 'random' };
  assert.equal(readConfig({}).ladderBattles, 0);
  assert.equal(readConfig({ ...credentials, LADDER_BATTLES: '10' }).ladderBattles, 10);
  assert.throws(() => readConfig({ ...credentials, LADDER_BATTLES: '-1' }), /LADDER_BATTLES/);
  assert.throws(() => readConfig({ ...credentials, LADDER_BATTLES: '2.5' }), /LADDER_BATTLES/);
  assert.throws(() => readConfig({ LADDER_BATTLES: '10' }), /Ladder mode requires a decision mode/);
});

import { routeBattleInit } from '../src/showdown/battleRouting.js';

test('a battle start is followed when renamed, adopted while laddering, and counted only when we asked for it', () => {
  const base = { current: null, finished: new Set<string>(), challengeAwaiting: false, laddering: true, ladderAwaiting: false };
  const room = 'battle-gen9randombattle-2686420235', hidden = `${room}-1e8iuubgotks5eh502057xj9oh2qwg7pw`;
  assert.deepEqual(routeBattleInit(room, { ...base, ladderAwaiting: true }), { kind: 'adopt', sought: true });
  assert.deepEqual(routeBattleInit(hidden, { ...base, current: room }), { kind: 'renamed', from: room }, 'hiding a battle renames it; it is the same game');
  assert.deepEqual(routeBattleInit('battle-gen9randombattle-2686420291', { ...base, current: room }), { kind: 'ignore' }, 'one battle at a time');
  assert.deepEqual(routeBattleInit(hidden, base), { kind: 'adopt', sought: false }, 'a game the server opened for us is played, not left to the timer');
  assert.deepEqual(routeBattleInit(room, { ...base, finished: new Set([room]) }), { kind: 'ignore' });
  assert.deepEqual(routeBattleInit(room, { ...base, laddering: false }), { kind: 'ignore' }, 'challenge mode keeps to the challenge it accepted');
  assert.deepEqual(routeBattleInit(room, { ...base, laddering: false, challengeAwaiting: true }), { kind: 'adopt', sought: true });
});

import { mkdtempSync, readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock, releaseInstanceLock, LOCK_FILE } from '../src/logging/instanceLock.js';

test('only one bot runs from a folder at a time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-lock-'));
  const living = new Set([100, 200]);
  const alive = (pid: number) => living.has(pid);
  assert.deepEqual(acquireInstanceLock(dir, 100, alive), { ok: true });
  assert.deepEqual(acquireInstanceLock(dir, 200, alive), { ok: false, holder: 100 }, 'a second copy is refused while the first runs');
  releaseInstanceLock(dir, 200);
  assert.equal(read(join(dir, LOCK_FILE), 'utf8').trim(), '100', 'and cannot release a lock it does not hold');
  living.delete(100);
  assert.deepEqual(acquireInstanceLock(dir, 200, alive), { ok: true }, 'a dead holder is taken over');
  assert.deepEqual(acquireInstanceLock(dir, 200, alive), { ok: true }, 'a lock naming our own pid is stale, as after a container restart');
  releaseInstanceLock(dir, 200);
  assert.deepEqual(acquireInstanceLock(dir, 300, () => true), { ok: true }, 'released, it is free');
});
