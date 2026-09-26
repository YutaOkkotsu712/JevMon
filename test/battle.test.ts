import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BattleTracker } from '../src/battle/BattleTracker.js';
import { BattleManager } from '../src/battle/BattleManager.js';
import type { DecisionRecord } from '../src/battle/DecisionLoop.js';
import { BattleLogger } from '../src/logging/BattleLogger.js';
import { remainingPokemon } from '../src/battle/BattleState.js';
import { parseCondition } from '../src/showdown/parser.js';
import { parseFrame } from '../src/showdown/protocol.js';
import { readConfig } from '../src/config/env.js';
const room = 'battle-gen9randombattle-test';
function feed(tracker: BattleTracker, lines: string) {
  for (const message of parseFrame(`>${room}\n${lines}`)) tracker.handle(message);
}
function tracker() {
  const t = new BattleTracker(room, 'Test Bot');
  for (const msg of parseFrame(readFileSync('test/fixtures/battle.txt', 'utf8'))) t.handle(msg);
  return t;
}

test('HP fractions, status, fainting and invalid HP', () => {
  assert.deepEqual(parseCondition('25/100 par'), { hpPercent: 25, status: 'par', fainted: false });
  assert.deepEqual(parseCondition('0 fnt'), { hpPercent: 0, status: null, fainted: true });
  assert.equal(parseCondition('24/48y')?.hpPercent, 50);
  assert.equal(parseCondition('150/300 tox')?.status, 'tox');
  for (const value of ['', 'abc', '100/0', '101/100', '-1/100', '20/100 xyz', 'NaN/100']) assert.equal(parseCondition(value), null);
});

test('protocol fixture updates visible battle state', () => {
  const s = tracker().state, p = s.sides.p1.team[0]!;
  assert.equal(s.mySide, 'p1'); assert.equal(s.turn, 2); assert.equal(s.sides.p2.rating, 1300);
  assert.equal(p.species, 'Pikachu'); assert.equal(p.hpPercent, 75); assert.equal(p.status, 'brn');
  assert.equal(p.boosts.spa, 2); assert.deepEqual(p.revealedMoves, ['Thunderbolt']);
  assert.equal(p.teraType, 'Flying'); assert.equal(p.terastallized, true);
  assert.equal(s.sides.p2.team[0]!.ability, 'Protosynthesis');
  assert.equal(s.sides.p2.team[0]!.item, 'Leftovers');
  assert.equal(s.sides.p2.hazards.Spikes, 2);
  assert.deepEqual(s.field, { weather: 'RainDance', terrain: 'Electric Terrain', trickRoom: true });
  assert.equal(remainingPokemon(s.sides.p2), 6);
});

test('switches reset boosts, preserve history and distinguish duplicate species with different nicknames', () => {
  const t = tracker();
  feed(t, '|switch|p1a: Other|Pikachu, L80, M|100/200\n|-boost|p1a: Other|atk|10');
  assert.equal(t.state.sides.p1.team.length, 2);
  assert.deepEqual(t.state.sides.p1.team[0]!.boosts, {});
  assert.equal(t.state.sides.p1.team[1]!.boosts.atk, 6);
  feed(t, '|switch|p1a: Sparky|Pikachu, L80, M|150/200 brn');
  assert.equal(t.state.sides.p1.team.length, 2);
  assert.equal(t.state.sides.p1.activeId, t.state.sides.p1.team[0]!.id);
  assert.deepEqual(t.state.sides.p1.team[0]!.revealedMoves, ['Thunderbolt']);
});

test('faint, cure, hazard removal and field endings', () => {
  const t = tracker();
  feed(t, '|-curestatus|p1a: Sparky|brn\n|faint|p2a: Tusk\n|-sideend|p2: Opponent|Spikes\n|-weather|none\n|-fieldend|move: Electric Terrain\n|-fieldend|move: Trick Room');
  assert.equal(t.state.sides.p1.team[0]!.status, null);
  assert.equal(t.state.sides.p2.team[0]!.fainted, true);
  assert.equal(remainingPokemon(t.state.sides.p2), 5);
  assert.equal(t.state.sides.p2.hazards.Spikes, 0);
  assert.deepEqual(t.state.field, { weather: null, terrain: null, trickRoom: false });
});

test('malformed requests do not erase roster and unrelated rooms do not change state', () => {
  const t = tracker(); const before = structuredClone(t.state.sides);
  feed(t, '|request|{bad json\n|request|{"side":{"id":"p1","pokemon":[{}]}}\n|-damage|p1a: Sparky|invalid');
  assert.deepEqual(t.state.sides, before);
  t.handle({ room: 'battle-other', type: 'turn', data: '999' });
  assert.equal(t.state.turn, 2);
  assert.ok(t.state.uncertainties.length > 0);
});

test('private requests preserve duplicate roster slots and distinguish exact HP', () => {
  const t = new BattleTracker(room);
  const pokemon = [true, false].map(active => ({ ident: 'p1: Ditto', details: 'Ditto, L80', active,
    condition: '100/200', baseAbility: 'Imposter', item: 'choicescarf', teraType: 'Ghost' }));
  const request = JSON.stringify({ forceSwitch: [true], side: { id: 'p1', pokemon } });
  feed(t, `|request|${request}`);
  assert.equal(t.state.mySide, 'p1'); assert.equal(t.state.requestKind, 'switch');
  const team = t.state.sides.p1.team;
  assert.equal(team.length, 2); assert.notEqual(team[0]!.id, team[1]!.id);
  assert.equal(team[0]!.hpPrecision, 'exact');
  feed(t, `|request|${request}`);
  assert.equal(t.state.sides.p1.team.length, 2);
  feed(t, '|request|{"wait":true}'); assert.equal(t.state.requestKind, 'wait');
  feed(t, '|request|null'); assert.equal(t.state.requestKind, 'none');
});

test('illusion is explicitly uncertain and battle completion is recorded', () => {
  const t = tracker();
  feed(t, '|replace|p2a: Zoroark|Zoroark, L80|50/100\n|win|Test Bot');
  assert.equal(t.state.sides.p2.team[0]!.species, 'Zoroark');
  assert.ok(t.state.uncertainties.some(x => x.includes('Illusion')));
  assert.equal(t.state.ended, true); assert.equal(t.state.winner, 'Test Bot');
});

test('manager joins once, only tracks configured room, rebuilds after reconnect', (t) => {
  const commands: string[] = [], turns: number[] = [];
  const manager = new BattleManager({ room, send: c => { commands.push(c); return true; }, onStatus: () => {},
    onSnapshot: (_event, state) => turns.push(state.turn) });
  t.after(() => manager.disconnect());
  manager.ready(); manager.ready();
  assert.deepEqual(commands, [`|/join ${room}`]);
  manager.handle({ room, type: 'turn', data: '50' }); assert.equal(turns.length, 0);
  for (const m of parseFrame(`>${room}\n|init|battle\n|turn|1`)) manager.handle(m);
  manager.disconnect(); manager.ready();
  for (const m of parseFrame(`>${room}\n|init|battle\n|turn|1`)) manager.handle(m);
  assert.deepEqual(turns, [1, 1]); assert.equal(commands.length, 2);
});

test('battle room configuration disallows other formats, URLs and command injection', () => {
  for (const SHOWDOWN_BATTLE_ROOM of ['battle-gen9ou-1', 'https://example.com', `${room}\n/search gen9randombattle`]) {
    assert.throws(() => readConfig({ SHOWDOWN_BATTLE_ROOM }));
  }
  assert.equal(readConfig({ SHOWDOWN_BATTLE_ROOM: room }).battleRoom, room);
});

test('logger writes parseable isolated state snapshots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jevmon-'));
  try {
    const state = tracker().state;
    const logger = new BattleLogger(directory, room, () => assert.fail('unexpected log failure'));
    logger.snapshot('turn', state);
    const record = JSON.parse(readFileSync(logger.path, 'utf8'));
    assert.deepEqual(record.state, state);
    assert.equal(record.event, 'turn'); assert.equal(readdirSync(directory).length, 1);
    // Public battle lines are kept verbatim, pipes and all, so a review can see misses and critical hits.
    logger.line({ room, type: '-miss', data: 'p1a: Dodrio|p2a: Diancie' });
    const line = JSON.parse(readFileSync(logger.path, 'utf8').trim().split('\n').at(-1)!);
    assert.equal(line.event, 'line'); assert.equal(line.line, '|-miss|p1a: Dodrio|p2a: Diancie');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Tera detail suffix on re-entry does not create a duplicate Pokémon', () => {
  const t = tracker();
  feed(t, '|switch|p1a: Other|Charizard, L80|100/100\n|switch|p1a: Sparky|Pikachu, L80, M, tera:Flying|50/100 brn');
  assert.equal(t.state.sides.p1.team.length, 2);
  assert.equal(t.state.sides.p1.activeId, t.state.sides.p1.team[0]!.id);
  assert.equal(t.state.sides.p1.team[0]!.terastallized, true);
});

test('manager gates decisions on format, identity and battle completion', async (t) => {
  const { setTimeout: delay } = await import('node:timers/promises');
  const commands: string[] = [];
  const manager = new BattleManager({ room, username: 'Bot', send: c => { commands.push(c); return true; },
    onStatus: () => {}, onSnapshot: () => {}, play: { dryRun: false, onDecision: () => {} } });
  t.after(() => manager.disconnect());
  const request = { rqid: 1, side: { id: 'p1', name: 'Bot', pokemon: [
    { ident: 'p1: Pikachu', details: 'Pikachu', active: true, condition: '100/100' },
  ] }, active: [{ moves: [{ id: 'surf', move: 'Surf', pp: 10 }] }] };
  const feed = (type: string, data: string) => manager.handle({ room, type, data });
  feed('init', 'battle'); feed('request', JSON.stringify(request)); await delay(0);
  assert.equal(commands.length, 0);
  feed('gametype', 'singles'); feed('tier', '[Gen 9] Random Battle');
  feed('request', JSON.stringify(request)); await delay(0);
  assert.deepEqual(commands, [`${room}|/timer on`, `${room}|/choose move 1|1`], 'the timer is asked for with the first real request');
  request.rqid = 2; feed('request', JSON.stringify(request)); feed('win', 'Bot'); await delay(0);
  assert.equal(commands.length, 2);
});

test('the manager hands the bench\'s guard and planning settings to the decision loop', async () => {
  const { setTimeout: delay } = await import('node:timers/promises');
  const request = JSON.stringify({ rqid: 1, side: { id: 'p1', name: 'Bot', pokemon: [
    { ident: 'p1: Pikachu', details: 'Pikachu, L90', active: true, condition: '100/100' },
  ] }, active: [{ moves: [{ id: 'surf', move: 'Surf', pp: 10 }, { id: 'thunderbolt', move: 'Thunderbolt', pp: 10 }] }] });
  const run = async (settings: { guards?: boolean | { skip?: string[]; extra?: string[] }; planning?: boolean }) => {
    const records: DecisionRecord[] = [];
    const manager = new BattleManager({ room, username: 'Bot', send: () => true, onStatus: () => {}, onSnapshot: () => {},
      play: { dryRun: true, ...settings, onDecision: r => records.push(r),
        provider: { async chooseAction(input) { return { chosenAction: input.legalActions[0]!.id,
          probabilities: Object.fromEntries(input.legalActions.map((a, i) => [a.id, i ? 0.4 : 0.6])) }; } } } });
    const feed = (type: string, data: string) => manager.handle({ room, type, data });
    feed('init', 'battle'); feed('gametype', 'singles'); feed('tier', '[Gen 9] Random Battle'); feed('request', request);
    await delay(20);
    manager.disconnect();
    return { record: records[0]!, loop: (manager as any).loop.options };
  };
  // Only `guards: false` used to arrive, so a bench side with skipped guards, or with planning off, played the default bot.
  assert.ok((await run({})).record.tacticalRanking, 'planning is on by default');
  assert.equal((await run({ planning: false })).record.tacticalRanking, undefined);
  assert.deepEqual((await run({ guards: { skip: ['outhealed'], extra: [] } })).loop.guards, { skip: ['outhealed'], extra: [] });
  assert.equal((await run({ guards: false })).record.tacticalRanking, undefined);
});

test('the battle timer is kept on for every battle we play, and never turned on when we are not choosing', async () => {
  const { setTimeout: delay } = await import('node:timers/promises');
  const request = JSON.stringify({ rqid: 1, side: { id: 'p1', name: 'Bot', pokemon: [
    { ident: 'p1: Pikachu', details: 'Pikachu', active: true, condition: '100/100' },
  ] }, active: [{ moves: [{ id: 'surf', move: 'Surf', pp: 10 }] }] });
  const run = (play: { dryRun: boolean; onDecision: () => void } | undefined) => {
    const commands: string[] = [], status: string[] = [];
    const manager = new BattleManager({ room, username: 'Bot', send: c => { commands.push(c); return true; },
      onStatus: s => status.push(s), onSnapshot: () => {}, ...(play ? { play } : {}) });
    const feed = (type: string, data: string) => manager.handle({ room, type, data });
    feed('init', 'battle'); feed('gametype', 'singles'); feed('tier', '[Gen 9] Random Battle');
    return { manager, feed, commands, status, timers: () => commands.filter(c => c.endsWith('/timer on')).length };
  };
  const live = run({ dryRun: false, onDecision: () => {} });
  live.feed('request', request); live.feed('request', request); await delay(0);
  assert.equal(live.timers(), 1, 'once per battle, not once per turn');
  live.feed('inactive', 'Battle timer is ON: inactive players will automatically lose when time\'s up. (requested by Bot)');
  assert.ok(live.status.includes('battle timer is on'));
  live.feed('inactiveoff', 'Battle timer is now OFF.');
  assert.equal(live.timers(), 2, 'turned off, it is asked for again at once');
  for (let i = 0; i < 10; i++) live.feed('inactiveoff', 'Battle timer is now OFF.');
  assert.equal(live.timers(), 5, 'a server that keeps refusing cannot make it loop');
  live.manager.disconnect();

  const rejoined = run({ dryRun: false, onDecision: () => {} });
  rejoined.feed('request', request); rejoined.manager.disconnect(); rejoined.manager.ready();
  rejoined.feed('init', 'battle'); rejoined.feed('gametype', 'singles'); rejoined.feed('tier', '[Gen 9] Random Battle'); rejoined.feed('request', request);
  assert.equal(rejoined.timers(), 2, 'asked again after a reconnect, which is harmless if it is still on');
  rejoined.manager.disconnect();

  for (const quiet of [run({ dryRun: true, onDecision: () => {} }), run(undefined)]) {
    quiet.feed('request', request); quiet.feed('inactiveoff', 'Battle timer is now OFF.'); await delay(0);
    assert.equal(quiet.timers(), 0, 'dry-run sends no choices and an observer has none, so the timer would only lose the game');
    quiet.manager.disconnect();
  }
});

test('copy and selected swap boosts follow actual simulator event direction', () => {
  const t = tracker();
  feed(t, '|-boost|p2a: Tusk|atk|3\n|-copyboost|p1a: Sparky|p2a: Tusk|[from] move: Psych Up');
  assert.equal(t.state.sides.p1.team[0]!.boosts.atk, 3);
  assert.equal(t.state.sides.p1.team[0]!.boosts.spa, 0);
  feed(t, '|-setboost|p1a: Sparky|atk|-2\n|-swapboost|p1a: Sparky|p2a: Tusk|atk, spa');
  assert.equal(t.state.sides.p1.team[0]!.boosts.atk, 3);
  assert.equal(t.state.sides.p2.team[0]!.boosts.atk, -2);
});

test('Transform preserves identity, copies boosts and clears copied moves when switching', () => {
  const t = tracker();
  feed(t, '|-boost|p2a: Tusk|def|2\n|-transform|p1a: Sparky|p2a: Tusk\n|move|p1a: Sparky|Earthquake|p2a: Tusk');
  const p = t.state.sides.p1.team[0]!;
  assert.equal(p.species, 'Pikachu'); assert.equal(p.transformedInto, 'Great Tusk');
  assert.equal(p.boosts.def, 2); assert.ok(!p.revealedMoves.includes('Earthquake')); assert.ok(p.copiedMoves.includes('Earthquake'));
  feed(t, '|switch|p1a: Other|Charizard|100/100');
  assert.equal(p.transformedInto, null); assert.deepEqual(p.copiedMoves, []);
});

test('volatiles, suppression, field age and Court Change are tracked', () => {
  const t = tracker();
  feed(t, '|-start|p1a: Sparky|Substitute\n|-endability|p1a: Sparky\n|-sidestart|p1: Test Bot|Reflect\n|-swapsideconditions');
  const p = t.state.sides.p1.team[0]!;
  assert.equal(p.volatiles.Substitute?.sinceTurn, 2); assert.equal(p.abilitySuppressed, true);
  assert.equal(t.state.sides.p1.hazards.Spikes, 2); assert.ok(t.state.sides.p2.conditions.Reflect);
  assert.equal(t.state.effectStartTurns.weather, 1);
  feed(t, '|-weather|RainDance|[upkeep]\n|-end|p1a: Sparky|Substitute');
  assert.equal(t.state.effectStartTurns.weather, 1); assert.equal(p.volatiles.Substitute, undefined);
});

test('private request IDs remain stable when roster order changes', () => {
  const t = tracker();
  const first = t.state.sides.p1.team[0]!;
  const rows = [
    { ident: 'p1: New', details: 'Charizard', condition: '100/100', active: true, stats: { spe: 200 }, moves: ['flamethrower'] },
    { ident: 'p1: Sparky', details: 'Pikachu, L80, M', condition: '100/200', active: false },
  ];
  feed(t, '|switch|p1a: New|Charizard|100/100');
  feed(t, `|request|${JSON.stringify({ side: { id: 'p1', pokemon: rows } })}`);
  assert.equal(t.state.sides.p1.team[1]!.id, first.id);
  assert.equal(t.state.sides.p1.team[1]!.slot, 2);
  assert.equal(t.state.sides.p1.team[0]!.stats.spe, 200);
  assert.deepEqual(t.state.sides.p1.team[0]!.knownMoves, ['flamethrower']);
});

test('Illusion uncertainty prevents presenting a definite remaining count', () => {
  const t = tracker(); feed(t, '|replace|p2a: Zoroark|Zoroark|50/100');
  assert.equal(remainingPokemon(t.state.sides.p2), null);
});

test('room configuration accepts a copied official battle URL', () => {
  assert.equal(readConfig({ SHOWDOWN_BATTLE_ROOM: 'https://play.pokemonshowdown.com/battle-gen9randombattle-123/' }).battleRoom,
    'battle-gen9randombattle-123');
  assert.throws(() => readConfig({ SHOWDOWN_BATTLE_ROOM: 'https://untrusted.example/battle-gen9randombattle-123' }));
  assert.throws(() => readConfig({ SHOWDOWN_BATTLE_ROOM: 'https://user:password@play.pokemonshowdown.com/battle-gen9randombattle-123' }));
});

test('Trace reveals the copied ability on the Pokémon it came from, not Trace', () => {
  const t = tracker();
  feed(t, '|-ability|p1a: Sparky|Volt Absorb|[from] ability: Trace|[of] p2a: Tusk');
  assert.equal(t.state.sides.p2.team[0]!.ability, 'Volt Absorb', 'the source of the copy has the ability that was copied');
  assert.equal(t.state.sides.p1.team[0]!.ability, 'Volt Absorb', 'and the tracer now has it too');
  assert.equal(t.state.sides.p1.team[0]!.baseAbility, 'Trace');
  feed(t, '|-damage|p1a: Sparky|80/100|[from] ability: Rough Skin|[of] p2a: Tusk');
  assert.equal(t.state.sides.p2.team[0]!.ability, 'Rough Skin', 'other abilities named with [of] still belong to the [of] Pokémon');
});

test('a native ability revealed as an effect source remains known after switching out', () => {
  const t = new BattleTracker(room);
  feed(t, '|switch|p2a: Tropius|Tropius, L91, M|100/100\n' +
    '|-item|p2a: Tropius|Sitrus Berry|[from] ability: Harvest\n' +
    '|switch|p2a: Dragapult|Dragapult, L77|100/100\n' +
    '|switch|p2a: Tropius|Tropius, L91, M|75/100');
  const tropius = t.state.sides.p2.team.find(p => p.species === 'Tropius')!;
  assert.equal(tropius.baseAbility, 'Harvest');
  assert.equal(tropius.ability, 'Harvest');
});

test('Trace also preserves the copied target\'s native ability across a switch', () => {
  const t = new BattleTracker(room);
  feed(t, '|switch|p1a: Porygon2|Porygon2, L84|100/100\n' +
    '|switch|p2a: Rotom|Rotom, L83|100/100\n' +
    '|-ability|p1a: Porygon2|Levitate|[from] ability: Trace|[of] p2a: Rotom\n' +
    '|switch|p2a: Tropius|Tropius, L91|100/100\n' +
    '|switch|p2a: Rotom|Rotom, L83|100/100');
  const rotom = t.state.sides.p2.team.find(p => p.species === 'Rotom')!;
  assert.equal(rotom.baseAbility, 'Levitate');
  assert.equal(rotom.ability, 'Levitate');
});

test('our transformed Pokémon copies every move from its request, and the target\'s set is known from it', () => {
  // 2687703481: our Ditto as Latias had Psyshock, which Latias had not used yet; the copy from '-transform' left it
  // out, so the search had no value for it and Ditto switched out rather than attack.
  const t = new BattleTracker(room);
  const row = (moves: string[]) => ({ ident: 'p1: Ditto', details: 'Ditto, L87', active: true, condition: '225/225',
    baseAbility: 'Imposter', item: 'choicescarf', moves });
  feed(t, `|request|${JSON.stringify({ active: [{ moves: [] }], side: { id: 'p1', pokemon: [row(['transform'])] } })}`);
  feed(t, '|switch|p2a: Latias|Latias, L79, F|100/100\n|move|p2a: Latias|Calm Mind|p2a: Latias');
  feed(t, '|switch|p1a: Ditto|Ditto, L87|225/225\n|-transform|p1a: Ditto|p2a: Latias|[from] ability: Imposter\n|turn|2');
  assert.deepEqual(t.state.sides.p1.team[0]!.copiedMoves, ['Calm Mind'], 'only what Latias had shown');
  feed(t, `|request|${JSON.stringify({ active: [{ moves: [] }], side: { id: 'p1', pokemon: [row(['psyshock', 'recover', 'calmmind', 'dracometeor'])] } })}`);
  assert.deepEqual(t.state.sides.p1.team[0]!.copiedMoves, ['Psyshock', 'Recover', 'Calm Mind', 'Draco Meteor']);
  const latias = t.state.sides.p2.team.find(p => p.species === 'Latias')!;
  assert.deepEqual([...latias.revealedMoves].sort(), ['Calm Mind', 'Draco Meteor', 'Psyshock', 'Recover']);
});

test('our Pokémon transformed into an opponent keeps the copied stats, which its request does not carry', () => {
  // 2687703481: the request's stats are Ditto's own, and overwrote the copy, so our Choice Scarf Ditto as Latias was
  // judged slower than Latias and hit like a Ditto.
  const t = new BattleTracker(room);
  const row = { ident: 'p1: Ditto', details: 'Ditto, L87', active: true, condition: '225/225', baseAbility: 'Imposter',
    item: 'choicescarf', moves: ['psyshock', 'recover', 'calmmind', 'dracometeor'],
    stats: { atk: 150, def: 150, spa: 150, spd: 150, spe: 150 } };
  feed(t, '|switch|p2a: Latias|Latias, L79, F|100/100');
  feed(t, '|switch|p1a: Ditto|Ditto, L87|225/225\n|-transform|p1a: Ditto|p2a: Latias|[from] ability: Imposter\n|turn|2');
  feed(t, `|request|${JSON.stringify({ active: [{ moves: [] }], side: { id: 'p1', pokemon: [row] } })}`);
  const ditto = t.state.sides.p1.team[0]!;
  // Latias's base 110 Speed at level 79 with the Random Battle spread.
  assert.equal(ditto.stats.spe, Math.floor((2 * 110 + 31 + 21) * 79 / 100) + 5);
  assert.equal(ditto.stats.spa, Math.floor((2 * 110 + 31 + 21) * 79 / 100) + 5, 'Latias\'s Special Attack, not Ditto\'s');
  feed(t, '|switch|p1a: Ditto|Ditto, L87|225/225');
  void 0;
});

test('a charge move that fires is no longer charging, whether by Power Herb or on its second turn', () => {
  // 2687788784: Eternatus's Power Herb Meteor Beam fired at once but stayed marked as charging, so the engine offered it
  // only Meteor Beam next turn, and it charged a second one into Psychic Noise.
  const t = tracker();
  feed(t, '|switch|p1a: Eternatus|Eternatus, L69|308/308\n|turn|3');
  feed(t, '|move|p1a: Eternatus|Meteor Beam||[still]\n|-prepare|p1a: Eternatus|Meteor Beam\n|-boost|p1a: Eternatus|spa|1\n|-enditem|p1a: Eternatus|Power Herb\n|-anim|p1a: Eternatus|Meteor Beam|p2a: Sparky\n|turn|4');
  const eternatus = t.state.sides.p1.team.find(p => p.species === 'Eternatus')!;
  assert.equal(eternatus.volatiles.meteorbeam, undefined, 'Power Herb fired it the same turn');
  feed(t, '|move|p1a: Eternatus|Meteor Beam||[still]\n|-prepare|p1a: Eternatus|Meteor Beam\n|turn|5');
  assert.ok(eternatus.volatiles.meteorbeam, 'without the herb it charges');
  feed(t, '|move|p1a: Eternatus|Meteor Beam|p2a: Sparky|[from] lockedmove\n|turn|6');
  assert.equal(eternatus.volatiles.meteorbeam, undefined, 'and once it fires, the charge is over');
});

test('a berry eaten this turn is not handed back by the line that reports its heal', () => {
  // 2687862037: Drifblim's Sitrus Berry heal, reported after its -enditem, put the berry back, so Unburden was never counted.
  const t = tracker();
  feed(t, '|switch|p2a: Drifblim|Drifblim, L90, M|40/100\n|turn|5');
  feed(t, '|-enditem|p2a: Drifblim|Sitrus Berry|[eat]\n|-heal|p2a: Drifblim|65/100|[from] item: Sitrus Berry\n|turn|6');
  const drifblim = t.state.sides.p2.team.find(p => p.species === 'Drifblim')!;
  assert.equal(drifblim.item, '', 'the berry is gone');
  assert.equal(drifblim.lastBerry, 'Sitrus Berry');
  feed(t, '|-damage|p2a: Drifblim|55/100|[from] item: Life Orb\n|turn|7');
  assert.equal(drifblim.item, 'Life Orb', 'an item seen on a later turn is still revealed');
});

test('an immunity to a move whose type is set in battle is no Illusion clue', () => {
  // 2687882615: our Oricorio-Sensu's Revelation Dance is Ghost; a real Maushold is immune, but read as a Normal move it
  // named the Maushold a Zoroark-Hisui, and the bot played against a Pokémon that was not there.
  const t = tracker();
  feed(t, `|request|${JSON.stringify({ active: [{ moves: [] }], side: { id: 'p1', pokemon: [{ ident: 'p1: Oricorio', details: 'Oricorio-Sensu, L85, M', active: true, condition: '250/250', baseAbility: 'Dancer', item: 'heavydutyboots', moves: ['revelationdance', 'hurricane', 'quiverdance', 'roost'] }] } })}`);
  feed(t, '|switch|p1a: Oricorio|Oricorio-Sensu, L85, M|250/250\n|switch|p2a: Maushold|Maushold-Four, L76|100/100');
  feed(t, '|move|p1a: Oricorio|Revelation Dance|p2a: Maushold\n|-immune|p2a: Maushold\n|turn|5');
  const maushold = t.state.sides.p2.team.find(p => p.species.startsWith('Maushold'))!;
  assert.equal(maushold.illusion, undefined, 'a Ghost move on a Normal-type explains itself');
  assert.equal(maushold.species, 'Maushold-Four');
});

test('a replace line without HP keeps the HP and adds no malformed-condition note', () => {
  const t = tracker();
  feed(t, '|switch|p2a: Zoroark|Pachirisu, L96, M|81/100\n|replace|p2a: Zoroark|Zoroark-Hisui, L80, M\n|turn|3');
  const z = t.state.sides.p2.team.find(p => p.species === 'Zoroark-Hisui')!;
  assert.equal(z.hpPercent, 81);
  assert.ok(!t.state.uncertainties.some(u => /Malformed HP/.test(u)));
});
