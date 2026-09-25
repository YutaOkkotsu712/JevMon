import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { getAssertion, ShowdownAuth } from '../src/showdown/auth.js';
import { readConfig } from '../src/config/env.js';

const credentials = { username: 'Test Bot', password: 'secret&password' };
const response = (body = ']'+JSON.stringify({ actionsuccess: true, assertion: 'signed-assertion' })) => new Response(body);
const fetcher = (body?: string): typeof fetch => async () => response(body);
const tick = () => delay(0);
function fixture(request = fetcher(), timeoutMs = 1000) {
  const commands: string[] = [], statuses: string[] = [];
  let successes = 0, failures = 0;
  const auth = new ShowdownAuth({ credentials, request, timeoutMs,
    send: (command) => { commands.push(command); return true; },
    onStatus: (s) => statuses.push(s), onAuthenticated: () => successes++, onFailure: () => failures++,
  });
  return { auth, commands, statuses, get successes() { return successes; }, get failures() { return failures; } };
}
const challenge = { room: null, type: 'challstr', data: '4|challenge' };

test('official login endpoint, form encoding and redirect policy', async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://play.pokemonshowdown.com/api/login');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.redirect, 'error');
    const body = options?.body as URLSearchParams;
    assert.equal(body.get('name'), credentials.username);
    assert.equal(body.get('pass'), credentials.password);
    assert.equal(body.get('challstr'), '4|challenge');
    return response();
  };
  assert.equal(await getAssertion(credentials, challenge.data, new AbortController().signal, request), 'signed-assertion');
});

test('rejects malformed, unsuccessful and unsafe responses without exposing contents', async () => {
  for (const body of ['secret', ']null', ']{}', ']{', ']'+JSON.stringify({ assertion: 'secret', actionsuccess: false }),
    ...['', ';rejected', 'bad\nsecret', 'bad|secret'].map(assertion => ']'+JSON.stringify({ assertion }))]) {
    await assert.rejects(getAssertion(credentials, challenge.data, new AbortController().signal, fetcher(body)),
      { message: 'Showdown login failed; check credentials and service availability' });
  }
  await assert.rejects(getAssertion(credentials, challenge.data, new AbortController().signal,
    async () => new Response('secret', { status: 503 })));
});

test('requires matching named identity, suppresses duplicate challenges and ignores room messages', async (t) => {
  const f = fixture(); t.after(() => f.auth.reset());
  f.auth.handle({ ...challenge, room: 'battle-test' });
  assert.equal(f.commands.length, 0);
  f.auth.handle(challenge); f.auth.handle(challenge);
  await tick();
  assert.deepEqual(f.commands, ['|/trn Test Bot,0,signed-assertion']);
  for (const data of [' Guest 1|0|1', ' Other|1|1']) f.auth.handle({ room: null, type: 'updateuser', data });
  assert.equal(f.successes, 0);
  f.auth.handle({ room: null, type: 'updateuser', data: ' Test Bot|1|1|{}' });
  f.auth.handle(challenge);
  assert.equal(f.successes, 1);
  assert.equal(f.commands.length, 1);
  assert.ok(!f.statuses.join().includes('signed-assertion'));
});

test('disconnect cancels pending request and ignores a late assertion', async (t) => {
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const f = fixture(async (_url, options) => { signal = options?.signal; return new Promise(r => { resolve = r; }); });
  t.after(() => f.auth.reset());
  f.auth.handle(challenge);
  f.auth.reset();
  assert.equal(signal?.aborted, true);
  resolve(response()); await tick();
  assert.equal(f.commands.length, 0);
  assert.equal(f.failures, 0);
});

test('fresh challenge after reconnect logs in again', async (t) => {
  const f = fixture(); t.after(() => f.auth.reset());
  f.auth.handle(challenge); await tick(); f.auth.reset();
  f.auth.handle({ ...challenge, data: '5|new' }); await tick();
  assert.equal(f.commands.length, 2);
});

test('server rejection and missing confirmation fail safely', async (t) => {
  const f = fixture(); t.after(() => f.auth.reset());
  f.auth.handle(challenge); await tick();
  f.auth.handle({ room: null, type: 'nametaken', data: 'Test Bot|secret' });
  assert.equal(f.failures, 1);
  const timeout = fixture(fetcher(), 10); t.after(() => timeout.auth.reset());
  timeout.auth.handle(challenge); await delay(30);
  assert.equal(timeout.failures, 1);
});

test('credential configuration rejects incomplete pairs, unsafe names and insecure transport', () => {
  for (const env of [{ SHOWDOWN_USERNAME: 'Bot' }, { SHOWDOWN_PASSWORD: 'secret' },
    { SHOWDOWN_USERNAME: 'Bot\n/command', SHOWDOWN_PASSWORD: 'secret' },
    { SHOWDOWN_USERNAME: 'Bot', SHOWDOWN_PASSWORD: 'secret', SHOWDOWN_URL: 'ws://localhost' }]) {
    assert.throws(() => readConfig(env));
  }
  assert.deepEqual(readConfig({ SHOWDOWN_USERNAME: 'Test Bot', SHOWDOWN_PASSWORD: 'secret&password' }).credentials, credentials);
});
