import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JevDecisionProvider, JEV_ENDPOINT, validateJevResponse } from '../src/decisions/JevDecisionProvider.js';
import { createBattleState } from '../src/battle/BattleState.js';
import type { DecisionInput, ProviderMetrics } from '../src/decisions/DecisionProvider.js';
import { readConfig } from '../src/config/env.js';
import type { BattleAction } from '../src/battle/LegalActionGenerator.js';
import { INSTRUCTIONS_VERSION } from '../src/decisions/instructions.js';
import { battle, ours } from './helpers.js';
import { residuals } from '../src/strategy/residual.js';
const input = (): DecisionInput => ({ state: createBattleState('battle-gen9randombattle-1'), legalActions: [
  { id: 'move-1', kind: 'move', command: 'move 1', label: 'Surf', uncertain: false },
  { id: 'move-2', kind: 'move', command: 'move 2', label: 'Protect', uncertain: false },
] });
const result = () => ({ model: 'jev-1.13.0', answers: { battle_action: { type: 'choice', choice: 'move-1',
  confidence: 0.8, probabilities: { 'move-1': 0.9, 'move-2': 0.1 } } }, usage: { input_tokens: 100, output_tokens: 20 } });
const ok: typeof fetch = async () => Response.json(result());

test('Jev uses official endpoint/schema, validates choices and tracks reported usage', async () => {
  const events: { status: string; metrics: ProviderMetrics }[] = [];
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, JEV_ENDPOINT); assert.equal(options?.method, 'POST'); assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-secret');
    const body = JSON.parse(options!.body as string);
    assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.battle_action.type, 'choice');
    assert.deepEqual(Object.keys(body.questions.battle_action.criteria), ['move-1', 'move-2']);
    assert.ok(!JSON.stringify(body).includes('test-secret'));
    return Response.json(result());
  };
  const provider = new JevDecisionProvider({ apiKey: 'test-secret', maxCalls: 2, request, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    onEvent: e => events.push(e) });
  const decision = await provider.chooseAction(input());
  assert.equal(decision.chosenAction, 'move-1'); assert.equal(decision.confidence, 0.8);
  assert.equal(provider.getMetrics().inputTokens, 100); assert.equal(provider.getMetrics().estimatedCostUsd, 0.00014);
  assert.equal(provider.getMetrics().usageIncomplete, false); assert.ok(!JSON.stringify(events).includes('test-secret'));
});

test('invalid action IDs, confidence, distributions and usage are rejected', () => {
  const mutations = [
    (r: any) => { r.answers.battle_action.choice = 'forfeit'; },
    (r: any) => { r.answers.battle_action.confidence = 2; },
    (r: any) => { r.answers.battle_action.probabilities['move-2'] = 0.8; },
    (r: any) => { delete r.answers.battle_action.probabilities['move-2']; },
    (r: any) => { r.answers.battle_action.choice = 'move-2'; },
    (r: any) => { r.usage.input_tokens = -1; },
  ];
  for (const mutate of mutations) { const r = result(); mutate(r); assert.throws(() => validateJevResponse(r, ['move-1', 'move-2'])); }
});

test('call limits include failed attempts; malformed responses retain known usage', async () => {
  let calls = 0;
  const provider = new JevDecisionProvider({ apiKey: 'test', maxCalls: 1, request: async () => {
    calls++; const r = result(); r.answers.battle_action.choice = 'bad'; return Response.json(r);
  } });
  assert.equal((await provider.chooseAction(input())).fallbackReason, 'jev_failed');
  assert.equal((await provider.chooseAction(input())).fallbackReason, 'jev_call_limit');
  assert.equal(calls, 1); assert.equal(provider.getMetrics().invalidResponses, 1);
  assert.equal(provider.getMetrics().inputTokens, 100);
});

test('timeouts abort requests and fall back; cancellation never yields a stale decision', async () => {
  const hanging: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(new Error('test-secret')), { once: true });
  });
  const keepAlive = setTimeout(() => {}, 100);
  try {
    const provider = new JevDecisionProvider({ apiKey: 'test', maxCalls: 2, timeoutMs: 5, request: hanging });
    assert.equal((await provider.chooseAction(input())).fallbackReason, 'jev_timeout');
    assert.equal(provider.getMetrics().usageIncomplete, true);
    const abort = new AbortController();
    const pending = provider.chooseAction(input(), { signal: abort.signal }); abort.abort();
    await assert.rejects(pending, { message: 'Decision cancelled' });
  } finally { clearTimeout(keepAlive); }
});

test('authentication failures disable further calls; overload backs off without paid retries', async () => {
  for (const status of [401, 429, 529]) {
    let calls = 0;
    const p = new JevDecisionProvider({ apiKey: 'test', maxCalls: 10, request: async () => { calls++; return new Response('', { status }); } });
    await p.chooseAction(input()); await p.chooseAction(input()); assert.equal(calls, 1);
  }
});

test('single options and excessive options do not make API calls', async () => {
  const p = new JevDecisionProvider({ apiKey: 'test', maxCalls: 5, request: async () => { assert.fail('unexpected call'); } });
  const i = input(); i.legalActions.pop(); await p.chooseAction(i);
  i.legalActions = Array.from({ length: 256 }, (_, k) => ({ ...input().legalActions[0]!, id: `A${k}` }));
  assert.equal((await p.chooseAction(i)).fallbackReason, 'unsupported_option_count'); assert.equal(p.getMetrics().attempts, 0);
});

test('Jev configuration requires explicit mode/key and dry-run calls default off', () => {
  const account = { SHOWDOWN_USERNAME: 'Bot', SHOWDOWN_PASSWORD: 'test' };
  assert.throws(() => readConfig({ ...account, BATTLE_MODE: 'jev', DRY_RUN: 'false' }));
  const c = readConfig({ ...account, BATTLE_MODE: 'jev' });
  assert.equal(c.jev.callsInDryRun, false);
  assert.throws(() => readConfig({ JEV_MAX_CALLS_PER_BATTLE: '-1' }));
  assert.throws(() => readConfig({ JEV_INPUT_USD_PER_MILLION: 'NaN' }));
  assert.equal(readConfig({ ...account, BATTLE_MODE: 'jev', DRY_RUN: 'false', TYPESAFE_API_KEY: 'test' }).battleMode, 'jev');
});

test('timeout and cost settings are validated before any API call', () => {
  assert.throws(() => readConfig({ JEV_TIMEOUT_MS: '0' }));
  assert.throws(() => readConfig({ JEV_TIMEOUT_MS: '10001' }));
  assert.equal(readConfig({ JEV_TIMEOUT_MS: '5000' }).jev.timeoutMs, 5000);
});

test('the sent payload evaluates every action, carries the glossary and stays inside the budget', async () => {
  const b = battle([ours('Bronzong', 88, ['Body Press', 'Psychic Noise', 'Rest', 'Iron Defense'], 'Levitate', 'Chesto Berry', 'Fighting'),
    ours('Dragapult', 78, ['Shadow Ball', 'Draco Meteor'], 'Infiltrator', 'Choice Specs', 'Ghost')], 'Azumarill');
  const legalActions: BattleAction[] = [
    { id: 'move-1', kind: 'move', command: 'move 1', label: 'Body Press', uncertain: false },
    { id: 'move-3', kind: 'move', command: 'move 3', label: 'Rest', uncertain: false },
    { id: 'switch-2', kind: 'switch', command: 'switch 2', label: 'Switch to Dragapult, L78', uncertain: false },
  ];
  let sent: { state: Record<string, any>; questions: Record<string, any> } | undefined;
  let bytes = 0;
  const provider = new JevDecisionProvider({ apiKey: 'test', maxCalls: 1, request: async (_url, options) => {
    bytes = Buffer.byteLength(options!.body as string);
    sent = JSON.parse(options!.body as string);
    const choices = Object.keys(sent!.questions.battle_action.criteria);
    return Response.json({ model: 'jev-test', answers: { battle_action: { type: 'choice', choice: choices[0],
      confidence: 1, probabilities: Object.fromEntries(choices.map((c, i) => [c, i ? 0 : 1])) } },
      usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const decision = await provider.chooseAction({ state: b.state, legalActions, request: b.payload(5, b.me().exactHP!.current) as any });
  assert.equal(decision.provider, 'jev');
  assert.ok(bytes <= 24_000, `payload is ${bytes} bytes`);
  assert.equal(decision.payloadDetail, 'reduced');
  assert.equal(decision.instructionsVersion, INSTRUCTIONS_VERSION, 'the decision records which policy text produced it');
  assert.match(sent!.questions.battle_action.instructions, /survivalIfWeStayIn/);
  assert.match(sent!.questions.battle_action.instructions, /wastedBecauseWeAreKnockedOutFirst/);
  // The surplus-damage rule must arrive with its bound, or it reads as a general preference for priority.
  assert.match(sent!.questions.battle_action.instructions, /do not trade damage for priority on a target that is not being knocked out/);
  assert.match(sent!.questions.battle_action.instructions, /not a general preference for priority/);
  assert.match(sent!.questions.battle_action.instructions, /endgame/);
  const state = sent!.state;
  assert.equal(state.actions.length, 3, 'every legal action is described');
  assert.ok(state.speedRelation.relation !== 'unknown', 'turn order reaches the model');
  assert.ok(state.incomingThreatIfWeStayIn.damagingMoves.length > 0, 'incoming damage reaches the model');
  assert.ok(state.actions[2].switchIn.ourBestDamageFromNextTurn, 'switch matchups reach the model');
  assert.equal(state.actions[1].effect.healPercentOfMaxHP, 100, 'recovery reaches the model');
  assert.match(state.glossary.essential, /conditional/i, 'the glossary states what a damage envelope assumes');
  assert.match(state.glossary.essential, /forfeits this turn/, 'and what a switch costs');
  assert.ok(!JSON.stringify(sent).includes('Test Bot'), 'account names are still excluded');
});

test('each rejection names the field that failed, so a bad reply is diagnosable', () => {
  const cases: [string, (r: any) => void, RegExp][] = [
    ['unoffered choice', r => { r.answers.battle_action.choice = 'forfeit'; }, /choice is not an offered action: "forfeit"/],
    ['confidence range', r => { r.answers.battle_action.confidence = 2; }, /confidence is not a probability: 2/],
    ['missing key', r => { delete r.answers.battle_action.probabilities['move-2']; }, /probabilities omit offered actions: \["move-2"\]/],
    ['extra key', r => { r.answers.battle_action.probabilities['move-9'] = 0; }, /probabilities include unoffered actions: \["move-9"\]/],
    ['bad sum', r => { r.answers.battle_action.probabilities['move-2'] = 0.5; }, /probabilities sum to 1\.4, not 1/],
    ['not maximal', r => { r.answers.battle_action.choice = 'move-2'; }, /chosen action is not maximal/],
    ['usage', r => { r.usage.input_tokens = -1; }, /usage\.input_tokens invalid: -1/],
    ['answer type', r => { r.answers.battle_action.type = 'text'; }, /answer type is not "choice": "text"/],
    ['no model', r => { delete r.model; }, /model missing or not a string/],
  ];
  for (const [label, mutate, expected] of cases) {
    const r = result(); mutate(r);
    assert.throws(() => validateJevResponse(r, ['move-1', 'move-2']), expected, label);
  }
  // Within rounding it is repaired, not discarded for a random move: both of these once cost a live decision.
  const rounded = result(); rounded.answers.battle_action.probabilities = { 'move-1': 0.89, 'move-2': 0.1 };
  const rescaled = validateJevResponse(rounded, ['move-1', 'move-2']);
  assert.ok(Math.abs(Object.values(rescaled.probabilities!).reduce((n, p) => n + p, 0) - 1) < 1e-9, 'rescaled to one');
  assert.match(rescaled.responseRepaired!, /summed to 0\.99 and were rescaled/);
  const tie = result(); tie.answers.battle_action.choice = 'move-2'; tie.answers.battle_action.probabilities = { 'move-1': 0.51, 'move-2': 0.49 };
  const kept = validateJevResponse(tie, ['move-1', 'move-2']);
  assert.equal(kept.chosenAction, 'move-2', 'a near-tie choice stands');
  assert.match(kept.responseRepaired!, /near tie/);
  assert.equal(validateJevResponse(result(), ['move-1', 'move-2']).responseRepaired, undefined, 'a clean reply is untouched');
  // A hostile or malformed value cannot distort the log: the excerpt is bounded and single-line.
  const long = result();
  long.answers.battle_action.choice = 'x'.repeat(500) + String.fromCharCode(10) + 'bad';
  let message = '';
  try { validateJevResponse(long, ['move-1', 'move-2']); } catch (e) { message = (e as Error).message; }
  assert.ok(message.length < 200, `message is bounded, got ${message.length}`);
  assert.ok(!message.includes(String.fromCharCode(10)), 'control characters are stripped');
});

test('an invalid response records why, and separates itself from a transport failure', async () => {
  const statuses: string[] = [];
  const invalid = new JevDecisionProvider({ apiKey: 'test', maxCalls: 2, onEvent: e => statuses.push(e.status),
    request: async () => { const r = result(); r.answers.battle_action.confidence = 5; return Response.json(r); } });
  assert.equal((await invalid.chooseAction(input())).fallbackReason, 'jev_failed');
  assert.match(invalid.getMetrics().lastInvalidResponseReason!, /confidence is not a probability: 5/);
  assert.deepEqual(statuses, ['jev_invalid_response']);
  const down: string[] = [];
  const offline = new JevDecisionProvider({ apiKey: 'test', maxCalls: 2, onEvent: e => down.push(e.status),
    request: async () => { throw new Error('socket closed'); } });
  await offline.chooseAction(input());
  assert.deepEqual(down, ['jev_failed'], 'a transport failure is not reported as an invalid response');
  assert.equal(offline.getMetrics().lastInvalidResponseReason, null);
  assert.equal(offline.getMetrics().invalidResponses, 0);
});

test('Poison Heal reads poison as healing, and the toxic counter stops applying', () => {
  const b = battle([ours('Garchomp', 78, ['Earthquake'], 'Rough Skin', 'Life Orb', 'Ground')], 'Gliscor');
  const gliscor = b.foe();
  gliscor.status = 'tox'; gliscor.toxicTurns = 5; gliscor.item = 'Toxic Orb';
  // Without the ability, six ticks of toxic is the largest number on the turn.
  gliscor.ability = 'Sand Veil';
  assert.equal(residuals(b.state, gliscor, 'p2')!.perTurnPercentOfMaxHP, -37.5);
  // With it, the same status heals a flat eighth and stops growing.
  gliscor.ability = 'Poison Heal';
  const r = residuals(b.state, gliscor, 'p2')!;
  assert.equal(r.perTurnPercentOfMaxHP, 12.5);
  assert.match(JSON.stringify(r.sources), /Poison Heal/);
});

test('a rate limit or an overload is named, and the back-off follows Retry-After within 5 to 60 seconds', async () => {
  const run = async (status: number, retryAfter?: string) => {
    const events: string[] = [];
    const p = new JevDecisionProvider({ apiKey: 'test', maxCalls: 10, onEvent: e => events.push(e.status),
      request: async () => new Response('', { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} }) });
    await p.chooseAction(input());
    return { events, seconds: p.getMetrics().lastCooldownSeconds, again: (await p.chooseAction(input())).fallbackReason };
  };
  const limited = await run(429, '10');
  assert.deepEqual(limited.events, ['jev_rate_limited (cooldown 10s)']);
  assert.equal(limited.seconds, 10); assert.equal(limited.again, 'jev_cooldown', 'no call during the back-off');
  assert.deepEqual((await run(529)).events, ['jev_overloaded (cooldown 30s)'], 'no Retry-After: thirty seconds');
  assert.equal((await run(429, '500')).seconds, 60, 'never longer than a minute');
  assert.equal((await run(429, '1')).seconds, 5, 'never shorter than five seconds');
  const other = await run(500);
  assert.equal(other.events[0], 'jev_failed (HTTP 500)', 'other failures say which');
  assert.equal(other.again, 'jev_failed', 'and do not back off: the next decision tries Jev again');
});
