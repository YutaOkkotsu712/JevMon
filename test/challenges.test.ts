import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChallengeGate, ANY_CHALLENGER } from '../src/showdown/ChallengeGate.js';
import { readConfig } from '../src/config/env.js';
const update = (challengesFrom: Record<string, string>) => ({ room: null, type: 'updatechallenges', data: JSON.stringify({ challengesFrom }) });
test('only accepts one allowed opponent and exact format after authentication', () => {
  const commands: string[] = [];
  const gate = new ChallengeGate({ username: 'Bot', opponent: 'friend', dryRun: false, send: c => { commands.push(c); return true; }, onStatus: () => {} });
  gate.handle(update({ friend: 'gen9randombattle' })); assert.equal(commands.length, 0);
  gate.authenticate();
  gate.handle(update({ other: 'gen9randombattle', friend: 'gen9ou' })); assert.equal(commands.length, 0);
  gate.handle(update({ friend: 'gen9randombattle@@@customrule' })); assert.equal(commands.length, 0);
  gate.handle(update({ friend: 'gen9randombattle' }));
  gate.disconnect(); gate.authenticate(); gate.handle(update({ friend: 'gen9randombattle' }));
  assert.deepEqual(commands, ['|/accept friend']); assert.equal(gate.awaitingBattle, true);
});
test('dry-run never accepts challenges; malformed updates are contained', () => {
  const gate = new ChallengeGate({ username: 'Bot', opponent: 'friend', dryRun: true, send: () => { assert.fail('unexpected send'); }, onStatus: () => {} });
  gate.authenticate(); gate.handle({ room: null, type: 'updatechallenges', data: '{' });
  gate.handle(update({ friend: 'gen9randombattle' })); assert.equal(gate.awaitingBattle, false);
});
test('play configuration is explicit and credentials are required', () => {
  assert.equal(readConfig({}).battleMode, 'observe'); assert.equal(readConfig({}).dryRun, true);
  const credentials = { SHOWDOWN_USERNAME: 'Bot', SHOWDOWN_PASSWORD: 'password' };
  assert.throws(() => readConfig({ BATTLE_MODE: 'random' }));
  assert.throws(() => readConfig({ ...credentials, ACCEPT_CHALLENGES_FROM: 'friend' }));
  assert.throws(() => readConfig({ ...credentials, BATTLE_MODE: 'random', DRY_RUN: 'off' }));
  assert.throws(() => readConfig({ ...credentials, BATTLE_MODE: 'random', ACCEPT_CHALLENGES_FROM: 'Bot' }));
  const c = readConfig({ ...credentials, BATTLE_MODE: 'random', ACCEPT_CHALLENGES_FROM: 'My Friend', DRY_RUN: 'false' });
  assert.equal(c.opponent, 'myfriend'); assert.equal(c.dryRun, false);
});

test('current structured challenge PMs require correct sender, recipient and exact format', () => {
  const commands: string[] = [];
  const gate = new ChallengeGate({ username: 'Bot', opponent: 'friend', dryRun: false,
    send: c => { commands.push(c); return true; }, onStatus: () => {} });
  gate.authenticate();
  for (const data of [
    ' Other| Bot|/challenge gen9randombattle|gen9randombattle|||',
    ' Friend| Other|/challenge gen9randombattle|gen9randombattle|||',
    ' Friend| Bot|//challenge gen9randombattle|gen9randombattle|||',
    ' Friend| Bot|/challenge gen9randombattle@@@custom|gen9randombattle|||',
    ' Friend| Bot|/challenge gen9randombattle|gen9randombattle||Join|Reject',
    ' Friend| Bot|/challenge',
  ]) gate.handle({ room: null, type: 'pm', data });
  assert.equal(commands.length, 0);
  gate.handle({ room: null, type: 'pm', data: '+Friend| Bot|/challenge gen9randombattle|gen9randombattle|||' });
  assert.deepEqual(commands, ['|/accept friend']);
});

test('a wildcard gate accepts whoever challenges first, and still refuses our own', () => {
  const sent: string[] = [];
  const gate = new ChallengeGate({ username: 'Test Bot', opponent: ANY_CHALLENGER, dryRun: false,
    send: c => { sent.push(c); return true; }, onStatus: () => {} });
  gate.authenticate();
  gate.handle({ room: null, type: 'pm', data: ' Someone| Test Bot|/challenge gen9randombattle|gen9randombattle|||' });
  assert.deepEqual(sent, ['|/accept someone'], 'accepts a name it was never configured with');
  // One battle at a time: the gate is spent.
  gate.handle({ room: null, type: 'pm', data: ' Another| Test Bot|/challenge gen9randombattle|gen9randombattle|||' });
  assert.equal(sent.length, 1);
});

test('a wildcard gate still refuses the wrong format and our own challenge', () => {
  const sent: string[] = [];
  const make = () => new ChallengeGate({ username: 'Test Bot', opponent: ANY_CHALLENGER, dryRun: false,
    send: c => { sent.push(c); return true; }, onStatus: () => {} });
  const wrongFormat = make(); wrongFormat.authenticate();
  wrongFormat.handle({ room: null, type: 'pm', data: ' Someone| Test Bot|/challenge gen9ou|gen9ou|||' });
  const ourOwn = make(); ourOwn.authenticate();
  ourOwn.handle({ room: null, type: 'pm', data: ' Test Bot| Test Bot|/challenge gen9randombattle|gen9randombattle|||' });
  assert.deepEqual(sent, [], 'neither is accepted');
});

test('a named gate is unchanged by the wildcard support', () => {
  const sent: string[] = [];
  const gate = new ChallengeGate({ username: 'Test Bot', opponent: 'allowed', dryRun: false,
    send: c => { sent.push(c); return true; }, onStatus: () => {} });
  gate.authenticate();
  gate.handle({ room: null, type: 'pm', data: ' Stranger| Test Bot|/challenge gen9randombattle|gen9randombattle|||' });
  assert.deepEqual(sent, [], 'a name that is not the allowed one is still refused');
  gate.handle({ room: null, type: 'pm', data: ' Allowed| Test Bot|/challenge gen9randombattle|gen9randombattle|||' });
  assert.deepEqual(sent, ['|/accept allowed']);
});

test('the wildcard survives configuration, where a plain name is still normalised', () => {
  const account = { SHOWDOWN_USERNAME: 'Bot', SHOWDOWN_PASSWORD: 'test', BATTLE_MODE: 'random' };
  assert.equal(readConfig({ ...account, ACCEPT_CHALLENGES_FROM: '*' }).opponent, ANY_CHALLENGER);
  assert.equal(readConfig({ ...account, ACCEPT_CHALLENGES_FROM: ' * ' }).opponent, ANY_CHALLENGER);
  assert.equal(readConfig({ ...account, ACCEPT_CHALLENGES_FROM: 'Some One' }).opponent, 'someone');
  // The wildcard is exempt from the self-challenge check, which still guards a named account.
  assert.throws(() => readConfig({ ...account, ACCEPT_CHALLENGES_FROM: 'Bot' }));
  // A username is validated separately and cannot itself be the wildcard.
  assert.throws(() => readConfig({ SHOWDOWN_USERNAME: '*', SHOWDOWN_PASSWORD: 'test', BATTLE_MODE: 'random', ACCEPT_CHALLENGES_FROM: '*' }));
});

test('PLAY_MODE picks where battles come from, and refuses a ladder that could not end', () => {
  const base = { SHOWDOWN_USERNAME: 'Bot', SHOWDOWN_PASSWORD: 'password', BATTLE_MODE: 'jev', DRY_RUN: 'false', TYPESAFE_API_KEY: 'k' };
  assert.equal(readConfig({ ...base, ACCEPT_CHALLENGES_FROM: 'friend' }).playMode, 'challenges', 'unset, a challenger alone means challenges');
  assert.equal(readConfig({ ...base, ACCEPT_CHALLENGES_FROM: 'friend', LADDER_BATTLES: '10' }).playMode, 'ladder', 'unset, a run means ladder, as before');
  const both = readConfig({ ...base, ACCEPT_CHALLENGES_FROM: 'friend', LADDER_BATTLES: '10', PLAY_MODE: 'both' });
  assert.equal(both.playMode, 'both'); assert.equal(both.ladderBattles, 10);
  assert.equal(readConfig({ ...base, ACCEPT_CHALLENGES_FROM: 'friend', LADDER_BATTLES: '10', PLAY_MODE: 'challenges' }).ladderBattles, 0, 'a run is ignored when not laddering');
  assert.throws(() => readConfig({ ...base, PLAY_MODE: 'both', LADDER_BATTLES: '10' }), /PLAY_MODE=both needs ACCEPT_CHALLENGES_FROM/);
  assert.throws(() => readConfig({ ...base, PLAY_MODE: 'ladder' }), /needs MAX_BATTLES, or it would play without end/);
  assert.equal(readConfig({ ...base, PLAY_MODE: 'ladder', MAX_BATTLES: '30' }).ladderBattles, 0, 'no run length, ended by MAX_BATTLES');
  assert.throws(() => readConfig({ ...base, PLAY_MODE: 'sometimes' }), /PLAY_MODE must be challenges, ladder or both/);
});

test('in both mode a challenge is held until the bot is free, dropped if withdrawn, and given up if it never starts', async () => {
  const commands: string[] = [], held: string[] = [], status: string[] = [];
  let gaveUp = 0;
  const gate = new ChallengeGate({ username: 'Bot', opponent: 'friend', dryRun: false, hold: true, acceptTimeoutMs: 20,
    send: c => { commands.push(c); return true; }, onStatus: s => status.push(s), onPending: w => held.push(w), onGaveUp: () => gaveUp++ });
  gate.authenticate();
  const challenge = ' Friend| Bot|/challenge gen9randombattle|gen9randombattle|||';
  gate.handle({ room: null, type: 'pm', data: challenge });
  assert.deepEqual(commands, [], 'held, not accepted, while a ladder game might be under way');
  assert.equal(gate.pending, 'friend'); assert.deepEqual(held, ['friend']);
  gate.handle({ room: null, type: 'pm', data: challenge });
  assert.deepEqual(held, ['friend'], 'the same challenge repeated is one challenge');
  gate.handle({ room: null, type: 'pm', data: ' Friend| Bot|/challenge' });
  assert.equal(gate.pending, null, 'a bare /challenge is the challenger withdrawing it');
  assert.equal(gate.acceptPending(), false, 'nothing left to accept');
  gate.handle({ room: null, type: 'pm', data: challenge });
  assert.equal(gate.acceptPending(), true);
  assert.deepEqual(commands, ['|/accept friend']); assert.equal(gate.awaitingBattle, true);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(gate.awaitingBattle, false, 'a battle that never came does not hold the bot');
  assert.equal(gaveUp, 1);
  gate.handle({ room: null, type: 'pm', data: challenge });
  assert.equal(gate.acceptPending(), true); gate.started();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(gaveUp, 1, 'a battle that did start is not given up');
});
