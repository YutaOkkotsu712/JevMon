import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ShowdownClient } from '../src/showdown/client.js';
import { ChallengeGate, ANY_CHALLENGER } from '../src/showdown/ChallengeGate.js';
import { BattleManager } from '../src/battle/BattleManager.js';

class FakeSocket extends EventTarget {
  closed = false;
  close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

/** Poll rather than sleeping a fixed margin: these timers are milliseconds apart and the host may be busy. */
async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await delay(2);
  return condition();
}
function fixture(handler: () => void = () => {}, handshakeTimeoutMs = 1000) {
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const client = new ShowdownClient({
    url: 'wss://example.test', reconnectBaseMs: 5, handshakeTimeoutMs,
    onStatus: (status) => statuses.push(status), onMessage: handler,
    socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { client, sockets, statuses };
}

test('start is idempotent, handler failures are contained, payloads stay private', (t) => {
  const f = fixture(() => { throw new Error('secret'); });
  t.after(() => f.client.stop());
  f.client.start(); f.client.start();
  assert.equal(f.sockets.length, 1);
  f.sockets[0]!.message('|challstr|4|secret');
  f.sockets[0]!.message(new ArrayBuffer(0));
  assert.ok(f.statuses.includes('Showdown handshake received'));
  assert.ok(f.statuses.includes('message handler failed'));
  assert.ok(f.statuses.includes('ignored non-text frame'));
  assert.ok(!f.statuses.join().includes('secret'));
});

test('error and close schedule only one reconnect; stop cancels further reconnects', async (t) => {
  const f = fixture(); t.after(() => f.client.stop());
  f.client.start();
  const old = f.sockets[0]!;
  old.dispatchEvent(new Event('error'));
  old.dispatchEvent(new Event('close'));
  await delay(25);
  assert.equal(f.sockets.length, 2);
  old.message('|challstr|4|stale');
  assert.ok(!f.statuses.includes('Showdown handshake received'));
  f.sockets[1]!.close();
  f.client.stop();
  await delay(25);
  assert.equal(f.sockets.length, 2);
});

test('missing handshake closes socket and retries', async (t) => {
  const f = fixture(undefined, 10); t.after(() => f.client.stop());
  f.client.start();
  f.sockets[0]!.message('|challstr|malformed');
  assert.ok(await until(() => f.sockets.length >= 2), 'a malformed handshake must lead to a retry');
  assert.equal(f.sockets[0]!.closed, true);
  assert.ok(f.statuses.includes('handshake timed out'));
});

test('send requires an open socket and rejects command injection', (t) => {
  const sent: string[] = [];
  const socket = new FakeSocket() as FakeSocket & { readyState: number; send: (text: string) => void };
  socket.readyState = WebSocket.CONNECTING;
  socket.send = (text) => { sent.push(text); };
  const client = new ShowdownClient({ url: 'wss://example.test', onMessage: () => {}, onStatus: () => {},
    socketFactory: () => socket as unknown as WebSocket });
  t.after(() => client.stop());
  assert.equal(client.send('|/trn Bot,0,assertion'), false);
  client.start();
  assert.equal(client.send('|/trn Bot,0,assertion'), false);
  socket.readyState = WebSocket.OPEN;
  assert.equal(client.send('|/trn Bot,0,assertion\n|/command'), false);
  assert.equal(client.send('invalid'), false);
  assert.equal(client.send('|/trn Bot,0,assertion'), true);
  assert.deepEqual(sent, ['|/trn Bot,0,assertion']);
  client.stop();
  assert.equal(client.send('|/trn Bot,0,assertion'), false);
});

test('battle choices use room-prefixed transport', (t) => {
  const sent: string[] = [];
  const socket = new FakeSocket() as FakeSocket & { readyState: number; send: (text: string) => void };
  socket.readyState = WebSocket.OPEN; socket.send = text => { sent.push(text); };
  const client = new ShowdownClient({ url: 'wss://example.test', onMessage: () => {}, onStatus: () => {},
    socketFactory: () => socket as unknown as WebSocket });
  t.after(() => client.stop()); client.start();
  assert.equal(client.send('battle-gen9randombattle-1|/choose move 1 terastallize|42'), true);
  assert.equal(client.send('battle-gen9ou-1|/choose move 1|42'), false);
  assert.equal(client.send('battle-gen9randombattle-1|/choose move 1|42\n|/forfeit'), false);
  assert.equal(sent.length, 1);
});

test('the gate takes another challenge once a battle has finished', () => {
  const sent: string[] = [];
  const statuses: string[] = [];
  const gate = new ChallengeGate({ username: 'JevBot', opponent: ANY_CHALLENGER, dryRun: false,
    send: command => { sent.push(command); return true; }, onStatus: s => statuses.push(s) });
  gate.authenticate();
  const challenge = (from: string) => gate.handle({ room: null, type: 'pm',
    data: `${from}|JevBot|/challenge gen9randombattle|gen9randombattle||||` });
  challenge('Alice');
  assert.deepEqual(sent, ['|/accept alice']);
  // One battle per acceptance: a second challenger is ignored while that battle is live.
  challenge('Bob');
  assert.deepEqual(sent, ['|/accept alice'], 'still busy with the first battle');
  gate.rearm();
  assert.equal(gate.awaitingBattle, false);
  challenge('Bob');
  assert.deepEqual(sent, ['|/accept alice', '|/accept bob'], 'the next challenger is taken after rearming');
});

test('a finished battle is announced exactly once', () => {
  const finished: string[] = [];
  const manager = new BattleManager({ room: 'battle-gen9randombattle-1', username: 'JevBot',
    send: () => true, onStatus: () => {}, onSnapshot: () => {}, onFinished: outcome => finished.push(outcome) });
  manager.ready();
  const feed = (type: string, data: string) => manager.handle({ room: 'battle-gen9randombattle-1', type, data });
  feed('init', 'battle');
  feed('win', 'Someone');
  feed('win', 'Someone');
  feed('tie', '');
  assert.deepEqual(finished, ['win'], 'a repeated result line must not consume a second challenge');
});
