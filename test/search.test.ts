import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { sampleWorld, toEngineState } from '../src/search/engineState.js';
import { engineName, parseSideOne, searchWorlds } from '../src/search/search.js';
import { DecisionLoop, blendChoice, type DecisionRecord } from '../src/battle/DecisionLoop.js';
import type { DecisionProvider, DecisionResult } from '../src/decisions/DecisionProvider.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { extractFeatures } from '../src/strategy/features.js';
import { readConfig } from '../src/config/env.js';
import { battle, ours, room } from './helpers.js';

const BIN = 'vendor/poke-engine/target/release/poke-engine';
const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const setup = () => {
  const roster = [ours('Terrakion', 79, ['Close Combat', 'Stone Edge', 'Earthquake'], 'Justified', 'Choice Band', 'Ground'),
    ours('Magearna', 77, ['Flash Cannon', 'Fleur Cannon'], 'Soul-Heart', 'Leftovers', 'Water')];
  const b = battle(roster, 'Sinistcha');
  const request = parseChoiceRequest(JSON.stringify(b.payload(2, roster[0]!.maxHP, 0)))!;
  return { b, roster, request, actions: generateLegalActions(request) };
};

test('our battle serialises into poke-engine\'s format, one sampled world at a time', () => {
  const { b } = setup();
  const world = sampleWorld(b.state, 'p1', seeded(7));
  assert.equal(world.unrevealed.length, 5, 'their five unseen slots are filled with sampled species');
  const { state } = toEngineState(b.state, 'p1', world);
  const [one, two, weather, terrain, trickRoom, preview] = state.split('/');
  assert.equal(weather, 'NONE;5'); assert.equal(terrain, 'NONE;5'); assert.equal(trickRoom, 'false;5'); assert.equal(preview, 'false');
  for (const side of [one!, two!]) {
    const fields = side.split('=');
    assert.equal(fields.length, 29, 'twenty-nine side fields');
    for (const p of fields.slice(0, 6)) assert.equal(p.split(',').length, 30, `thirty Pokémon fields: ${p.slice(0, 40)}`);
  }
  assert.match(one!, /^TERRAKION,79,Rock,Fighting,/);
  assert.match(two!, /^SINISTCHA,/);
  assert.match(one!, /=switch:0=false$/, 'a Pokémon that has not moved since entering last switched, which Fake Out reads');
});

test('the engine only sees what we can actually do: locked moves disabled, spent Tera spent', () => {
  const { b } = setup();
  b.feed('|move|p1a: Terrakion|Close Combat|p2a: Foe'); b.feed('|turn|3');
  const legal = { moves: new Set(['closecombat']), canSwitch: true, canTera: false };
  const { state } = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', seeded(3)), legal);
  const terrakion = state.split('/')[0]!.split('=')[0]!.split(',');
  assert.deepEqual(terrakion.slice(22, 25), ['CLOSECOMBAT;false;7', 'STONEEDGE;true;8', 'EARTHQUAKE;true;16'], 'one Close Combat spent, the others disabled');
  assert.match(state.split('/')[0]!, /=move:0=false$/, 'its last action was its first move');
  assert.ok(state.split('/')[0]!.split('=').slice(0, 6).some(p => /,true,Normal,\d+$/.test(p)), 'a spent Tera is carried on a placeholder');
});

test('a forced replacement keeps Tera available for the next turn', () => {
  const { b } = setup();
  b.state.requestKind = 'switch';
  b.me().fainted = true;
  b.me().hpPercent = 0;
  b.me().exactHP!.current = 0;
  const world = sampleWorld(b.state, 'p1', seeded(3));
  const forced = { moves: new Set<string>(), canSwitch: true, canTera: false, forcedSwitch: true };
  const { state } = toEngineState(b.state, 'p1', world, forced);
  assert.ok(state.split('/')[0]!.split('=').slice(0, 6).every(p => !/,true,Normal,\d+$/.test(p)),
    'Tera is unavailable on the replacement choice but remains unspent');
  b.state.sides.p1.team[0]!.terastallized = true;
  const used = toEngineState(b.state, 'p1', world, forced).state;
  assert.ok(used.split('/')[0]!.split('=').slice(0, 6).some(p => /,true,Normal,\d+$/.test(p)),
    'a Tera actually spent before fainting remains spent');
});

test('the blend never rules out the search\'s most-visited action on a mean pooled from other worlds', () => {
  // Self-play seed 205: a switch to Ariados drew 33% of the visits at a pooled mean of 0.908, Thunder Wave 60% at 0.457.
  const actions = setup().actions;
  const [twave, other] = [actions[0]!, actions.find(a => a.kind === 'switch')!];
  const values = Object.fromEntries(actions.map(a => [a.id, a.id === twave.id ? { visitShare: 0.6, meanScore: 0.457 }
    : a.id === other.id ? { visitShare: 0.33, meanScore: 0.908 } : { visitShare: 0.02, meanScore: 0.27 }]));
  assert.equal(blendChoice(actions, undefined, undefined, values, 1, 0).pick?.chosen, twave.id);
});

test('a pivot\'s replacement comes in free once the opponent has moved, and the engine is told so', () => {
  // After a slower U-turn the turn is over for them: the engine, told nothing, let them attack whatever came in.
  const { b } = setup();
  b.state.requestKind = 'switch';
  const pivot = { moves: new Set<string>(), canSwitch: true, canTera: false, forcedSwitch: true };
  const forceSwitch = () => toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', seeded(3)), pivot).state.split('/')[0]!.split('=')[22];
  b.foe().lastActedTurn = b.state.turn - 1;
  assert.equal(forceSwitch(), 'false', 'a faster U-turn: they have still to move, and may hit what comes in');
  b.foe().lastActedTurn = b.state.turn;
  assert.equal(forceSwitch(), 'true', 'a slower one: they have moved, so only our replacement is chosen');
  b.me().fainted = true; b.me().hpPercent = 0; b.me().exactHP!.current = 0;
  assert.equal(forceSwitch(), 'false', 'a fainted active already makes the engine offer them nothing');
});

test('engine output is parsed and mapped back onto our legal actions', () => {
  assert.deepEqual(parseSideOne('Total Iterations: 9\nside one: closecombat,4.5,9|magearna,1.0,3\nside two: x,1,1'),
    [{ name: 'closecombat', total: 4.5, visits: 9 }, { name: 'magearna', total: 1, visits: 3 }]);
  const { b, actions } = setup();
  const names = actions.map(a => engineName(a, b.state));
  assert.ok(names.includes('closecombat') && names.includes('closecombat-tera') === false && names.includes('magearna'));
});

test('search runs end to end on the real engine when it is built', { skip: !existsSync(BIN) && 'run npm run build:engine' }, async () => {
  const { b, actions } = setup();
  const result = (await searchWorlds(b.state, actions, { bin: BIN, worlds: 4, msPerWorld: 100, random: seeded(11) }))!;
  assert.equal(result.worldsSearched, 4);
  const shares = actions.map(a => result.values[a.id]!.visitShare);
  assert.ok(Math.abs(shares.reduce((n, v) => n + v, 0) - 1) < 0.05, `visit shares cover the legal actions: ${shares}`);
  // Close Combat does nothing to a Ghost type, so the search should spend less on it than on its best option. A fixed
  // cutoff failed under load: a starved search spreads its visits almost evenly, whatever it has learned.
  const close = actions.find(a => a.label === 'Close Combat')!;
  const best = Math.max(...actions.map(a => result.values[a.id]!.visitShare));
  assert.ok(result.values[close.id]!.visitShare < best, `Close Combat into Sinistcha drew ${result.values[close.id]!.visitShare}, the best ${best}`);
});

test('search values reach the payload per action', () => {
  const { b, request, actions } = setup();
  const f = extractFeatures({ state: b.state, legalActions: actions, request, search: { [actions[0]!.id]: { visitShare: 0.4, meanScore: 0.55 } } }, 'minimal');
  assert.deepEqual((f.actions[0] as { search?: unknown }).search, { share: 0.4, score: 0.55 });
});

async function decideWith(mode: 'advise' | 'blend', providerProbabilities: Record<string, number> | null) {
  const { b, request, actions } = setup();
  const records: DecisionRecord[] = [];
  const top = actions.find(a => a.label === 'Stone Edge')!, searchTop = actions.find(a => a.kind === 'switch')!;
  const provider: DecisionProvider = { async chooseAction(input): Promise<DecisionResult> {
    assert.ok(input.search, 'the provider receives the search values');
    if (!providerProbabilities) return { chosenAction: actions[0]!.id, provider: 'random', fallbackReason: 'jev_failed' };
    return { chosenAction: top.id, provider: 'jev', confidence: 0.5, probabilities: { ...providerProbabilities } };
  } };
  const values = Object.fromEntries(actions.map(a => [a.id, { visitShare: a.id === searchTop.id ? 0.9 : 0.1 / (actions.length - 1), meanScore: 0.5 }]));
  const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: true, provider, send: () => true,
    state: () => b.state, onStatus: () => {}, onDecision: r => records.push(r),
    search: { mode, timeoutMs: 1000, run: async () => ({ values, worldsSearched: 16, msTotal: 5 }) } });
  loop.request(JSON.stringify(b.payload(3, 200, 0)));
  await new Promise(resolve => setTimeout(resolve, 30));
  loop.stop();
  void request;
  return { record: records[0]!, top, searchTop };
}

test('advise leaves the choice to the provider; blend averages the two; a failed provider leaves it to search', async () => {
  const even = (ids: string[], topId: string) => Object.fromEntries(ids.map(id => [id, id === topId ? 0.6 : 0.4 / (ids.length - 1)]));
  const { actions } = setup();
  const advised = await decideWith('advise', even(actions.map(a => a.id), actions.find(a => a.label === 'Stone Edge')!.id));
  assert.equal(advised.record.selectedAction.id, advised.top.id, 'advise never overrides');
  assert.equal(advised.record.blended, undefined);
  const blend = await decideWith('blend', even(actions.map(a => a.id), actions.find(a => a.label === 'Stone Edge')!.id));
  assert.equal(blend.record.selectedAction.id, blend.searchTop.id, 'a 0.9 search share outweighs a 0.6 provider preference');
  assert.equal(blend.record.decidedBy, 'blend');
  const failed = await decideWith('blend', null);
  assert.equal(failed.record.selectedAction.id, failed.searchTop.id, 'search replaces the random fallback');
  assert.equal(failed.record.decidedBy, 'search');
});

test('search settings are validated, and off by default', () => {
  assert.equal(readConfig({}).search.mode, 'off');
  assert.equal(readConfig({ SEARCH_MODE: 'blend', SEARCH_WORLDS: '8' }).search.worlds, 8);
  assert.throws(() => readConfig({ SEARCH_MODE: 'always' }), /SEARCH_MODE must be off, advise or blend/);
  assert.throws(() => readConfig({ SEARCH_WORLDS: '0' }), /SEARCH_WORLDS must be a whole number from 1 to 64/);
});

test('the engine is told how many Protects in a row were used, and about a pending Wish', () => {
  const roster = [ours('Morpeko', 88, ['Protect', 'Aura Wheel'], 'Hunger Switch', 'Leftovers', 'Electric')];
  const b = battle(roster, 'Mamoswine');
  b.feed('|move|p1a: Morpeko|Protect|p1a: Morpeko'); b.feed('|turn|2');
  b.feed('|move|p1a: Morpeko|Protect|p1a: Morpeko'); b.feed('|turn|3');
  const ours0 = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', seeded(5))).state.split('/')[0]!.split('=');
  assert.equal(ours0[7]!.split(';')[8], '2', 'the consecutive-Protect count, which decays its success chance');
  b.state.sides.p1.slotConditions.wish = { setOnTurn: 3, healsHP: 120, from: 'Morpeko' };
  const withWish = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', seeded(5))).state.split('/')[0]!.split('=');
  assert.deepEqual([withWish[18], withWish[19]], ['2', '120'], 'a Wish set this turn heals at the end of the next');
});

test('a Rest sleeper reaches the engine with the counter it wakes on', () => {
  const b = battle([ours('Suicune', 84, ['Scald', 'Rest', 'Sleep Talk', 'Calm Mind'], 'Pressure', 'Leftovers', 'Water')], 'Garchomp');
  b.feed('|move|p1a: Suicune|Rest|p1a: Suicune'); b.feed('|-status|p1a: Suicune|slp|[from] move: Rest'); b.feed('|turn|2');
  const rest = () => toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', seeded(2))).state.split('/')[0]!.split('=')[0]!.split(',')[19];
  assert.equal(rest(), '3', 'just Rested: two turns asleep still to come');
  b.feed('|move|p1a: Suicune|Sleep Talk|p1a: Suicune'); b.feed('|turn|3');
  assert.equal(rest(), '2');
});

test('search overrules the provider only by a clear margin in its own score', async () => {
  const { b, actions } = setup();
  const top = actions.find(a => a.label === 'Stone Edge')!, searchTop = actions.find(a => a.kind === 'switch')!;
  const run = async (lead: number, theirShare = 0.3) => {
    const records: DecisionRecord[] = [];
    const provider: DecisionProvider = { async chooseAction(): Promise<DecisionResult> {
      return { chosenAction: top.id, provider: 'jev', confidence: 0.5, probabilities: Object.fromEntries(actions.map(a => [a.id, a.id === top.id ? 0.6 : 0.4 / (actions.length - 1)])) };
    } };
    const values = Object.fromEntries(actions.map(a => [a.id, { visitShare: a.id === searchTop.id ? 0.55 : a.id === top.id ? theirShare : 0.05,
      meanScore: a.id === searchTop.id ? 0.5 + lead : 0.5 }]));
    const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: true, provider, send: () => true, state: () => b.state,
      onStatus: () => {}, onDecision: r => records.push(r),
      search: { mode: 'blend', weight: 0.7, overrideMargin: 0.03, timeoutMs: 1000, run: async () => ({ values, worldsSearched: 16, msTotal: 5 }) } });
    loop.request(JSON.stringify(b.payload(3, 200, 0)));
    await new Promise(resolve => setTimeout(resolve, 30));
    loop.stop();
    return records[0]!;
  };
  const tie = await run(0.01);
  assert.equal(tie.selectedAction.id, top.id, 'a 0.01 lead on similar visits is a tie: the provider keeps its choice');
  assert.equal(tie.decidedBy, 'provider');
  const lopsided = await run(0.01, 0.1);
  assert.equal(lopsided.selectedAction.id, searchTop.id, 'four times the visits is the search settling it, whatever the score gap');
  const clear = await run(0.08);
  assert.equal(clear.selectedAction.id, searchTop.id, 'a clear lead still overrules');
  assert.equal(clear.decidedBy, 'blend');
  assert.equal(readConfig({}).search.overrideMargin, 0.03);
  assert.throws(() => readConfig({ SEARCH_OVERRIDE_MARGIN: '2' }), /SEARCH_OVERRIDE_MARGIN/);
});

test('a large search-value gap prevents a narrow blended vote for a poor action', () => {
  const actions = [
    { id: 'switch', kind: 'switch', label: 'Switch to Sylveon', command: 'switch 2', uncertain: false },
    { id: 'web', kind: 'move', label: 'Sticky Web', command: 'move 1', uncertain: false },
    { id: 'tera-web', kind: 'move', label: 'Sticky Web + Tera Electric', command: 'move 1 terastallize', uncertain: false },
  ] as const;
  const prior = { switch: 0.58, web: 0.02, 'tera-web': 0.01 };
  const values = { switch: { visitShare: 0.142, meanScore: 0.376 },
    web: { visitShare: 0.373, meanScore: 0.546 },
    'tera-web': { visitShare: 0.086, meanScore: 0.570 } };
  const picked = blendChoice([...actions], prior, 'switch', values, 0.7, 0.03);
  assert.equal(picked.pick?.chosen, 'web', 'the high provider vote cannot erase a 0.17 search-value deficit');
});

test('once the search clearly beats the provider\'s top, a near tie below it goes to the provider\'s ranking', async () => {
  const { b, actions } = setup();
  const top = actions.find(a => a.label === 'Stone Edge')!, searchTop = actions.find(a => a.kind === 'switch')!;
  const second = actions.find(a => a.kind === 'move' && a.id !== top.id)!;
  const run = async (secondScore: number) => {
    const records: DecisionRecord[] = [];
    const provider: DecisionProvider = { async chooseAction(): Promise<DecisionResult> {
      return { chosenAction: top.id, provider: 'jev', confidence: 0.5, probabilities: Object.fromEntries(actions.map(a =>
        [a.id, a.id === top.id ? 0.5 : a.id === second.id ? 0.35 : 0.15 / (actions.length - 2)])) };
    } };
    // As Meloetta's turn went: the provider's top is clearly worse, and the search's pick leads the provider's second by little.
    const values = Object.fromEntries(actions.map(a => [a.id, { visitShare: a.id === searchTop.id ? 0.5 : a.id === second.id ? 0.26 : 0.2 / (actions.length - 2),
      meanScore: a.id === searchTop.id ? 0.58 : a.id === second.id ? secondScore : 0.5 }]));
    const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: true, provider, send: () => true, state: () => b.state,
      onStatus: () => {}, onDecision: r => records.push(r),
      search: { mode: 'blend', weight: 0.7, overrideMargin: 0.03, timeoutMs: 1000, run: async () => ({ values, worldsSearched: 16, msTotal: 5 }) } });
    loop.request(JSON.stringify(b.payload(3, 200, 0)));
    await new Promise(resolve => setTimeout(resolve, 30));
    loop.stop();
    return records[0]!;
  };
  const near = await run(0.565);
  assert.equal(near.selectedAction.id, second.id, '0.015 behind the search\'s pick is a tie, and the provider preferred this');
  assert.deepEqual(near.nearTie, { searchBest: searchTop.id, chosen: second.id });
  const far = await run(0.54);
  assert.equal(far.selectedAction.id, searchTop.id, 'a clear gap leaves the search\'s pick standing');
  assert.equal(far.nearTie, undefined);
});

import { toEngineState as engineStateOf, sampleWorld as worldOf } from '../src/search/engineState.js';
import { battle as battleFor, ours as ourRow } from './helpers.js';

test('an opposing Substitute and Wish are written in the sampled set\'s own HP', () => {
  const b = battleFor([ourRow('Mewtwo', 100, ['Psystrike', 'Recover'], 'Pressure', 'Life Orb', 'Psychic')], 'Vaporeon', 86);
  // No Vaporeon set carries Substitute, so the shell arrives the way a Shed Tail passes one, without the move being revealed.
  b.feed('|move|p2a: Foe|Wish|p2a: Foe'); b.feed('|-start|p2a: Foe|Substitute'); b.feed('|turn|2');
  assert.equal(b.state.sides.p2.slotConditions.wish?.healsHP, null, 'their exact HP is unknown');
  const text = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/')[1]!;
  const fields = text.split('=');
  const mon = fields[Number(fields[6])]!.split(',');
  const max = Number(mon[7]);
  assert.ok(max > 300, `Vaporeon's own max HP, not 100: ${max}`);
  assert.equal(Number(fields[10]), Math.floor(max / 4), 'the shell is a quarter of that');
  assert.equal(Number(fields[19]), Math.floor(max / 2), 'and the Wish half of it');
});

test('in blend the provider does not see the search it is blended with, unless asked to', async () => {
  const { b, actions } = setup();
  const seen: boolean[] = [];
  const provider: DecisionProvider = { async chooseAction(input): Promise<DecisionResult> {
    seen.push(!!input.search);
    return { chosenAction: actions[0]!.id, provider: 'jev', confidence: 0.5, probabilities: Object.fromEntries(actions.map(a => [a.id, 1 / actions.length])) };
  } };
  const values = Object.fromEntries(actions.map(a => [a.id, { visitShare: 1 / actions.length, meanScore: 0.5 }]));
  const records: DecisionRecord[] = [];
  for (const inPayload of [false, true]) {
    const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: true, provider, send: () => true, state: () => b.state,
      onStatus: () => {}, onDecision: r => records.push(r),
      search: { mode: 'blend', weight: 0.7, overrideMargin: 0.03, inPayload, timeoutMs: 1000, run: async () => ({ values, worldsSearched: 16, msTotal: 5 }) } });
    loop.request(JSON.stringify(b.payload(3, 200, 0)));
    await new Promise(resolve => setTimeout(resolve, 30));
    loop.stop();
  }
  assert.deepEqual(seen, [false, true]);
  assert.deepEqual(records.map(r => r.search?.inPayload), [false, true], 'each decision records which it was, for comparing the two');
  // Shown by default in blend too: 63% of 234 ladder games with the shares, 48% of 50 without.
  assert.equal(readConfig({ SEARCH_MODE: 'blend' }).search.inPayload, true);
  assert.equal(readConfig({ SEARCH_MODE: 'advise' }).search.inPayload, true);
  assert.equal(readConfig({ SEARCH_MODE: 'blend', SEARCH_IN_PAYLOAD: 'false' }).search.inPayload, false);
});

test('the provider is not asked when the search already decides the move, which saves its credit', async () => {
  const { b, actions } = setup();
  let calls = 0;
  const provider: DecisionProvider = { async chooseAction(): Promise<DecisionResult> {
    calls++;
    return { chosenAction: actions.at(-1)!.id, provider: 'jev', confidence: 0.5, probabilities: Object.fromEntries(actions.map(a => [a.id, a === actions.at(-1) ? 0.9 : 0.1 / (actions.length - 1)])) };
  } };
  const run = async (top: number, skipProviderAtShare: number) => {
    const values = Object.fromEntries(actions.map((a, i) => [a.id, { visitShare: i === 0 ? top : (1 - top) / (actions.length - 1), meanScore: i === 0 ? 0.7 : 0.4 }]));
    const records: DecisionRecord[] = [];
    const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: true, provider, send: () => true, state: () => b.state,
      onStatus: () => {}, onDecision: r => records.push(r),
      search: { mode: 'blend', weight: 0.7, overrideMargin: 0.03, skipProviderAtShare, timeoutMs: 1000, run: async () => ({ values, worldsSearched: 16, msTotal: 5 }) } });
    loop.request(JSON.stringify(b.payload(3, 200, 0)));
    await new Promise(resolve => setTimeout(resolve, 30));
    loop.stop();
    return records[0]!;
  };
  const sure = await run(0.8, 0.7);
  assert.equal(calls, 0, 'with 80% of the visits on one action the blend follows the search anyway');
  assert.equal(sure.providerSkipped, 'search-decisive');
  assert.equal(sure.selectedAction.id, actions[0]!.id);
  assert.equal(sure.decidedBy, 'search');
  const open = await run(0.5, 0.7);
  assert.equal(calls, 1, 'a split search still asks');
  assert.equal(open.providerSkipped, undefined);
  await run(0.8, 0);
  assert.equal(calls, 2, '0 turns the saving off');
  // One legal action: a lone Pokémon with one move left to use.
  const lone = battle([ours('Terrakion', 79, ['Close Combat'], 'Justified', 'Choice Band', 'Ground')], 'Sinistcha');
  const only: DecisionRecord[] = [];
  const single = new DecisionLoop({ room, username: 'Test Bot', dryRun: true, provider, send: () => true, state: () => lone.state,
    onStatus: () => {}, onDecision: r => only.push(r) });
  single.request(JSON.stringify(lone.payload(3, 200, 0)));
  await new Promise(resolve => setTimeout(resolve, 30));
  single.stop();
  assert.equal(calls, 2, 'nothing to choose, nothing to ask');
  assert.deepEqual([only[0]!.providerSkipped, only[0]!.selectedAction.label, only[0]!.fallback], ['single-action', 'Close Combat', false]);
  assert.equal(readConfig({ SEARCH_MODE: 'blend' }).search.skipProviderAtShare, 0.7);
  assert.equal(readConfig({ SEARCH_MODE: 'blend', JEV_SKIP_AT_SEARCH_SHARE: '0' }).search.skipProviderAtShare, 0);
});

test('a near tie cannot flip the kind of action that both the provider and the search chose', () => {
  // 2687072937 turn 7: Jev wanted a switch (Stantler) and so did the search (Victreebel); the old rule played Freeze-Dry.
  const actions = [
    { id: 'stantler', kind: 'switch', label: 'Switch to Stantler', command: 'switch 3', uncertain: false },
    { id: 'victreebel', kind: 'switch', label: 'Switch to Victreebel', command: 'switch 4', uncertain: false },
    { id: 'spikes', kind: 'move', label: 'Spikes', command: 'move 1', uncertain: false },
    { id: 'freezedry', kind: 'move', label: 'Freeze-Dry', command: 'move 2', uncertain: false },
  ] as const;
  const prior = { stantler: 0.43, victreebel: 0.1, spikes: 0.07, freezedry: 0.37 };
  const values = { stantler: { visitShare: 0.076, meanScore: 0.325 }, victreebel: { visitShare: 0.32, meanScore: 0.36 },
    spikes: { visitShare: 0.156, meanScore: 0.346 }, freezedry: { visitShare: 0.127, meanScore: 0.34 } };
  assert.equal(blendChoice([...actions], prior, 'stantler', values, 0.7, 0.03).pick?.chosen, 'victreebel');
  // Split between kinds, the provider still settles a near tie, as on the turn the rule was made for: Jev 0.39 on one
  // switch, 0.36 on Hyper Voice, and the search's switch only 0.019 ahead of the attack. The attack stands.
  const split = { stantler: 0.39, victreebel: 0.02, spikes: 0.02, freezedry: 0.36 };
  const close = { stantler: { visitShare: 0.05, meanScore: 0.183 }, victreebel: { visitShare: 0.306, meanScore: 0.228 },
    spikes: { visitShare: 0.1, meanScore: 0.15 }, freezedry: { visitShare: 0.157, meanScore: 0.209 } };
  assert.equal(blendChoice([...actions], split, 'stantler', close, 0.7, 0.03).pick?.chosen, 'freezedry');
});

test('scores inside the margin are not a tie when the search gave its pick twice the visits', () => {
  // 2687148187 turn 7: Arceus-Grass at +1 with Calm Mind at 0.45 of the visits and Judgment, Jev's pick, at 0.11. The
  // scores were 0.029 apart, so Jev's attack stood; rerun, the search keeps such a pick in 71 of 75 runs.
  const actions = [
    { id: 'cm', kind: 'move', label: 'Calm Mind', command: 'move 1', uncertain: false },
    { id: 'judgment', kind: 'move', label: 'Judgment', command: 'move 2', uncertain: false },
    { id: 'recover', kind: 'move', label: 'Recover', command: 'move 3', uncertain: false },
  ] as const;
  const prior = { cm: 0.19, judgment: 0.61, recover: 0.2 };
  const values = { cm: { visitShare: 0.452, meanScore: 0.353 }, judgment: { visitShare: 0.114, meanScore: 0.324 }, recover: { visitShare: 0.1, meanScore: 0.3 } };
  assert.equal(blendChoice([...actions], prior, 'judgment', values, 0.7, 0.03).pick?.chosen, 'cm');
  const even = { ...values, cm: { visitShare: 0.4, meanScore: 0.353 }, judgment: { visitShare: 0.3, meanScore: 0.324 } };
  assert.equal(blendChoice([...actions], prior, 'judgment', even, 0.7, 0.03).pick?.chosen, 'judgment', 'visits this close are a real tie: the provider settles it');
});

test('a Tera is played only when the search ranks it above the same move without Tera', () => {
  // 2687148187 turn 2: Rhyperior's Earthquake + Tera Ground with all six of ours standing; the search had the plain
  // Earthquake at 0.316 of the visits and the Tera at 0.144, and Jev's pick stood on the score margin.
  const actions = [
    { id: 'move-1', kind: 'move', label: 'Earthquake', command: 'move 1', uncertain: false },
    { id: 'move-1-terastallize', kind: 'move', label: 'Earthquake + Tera Ground', command: 'move 1 terastallize', uncertain: false },
    { id: 'move-2', kind: 'move', label: 'Stone Edge', command: 'move 2', uncertain: false },
  ] as const;
  const prior = { 'move-1': 0.2, 'move-1-terastallize': 0.7, 'move-2': 0.1 };
  const values = { 'move-1': { visitShare: 0.316, meanScore: 0.628 }, 'move-1-terastallize': { visitShare: 0.144, meanScore: 0.613 }, 'move-2': { visitShare: 0.2, meanScore: 0.6 } };
  const held = blendChoice([...actions], prior, 'move-1-terastallize', values, 0.7, 0.03).pick!;
  assert.equal(held.chosen, 'move-1');
  assert.deepEqual(held.teraHeldBack, { from: 'move-1-terastallize', to: 'move-1' });
  const wanted = { ...values, 'move-1-terastallize': { visitShare: 0.4, meanScore: 0.65 } };
  const played = blendChoice([...actions], prior, 'move-1-terastallize', wanted, 0.7, 0.03).pick!;
  assert.equal(played.chosen, 'move-1-terastallize', 'the search wants the Tera too');
  assert.equal(played.teraHeldBack, undefined);
});

test('a guard that skips a Tera falls back to the same move without it, not to the next-ranked action', async () => {
  // 2687217753: Flamigo's skipped Tera Close Combat fell to U-turn, which Jev had ranked 0.07 to plain Close Combat's 0.05.
  const team = [ourRow('Basculin', 86, ['Wave Crash', 'Aqua Jet', 'Flip Turn', 'Psychic Fangs'], 'Adaptability', 'Choice Band', 'Water'),
    ourRow('Snorlax', 84, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal'), ourRow('Garchomp', 77, ['Earthquake'], 'Rough Skin', 'Life Orb', 'Ground'),
    ourRow('Clefable', 85, ['Moonblast'], 'Magic Guard', 'Leftovers', 'Steel')];
  const b = battleFor(team, 'Snorlax', 85);
  const payload = b.payload(3, team[0]!.maxHP, 0) as ReturnType<typeof b.payload> & { active: { canTerastallize?: string }[] };
  payload.active[0]!.canTerastallize = 'Water';
  const records: DecisionRecord[] = [];
  const provider: DecisionProvider = { async chooseAction(input): Promise<DecisionResult> {
    const id = (label: string) => input.legalActions.find(a => a.label === label)!.id;
    return { chosenAction: id('Wave Crash + Tera Water'), provider: 'jev', confidence: 0.5, probabilities: Object.fromEntries(input.legalActions.map(a =>
      [a.id, a.label === 'Wave Crash + Tera Water' ? 0.7 : a.label === 'Flip Turn' ? 0.1 : a.label === 'Wave Crash' ? 0.05 : 0.01])) };
  } };
  const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: true, provider, send: () => true, state: () => b.state,
    onStatus: () => {}, onDecision: r => records.push(r) });
  loop.request(JSON.stringify(payload));
  await new Promise(resolve => setTimeout(resolve, 30));
  loop.stop();
  assert.equal(records[0]!.selectedAction.label, 'Wave Crash', 'the guard objects to the Tera, not to Wave Crash');
  assert.match(records[0]!.skippedDominatedMove!.reason, /Tera Water/);
});

test('a guard that names what beats the skipped move falls back to it, not to the next-ranked switch', async () => {
  // 2686662572: a Roost skipped for a certain Knock Off fell back to the blend's next choice, a switch to Pachirisu.
  const team = [ourRow('Gogoat', 88, ['Earthquake', 'Milk Drink', 'Horn Leech', 'Bulk Up'], 'Sap Sipper', 'Leftovers', 'Water'),
    ourRow('Snorlax', 84, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')];
  const b = battleFor(team, 'Darkrai', 77);
  const hp = Math.round(team[0]!.maxHP * 0.54);
  b.feed('|move|p2a: Foe|Dark Pulse|p1a: Gogoat'); b.feed(`|-damage|p1a: Gogoat|${hp}/${team[0]!.maxHP}`);
  b.feed('|-damage|p2a: Foe|19/100'); b.feed('|turn|2');
  const records: DecisionRecord[] = [];
  const provider: DecisionProvider = { async chooseAction(input): Promise<DecisionResult> {
    const id = (label: string) => input.legalActions.find(a => a.label === label)!.id;
    return { chosenAction: id('Milk Drink'), provider: 'jev', confidence: 0.5, probabilities: Object.fromEntries(input.legalActions.map(a =>
      [a.id, a.label === 'Milk Drink' ? 0.6 : a.label.startsWith('Switch to Snorlax') ? 0.25 : 0.03])) };
  } };
  const loop = new DecisionLoop({ room, username: 'Test Bot', dryRun: true, provider, send: () => true, state: () => b.state,
    onStatus: () => {}, onDecision: r => records.push(r) });
  loop.request(JSON.stringify(b.payload(3, hp, 0)));
  await new Promise(resolve => setTimeout(resolve, 30));
  loop.stop();
  assert.equal(records[0]!.selectedAction.label, 'Earthquake');
  assert.match(records[0]!.skippedDominatedMove!.reason, /Earthquake knocks Darkrai out at every sampled roll/);
});

import { parseMatrix, solveMatrixGame, searchTimeoutMs } from '../src/search/search.js';

test('the endgame solver reads the engine matrix and solves the root as a simultaneous game', () => {
  const m = parseMatrix('side one options: closecombat,uturn\nside two options: iciclecrash,highhorsepower\nmatrix: 10.00,-5.00,2.00,3.00\nchoice: uturn\nevaluation: 2\n');
  assert.deepEqual(m, { ours: ['closecombat', 'uturn'], theirs: ['iciclecrash', 'highhorsepower'], cells: [10, -5, 2, 3] });
  assert.equal(parseMatrix('matrix: 1,NaN\nside one options: a\nside two options: b,c'), null, 'a pruned cell leaves no full matrix');
  // Rock, paper, scissors: the only equilibrium is uniform, and every action is worth the same against it.
  const rps = solveMatrixGame([0, -1, 1, 1, 0, -1, -1, 1, 0], 3, 3);
  for (const p of rps.row) assert.ok(Math.abs(p - 1 / 3) < 0.03);
  assert.ok(Math.abs(rps.value) < 0.05);
  // A dominant row takes all the weight, whatever the opponent does.
  const dominant = solveMatrixGame([5, 4, 1, 0], 2, 2);
  assert.ok(dominant.row[0]! > 0.97);
  // Matching pennies with a bias: worst-case play would pick the safe row, the equilibrium mixes.
  const mixed = solveMatrixGame([3, -1, -1, 1], 2, 2);
  assert.ok(mixed.row[0]! > 0.2 && mixed.row[0]! < 0.5, `mixed strategy, got ${mixed.row[0]}`);
});

test('the search timeout covers the extra pass or the endgame, whichever is longer', () => {
  const base = { bin: '', worlds: 16, msPerWorld: 200, extraWorlds: 0, closeRatio: 0.6, endgamePokemon: 0, endgameWorlds: 8, endgameMsPerWorld: 400 };
  assert.equal(searchTimeoutMs(base, 8), 2 * 200 * 2 + 1000);
  assert.equal(searchTimeoutMs({ ...base, extraWorlds: 16 }, 8), 2 * (2 * 200 * 2) + 1000);
  assert.equal(searchTimeoutMs({ ...base, endgamePokemon: 4, endgameMsPerWorld: 2000 }, 8), 1 * 2000 * 2 + 1000);
});

test('two-turn moves, type changes, Truant and grounding reach the engine', () => {
  const b = battleFor([ourRow('Slaking', 83, ['Double-Edge', 'Earthquake', 'Knock Off', 'Slack Off'], 'Truant', 'Choice Band', 'Normal')], 'Greninja', 81);
  b.feed('|move|p1a: Slaking|Knock Off|p2a: Foe'); b.feed('|move|p2a: Foe|Ice Beam|p1a: Slaking');
  b.feed('|-start|p2a: Foe|typechange|Ice|[from] ability: Protean'); b.feed('|-start|p2a: Foe|Smack Down'); b.feed('|turn|2');
  let [ours, theirs] = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/');
  let one = ours!.split('='), two = theirs!.split('=');
  const foe = two[Number(two[6])]!.split(',');
  assert.deepEqual(foe.slice(2, 6), ['Ice', 'Typeless', 'Water', 'Dark'], 'Protean made it Ice; its own typing returns on switching out');
  assert.match(two[8]!, /TYPECHANGE:/);
  assert.match(two[8]!, /SMACKDOWN:/, 'grounded by Smack Down');
  assert.match(one[8]!, /TRUANT:/, 'Slaking moved last turn, so it loafs this one');
  b.feed('|move|p2a: Foe|Phantom Force||[still]'); b.feed('|-prepare|p2a: Foe|Phantom Force'); b.feed('|turn|3');
  [ours, theirs] = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/');
  one = ours!.split('='); two = theirs!.split('=');
  assert.match(two[8]!, /PHANTOMFORCE:/, 'out of reach, striking next turn');
  assert.doesNotMatch(one[8]!, /TRUANT:/, 'Slaking loafed on turn 2, so it moves on turn 3');
});

test('a pending Future Sight and an eaten Harvest berry reach the engine', () => {
  const b = battleFor([ourRow('Exeggutor', 88, ['Psychic', 'Leech Seed', 'Substitute', 'Sleep Powder'], 'Harvest', 'Sitrus Berry', 'Steel')], 'Slowking', 85);
  b.feed('|turn|2'); b.feed('|move|p2a: Foe|Future Sight|p1a: Exeggutor'); b.feed('|-start|p2a: Foe|move: Future Sight');
  b.feed('|-enditem|p1a: Exeggutor|Sitrus Berry|[eat]'); b.feed('|turn|3');
  const [ours, theirs] = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/');
  const two = theirs!.split('='), one = ours!.split('=');
  assert.deepEqual([two[20], two[21]], ['2', '0'], 'cast on turn 2 by the Slowking in slot 0: it strikes at the end of turn 4');
  assert.equal(one[Number(one[6])]!.split(',')[8], 'HARVEST', 'the Sitrus was eaten, so Harvest can bring it back');
  b.feed('|-end|p1a: Exeggutor|move: Future Sight'); b.feed('|turn|4');
  assert.equal(b.state.sides.p2.slotConditions.futureSight, undefined, 'the strike clears it from the side that cast it');
  const knocked = battleFor([ourRow('Exeggutor', 88, ['Psychic', 'Leech Seed', 'Substitute', 'Sleep Powder'], 'Harvest', 'Sitrus Berry', 'Steel')], 'Weavile', 85);
  knocked.feed('|-enditem|p1a: Exeggutor|Sitrus Berry|[from] move: Knock Off|[of] p2a: Foe'); knocked.feed('|turn|2');
  const k = engineStateOf(knocked.state, 'p1', worldOf(knocked.state, 'p1', () => 0.5)).state.split('/')[0]!.split('=');
  assert.equal(k[Number(k[6])]!.split(',')[8], 'NONE', 'knocked off, it has nothing to harvest');
});

test('a Zoroark under a disguise is found by a move or an immunity, and is searched as itself while it stays in', () => {
  const team = [ourRow('Conkeldurr', 84, ['Mach Punch', 'Drain Punch', 'Knock Off', 'Ice Punch'], 'Guts', 'Flame Orb', 'Fighting'),
    ourRow('Gengar', 82, ['Shadow Ball', 'Sludge Wave'], 'Cursed Body', 'Life Orb', 'Ghost')];
  // A move no Snorlax set carries.
  const byMove = battleFor(team, 'Snorlax', 84);
  byMove.feed('|move|p2a: Foe|Bitter Malice|p1a: Conkeldurr'); byMove.feed('|turn|2');
  assert.equal(byMove.foe().species, 'Zoroark-Hisui');
  assert.equal(byMove.state.sides.p2.identityUncertain, true);
  const two = engineStateOf(byMove.state, 'p1', worldOf(byMove.state, 'p1', () => 0.5)).state.split('/')[1]!.split('=');
  assert.match(two[Number(two[6])]!, /^ZOROARKHISUI,80,Normal,Ghost,/, 'the search plays the Zoroark, at its own level');
  byMove.feed('|switch|p2a: Snorlax|Snorlax, L84|100/100'); byMove.feed('|turn|3');
  const left = byMove.state.sides.p2.team.find(p => p.illusion === undefined && p.revealedMoves.length === 0 && p.details.startsWith('Snorlax'));
  assert.ok(left, 'switched out, the entry is a Snorlax again with none of the Zoroark\'s moves');
  // Our attack meets an immunity the disguise's typing cannot explain.
  const byImmunity = battleFor(team, 'Snorlax', 84);
  byImmunity.feed('|move|p1a: Conkeldurr|Drain Punch|p2a: Foe'); byImmunity.feed('|-immune|p2a: Foe'); byImmunity.feed('|turn|2');
  assert.equal(byImmunity.foe().species, 'Zoroark-Hisui');
  // A real immunity, and one an ability explains, give nothing away.
  const flying = battleFor(team, 'Corviknight', 84);
  flying.feed('|move|p1a: Conkeldurr|Drain Punch|p2a: Foe'); flying.feed('|-immune|p2a: Foe|[from] ability: Wonder Guard'); flying.feed('|turn|2');
  assert.equal(flying.foe().species, 'Corviknight');
  const ghost = battleFor(team, 'Gholdengo', 84);
  ghost.feed('|move|p1a: Conkeldurr|Drain Punch|p2a: Foe'); ghost.feed('|-immune|p2a: Foe'); ghost.feed('|turn|2');
  assert.equal(ghost.foe().species, 'Gholdengo', 'a Ghost type is immune to Fighting on its own');
});

test('an opposing Choice lock reaches the engine as ours does', () => {
  const b = battleFor([ourRow('Gengar', 82, ['Shadow Ball', 'Sludge Wave', 'Focus Blast', 'Nasty Plot'], 'Cursed Body', 'Life Orb', 'Ghost')], 'Heracross', 83);
  b.feed('|move|p2a: Foe|Close Combat|p1a: Gengar'); b.feed('|-immune|p1a: Gengar'); b.feed('|turn|2');
  const written = (item: string | null) => {
    b.foe().item = item;
    const two = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/')[1]!.split('=');
    return two[Number(two[6])]!.split(',').slice(22, 26);
  };
  const scarfed = written('Choice Scarf');
  assert.ok(scarfed.some(m => /^CLOSECOMBAT;false;/.test(m)), 'the locked move stays open');
  assert.ok(scarfed.filter(m => !/^CLOSECOMBAT;|^NONE;/.test(m)).every(m => /;true;/.test(m)), `the rest are closed: ${scarfed.join(' ')}`);
  assert.ok(written('Leftovers').every(m => /;false;|^NONE;/.test(m)), 'without a Choice item nothing is locked');
});

test('timed effects reach the engine with the turns they have left', () => {
  const b = battleFor([ourRow('Snorlax', 84, ['Body Slam', 'Curse', 'Rest', 'Sleep Talk'], 'Thick Fat', 'Leftovers', 'Normal')], 'Dragonite', 80);
  b.feed('|turn|2');
  b.feed('|-fieldstart|move: Trick Room|[of] p2a: Foe'); b.feed('|-sidestart|p1: Test Bot|Reflect'); b.feed('|-sidestart|p1: Test Bot|move: Tailwind');
  b.feed('|-start|p1a: Snorlax|move: Taunt'); b.feed('|turn|3');
  b.feed('|move|p2a: Foe|Outrage|p1a: Snorlax'); b.feed('|-start|p1a: Snorlax|move: Yawn'); b.feed('|turn|4');
  const [ours, theirs, ...field] = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/');
  const one = ours!.split('='), two = theirs!.split('=');
  const conditions = one[7]!.split(';');
  assert.equal(conditions[10], '3', 'Reflect from turn 2 has three turns left on turn 4');
  assert.equal(conditions[15], '2', 'Tailwind lasts four');
  assert.equal(field[2], 'true;3', 'and Trick Room three');
  const [, , , , taunt, yawn] = one[9]!.split(';');
  assert.deepEqual([taunt, yawn], ['2', '1'], 'Taunt two ends of turn in; the Yawn from turn 3 puts Snorlax to sleep at the end of this one');
  assert.match(two[8]!, /LOCKEDMOVE:/, 'an Outrage on its first turn goes on at least one more');
  assert.equal(two[9]!.split(';')[2], '1');
});

test('a screen from a Light Clay holder lasts eight turns, and every Random Battle screen setter holds one', () => {
  const b = battleFor([ourRow('Grimmsnarl', 83, ['Reflect', 'Light Screen', 'Spirit Break', 'Thunder Wave'], 'Prankster', 'Light Clay', 'Steel')], 'Dragonite', 80);
  b.feed('|turn|2');
  b.feed('|-sidestart|p1: Test Bot|Reflect'); b.feed('|-sidestart|p2: Foe|move: Light Screen'); b.feed('|turn|4');
  const [ours, theirs] = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/');
  assert.equal(ours!.split('=')[7]!.split(';')[10], '6', 'our Light Clay Reflect from turn 2 has six turns left on turn 4, not three');
  assert.equal(theirs!.split('=')[7]!.split(';')[3], '6', 'an opposing setter\'s unknown item is the Light Clay every screen setter carries');
});

test('the hits a Pokémon has taken reach the engine, for Rage Fist', () => {
  // The engine's Rage Fist was a flat 50 base power; it gains 50 for every hit its user has taken, up to 350.
  const b = battleFor([ourRow('Annihilape', 76, ['Rage Fist', 'Drain Punch', 'Bulk Up', 'Gunk Shot'], 'Defiant', 'Leftovers', 'Water')], 'Cobalion', 80);
  b.feed('|move|p2a: Foe|Flash Cannon|p1a: Annihilape'); b.feed('|-damage|p1a: Annihilape|200/292'); b.feed('|turn|2');
  b.feed('|move|p2a: Foe|Flash Cannon|p1a: Annihilape'); b.feed('|-damage|p1a: Annihilape|120/292'); b.feed('|turn|3');
  b.feed('|-damage|p1a: Annihilape|100/292|[from] Stealth Rock');
  const text = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/')[0]!;
  const fields = text.split('=');
  const mon = fields[Number(fields[6])]!;
  assert.equal(mon.split(',')[29], '2', 'two hits; the hazard damage does not count');
});

test('a transformed Pokémon reaches the search as its copy: species, types and moves, with its own HP', () => {
  // 2687224152: a Ditto copying our +2 Groudon went to the engine as a Normal-type with only Transform, so the search
  // kept it alive with Ruination instead of knocking it out, and its Precipice Blades took Ting-Lu.
  const b = battleFor([ourRow('Groudon', 72, ['Precipice Blades', 'Heat Crash', 'Swords Dance', 'Thunder Wave'], 'Drought', 'Leftovers', 'Fire')], 'Ditto', 87);
  b.feed('|-transform|p2a: Foe|p1a: Groudon|[from] ability: Imposter'); b.feed('|move|p2a: Foe|Precipice Blades|p1a: Groudon'); b.feed('|turn|2');
  const text = engineStateOf(b.state, 'p1', worldOf(b.state, 'p1', () => 0.5)).state.split('/')[1]!;
  const fields = text.split('=');
  const mon = fields[Number(fields[6])]!;
  assert.match(mon, /^GROUDON,87,Ground,Typeless,Ground,Typeless,/, 'the copy\'s species and types, at the Ditto\'s own level');
  assert.match(mon, /PRECIPICEBLADES;false;5/, 'the copied moves, each with 5 PP');
  assert.doesNotMatch(mon, /TRANSFORM/, 'not the Ditto\'s own moveset');
  assert.equal((mon.match(/PRECIPICEBLADES/g) ?? []).length, 1, 'a move copied and then used is written once');
  assert.equal(mon.split(',')[9], 'IMPOSTER', 'Imposter underneath, so the engine turns it back into a Ditto when it leaves');
});
