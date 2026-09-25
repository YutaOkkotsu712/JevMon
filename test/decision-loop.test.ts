import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DecisionLoop, type DecisionRecord } from '../src/battle/DecisionLoop.js';
import { createBattleState } from '../src/battle/BattleState.js';
import type { DecisionProvider } from '../src/decisions/DecisionProvider.js';
const room = 'battle-gen9randombattle-1';
const raw = (rqid = 1, trapped = false) => JSON.stringify({ rqid,
  side: { id: 'p1', name: 'Bot', pokemon: [
    { ident: 'p1: One', details: 'Pikachu', condition: '100/100', active: true },
    { ident: 'p1: Two', details: 'Ditto', condition: '100/100', active: false },
  ] }, active: [{ trapped, moves: [{ move: 'Surf', id: 'surf', pp: 10 }, { move: 'Protect', id: 'protect', pp: 10 }] }] });
function fixture(provider: DecisionProvider = { chooseAction: async input => ({ chosenAction: input.legalActions[0]!.id }) }, dryRun = false) {
  const commands: string[] = [], records: DecisionRecord[] = [], statuses: string[] = [];
  const loop = new DecisionLoop({ room, username: 'Bot', provider, dryRun, timeoutMs: 10,
    send: c => { commands.push(c); return true; }, state: () => createBattleState(room),
    onStatus: s => statuses.push(s), onDecision: r => records.push(r) });
  return { loop, commands, records, statuses };
}
test('sends a validated request-tagged choice once and ignores stale rqids', async (t) => {
  const f = fixture(); t.after(() => f.loop.stop());
  f.loop.request(raw(2)); f.loop.request(raw(2)); await delay(0);
  f.loop.request(raw(1)); await delay(0);
  assert.deepEqual(f.commands, [`${room}|/choose switch 2|2`]);
});
test('invalid provider response, rejection and timeout fall back legally', async (t) => {
  for (const provider of [
    { chooseAction: async () => ({ chosenAction: 'forfeit' }) },
    { chooseAction: async () => { throw new Error('secret'); } },
    { chooseAction: () => new Promise<never>(() => {}) },
  ]) {
    const f = fixture(provider); t.after(() => f.loop.stop()); f.loop.request(raw()); await delay(25);
    assert.equal(f.commands.length, 1); assert.equal(f.records[0]!.fallback, true);
    assert.ok(!f.statuses.join().includes('secret'));
  }
});
test('disconnect, wait, sentchoice and end cancel pending decisions', async () => {
  for (const cancel of ['disconnect', 'wait', 'sentchoice', 'stop']) {
    const f = fixture(); f.loop.request(raw());
    if (cancel === 'disconnect') f.loop.disconnect();
    if (cancel === 'wait') f.loop.request('{"wait":true}');
    if (cancel === 'sentchoice') f.loop.sentChoice();
    if (cancel === 'stop') f.loop.stop();
    await delay(0); assert.equal(f.commands.length, 0); f.loop.stop();
  }
});
test('unavailable switch waits for revised request with same rqid', async (t) => {
  const f = fixture(); t.after(() => f.loop.stop()); f.loop.request(raw()); await delay(0);
  f.loop.error('[Unavailable choice] Cannot switch'); await delay(0); assert.equal(f.commands.length, 1);
  f.loop.request(raw(1, true)); await delay(0);
  assert.equal(f.commands[1], `${room}|/choose move 1|1`);
});
test('invalid choice retries exclude rejected actions and stop after three rejections', async (t) => {
  const f = fixture(); t.after(() => f.loop.stop()); f.loop.request(raw()); await delay(0);
  for (let i = 0; i < 4; i++) { f.loop.error('[Invalid choice] error'); await delay(0); }
  assert.equal(f.commands.length, 3); assert.equal(new Set(f.commands).size, 3);
  f.loop.request(raw()); await delay(0); assert.equal(f.commands.length, 3);
  f.loop.request(raw(2)); await delay(0); assert.equal(f.commands.length, 4);
});
test('dry-run records the choice without sending; wrong identity fails closed', async (t) => {
  const f = fixture(undefined, true); t.after(() => f.loop.stop()); f.loop.request(raw()); await delay(0);
  assert.equal(f.commands.length, 0); assert.equal(f.records[0]!.executedAction, null);
  const g = fixture(); t.after(() => g.loop.stop()); g.loop.request(raw().replace('"Bot"', '"Other"')); await delay(0);
  assert.equal(g.commands.length, 0);
});
test('new request invalidates an in-flight provider result', async (t) => {
  const f = fixture({ chooseAction: async input => { await delay(5); return { chosenAction: input.legalActions[0]!.id }; } });
  t.after(() => f.loop.stop()); f.loop.request(raw(1)); await delay(1); f.loop.request(raw(2, true)); await delay(20);
  assert.deepEqual(f.commands, [`${room}|/choose move 1|2`]);
});
