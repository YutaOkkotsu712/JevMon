// Decision-level A/B for a policy change: guards, planning, the ranking that follows the search. Both sides play policy
// B in self-play. At every decision policy A is run too, on the same position and the same search result, so the only
// thing that can make the two choose differently is the policy itself. Where they do, a judge scores both choices:
// poke-engine's tree search on the true position, with the opponent's real sets and far longer than the bot searches.
//
// Why not the whole-game bench: a policy change typically alters a few percent of decisions, and the rest of every game
// is shared noise. 200 games resolve about ±7 points of win rate; a change worth 2 points needs about 5,000. This
// spends its effort only on the decisions that differ. The judge is the same engine the bot searches with, so it cannot
// see a mistake the engine's own mechanics make; it can see everything hidden information and a short search cost.
//
//   SIMULATOR_DIR=~/.cache/jevmon-sim node scripts/divergence.mjs --games 40 --name planning \
//     --a '{"planning":false}' --b '{"planning":true}'
//
// A config takes planning (default true), guards: false, skipGuards and extraGuards, as in the bench. Search settings
// (worlds, msPerWorld, weights, ...) come from B and are used by both sides, since only the policy is compared. Every
// divergence and every game go to logs/divergence/<name>.jsonl; rerunning with the same name resumes. A run with A the
// same as B must find no divergences at all: any it finds mean the policy is not reproducible, and nothing else holds.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BattleManager } from '../dist/src/battle/BattleManager.js';
import { DecisionLoop } from '../dist/src/battle/DecisionLoop.js';
import { parseFrame } from '../dist/src/showdown/protocol.js';
import { engineName, parseSideOne, searchOptions, searchTimeoutMs, searchWorlds } from '../dist/src/search/search.js';
import { toEngineState } from '../dist/src/search/engineState.js';
import { dex, id } from '../dist/src/pokemon/data.js';

const { values: args } = parseArgs({ options: {
  games: { type: 'string', default: '20' }, a: { type: 'string', default: '{}' }, b: { type: 'string', default: '{}' },
  name: { type: 'string', default: 'divergence' }, 'first-seed': { type: 'string', default: '1' },
  'judge-ms': { type: 'string', default: '1500' }, 'judge-runs': { type: 'string', default: '2' },
  lanes: { type: 'string' }, force: { type: 'boolean', default: false },
} });
if (!process.env.SIMULATOR_DIR) throw new Error('Set SIMULATOR_DIR to a directory containing @pkmn/sim and @pkmn/randoms');
const require = createRequire(resolve(process.env.SIMULATOR_DIR, 'package.json'));
const { BattleStreams, Teams } = require('@pkmn/sim');
const { TeamGenerators } = require('@pkmn/randoms');
Teams.setGeneratorFactory(TeamGenerators);

const pidFile = 'logs/bot.pid';
if (!args.force && existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) throw new Error(`the ladder bot (pid ${pid}) is running; stop it first, or pass --force to share the CPU`);
}

const bin = process.env.POKE_ENGINE_BIN?.trim() || 'vendor/poke-engine/target/release/poke-engine';
const defaults = { bin, worlds: 16, msPerWorld: 100, extraWorlds: 0, closeRatio: 0.6, endgamePokemon: 0, endgameWorlds: 8,
  endgameMsPerWorld: 400, planning: true, guards: true, skipGuards: [], extraGuards: [] };
const A = { ...defaults, ...JSON.parse(args.a) }, B = { ...defaults, ...JSON.parse(args.b) };
const policy = c => ({ planning: c.planning !== false,
  guards: c.guards === false ? false : c.skipGuards?.length || c.extraGuards?.length ? { skip: c.skipGuards ?? [], extra: c.extraGuards ?? [] } : true });
const lanes = Math.max(1, Number(args.lanes ?? Math.floor((availableParallelism() - 1) / 2)));
const judgeMs = Number(args['judge-ms']), judgeRuns = Math.max(1, Number(args['judge-runs']));
const games = Number(args.games), firstSeed = Number(args['first-seed']);
mkdirSync('logs/divergence', { recursive: true });
const out = `logs/divergence/${args.name}.jsonl`;
const done = new Set();
if (existsSync(out)) for (const line of readFileSync(out, 'utf8').trim().split('\n').filter(Boolean)) {
  const r = JSON.parse(line); if (r.game) done.add(r.seed);
}
if (!existsSync(out)) appendFileSync(out, JSON.stringify({ header: true, a: A, b: B, judgeMs, judgeRuns, lanes, started: new Date().toISOString() }) + '\n');
// The search both policies read: it runs once per decision, for the policy actually playing.
const searchConfig = B;
const blend = run => ({ mode: 'blend', weight: 1, overrideMargin: 0.03, inPayload: false, timeoutMs: searchTimeoutMs(searchConfig, lanes), run });
const searchOnly = { async chooseAction() { throw new Error('search only'); } };

/** Policy A's choice on the position B just decided, given B's own search result. */
function shadowChoice(room, username, state, request, search) {
  return new Promise(resolveChoice => {
    const timer = setTimeout(() => resolveChoice(null), 20_000);
    const loop = new DecisionLoop({ room, username, dryRun: true, send: () => false, state: () => state, onStatus() {},
      onDecision: record => { clearTimeout(timer); resolveChoice(record); }, timeoutMs: 50, provider: searchOnly,
      search: blend(async () => search), ...policy(A) });
    loop.request(request);
  });
}

/** The opponent's true sets, from the simulator, in the form a sampled world takes. */
function truthWorld(state, ourSide, battle) {
  const theirs = ourSide === 'p1' ? 'p2' : 'p1';
  const base = name => id(dex.species.get(name).baseSpecies || name);
  const candidate = set => ({ ability: set.ability, item: set.item, moves: [...set.moves],
    evs: { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84, ...set.evs }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...set.ivs },
    teraType: set.teraType || dex.species.get(set.species).types[0], probability: 1 });
  const world = { sets: new Map(), unrevealed: [] }, used = new Set();
  for (const p of state.sides[theirs].team) {
    const sim = battle[theirs].pokemon.find(x => !used.has(x) && base(x.set.species) === base(p.species));
    if (!sim) continue;
    used.add(sim); world.sets.set(p.id, candidate(sim.set));
  }
  for (const sim of battle[theirs].pokemon) {
    if (used.has(sim)) continue;
    const name = dex.species.get(sim.set.species).name;
    world.unrevealed.push({ set: candidate(sim.set), pokemon: { id: `unseen:${id(name)}`, slot: 0, ident: `unseen: ${name}`,
      details: `${name}, L${sim.set.level ?? 100}`, species: name, hpPercent: 100, fainted: false, status: null, boosts: {}, volatiles: {},
      knownMoves: [], revealedMoves: [], movePP: {}, moveUses: {}, ability: null, baseAbility: null, abilitySuppressed: false, item: null,
      teraType: null, terastallized: false, transformedInto: null, copiedMoves: [] } });
  }
  return world;
}

const engine = (state, ms) => new Promise(resolveRun => execFile(bin, ['monte-carlo-tree-search', '--state', state, '-t', String(ms)],
  { timeout: ms * 4 + 2000, maxBuffer: 1 << 20 }, (error, stdout) => resolveRun(error ? null : parseSideOne(stdout))));
/** Each of our actions' mean score from the judge's pooled runs on the true position; null where it drew no visits. */
async function judge(state, actions, battle) {
  const side = state.mySide;
  const legal = { moves: new Set(actions.filter(a => a.kind === 'move').map(a => dex.moves.get(a.label.split(' + Tera')[0]).id)),
    canSwitch: actions.some(a => a.kind === 'switch'), canTera: actions.some(a => a.command.endsWith(' terastallize')),
    forcedSwitch: state.requestKind === 'switch' };
  const engineState = toEngineState(state, side, truthWorld(state, side, battle), legal).state;
  const runs = (await Promise.all(Array.from({ length: judgeRuns }, () => engine(engineState, judgeMs)))).filter(Boolean);
  const scores = {};
  for (const a of actions) {
    const name = engineName(a, state);
    let total = 0, visits = 0;
    for (const entries of runs) { const e = entries.find(x => x.name === name); if (e) { total += e.total; visits += e.visits; } }
    scores[a.id] = visits ? { score: Math.round(total / visits * 1000) / 1000, visits } : null;
  }
  return scores;
}

async function play(seed) {
  const stream = new BattleStreams.BattleStream();
  const streams = BattleStreams.getPlayerStreams(stream);
  const room = `battle-gen9randombattle-diverge${seed}`;
  const names = { p1: 'Bot1', p2: 'Bot2' };
  const stats = { decisions: 0, compared: 0, divergences: 0, judged: 0, shadowFailed: 0 };
  let winner = null, turns = 0, fatal;
  const failure = new Promise((_, reject) => { fatal = reject; });
  const started = Date.now();
  const timeout = setTimeout(() => fatal(new Error('timeout')), 30 * 60_000);
  const managers = [];
  const tasks = ['p1', 'p2'].map(side => {
    let rqid = 0, request = null;
    // A side's choice waits for its divergence to be judged, so the judge has the CPU and the position does not move.
    let gate = Promise.resolve();
    const manager = new BattleManager({ room, username: names[side],
      send(command) {
        const match = /\|\/choose (.+)\|(\d+)$/.exec(command);
        if (match) void Promise.resolve().then(() => gate).then(() => streams[side].write(match[1])).catch(fatal);
        return true;
      },
      onStatus(status) { if (/invalid request|no request-supported|retry limit|processing failed/.test(status)) fatal(new Error(status)); },
      onSnapshot(event, state) { turns = Math.max(turns, state.turn); if (event === 'win') winner = state.winner; },
      play: { dryRun: false, timeoutMs: 50, ...policy(B), provider: searchOnly,
        search: blend((state, actions) => searchWorlds(state, actions, searchOptions(searchConfig, lanes))),
        onDecision(record, state) {
          stats.decisions++;
          const search = record.search;
          if (!search || record.legalActions.length < 2 || !request) return;
          const raw = request, battle = stream.battle;
          gate = (async () => {
            const shadow = await shadowChoice(room, names[side], state, raw, { values: search.values, worldsSearched: search.worldsSearched, msTotal: search.msTotal });
            if (!shadow) { stats.shadowFailed++; return; }
            stats.compared++;
            const a = shadow.selectedAction, b = record.selectedAction;
            if (a.id === b.id) return;
            stats.divergences++;
            const scores = await judge(state, record.legalActions, battle);
            const delta = scores[a.id] && scores[b.id] ? Math.round((scores[b.id].score - scores[a.id].score) * 1000) / 1000 : null;
            if (delta !== null) stats.judged++;
            appendFileSync(out, JSON.stringify({ divergence: true, seed, side, turn: state.turn, delta,
              a: { id: a.id, label: a.label, judge: scores[a.id], search: search.values[a.id] ?? null },
              b: { id: b.id, label: b.label, judge: scores[b.id], search: search.values[b.id] ?? null },
              judgeBest: Object.entries(scores).filter(([, v]) => v).sort((x, y) => y[1].score - x[1].score)[0]?.[0] ?? null,
              changedByB: record.tacticalRanking?.from !== record.tacticalRanking?.to ? record.tacticalRanking : undefined,
              skippedByA: shadow.skippedDominatedMove ?? shadow.skippedCyclicSwitch }) + '\n');
          })().catch(() => { stats.shadowFailed++; });
        } } });
    managers.push(manager);
    manager.handle({ room, type: 'init', data: 'battle' });
    return (async () => {
      for await (const chunk of streams[side]) for (const message of parseFrame(`>${room}\n${chunk}`)) {
        if (message.type === 'request') {
          const data = JSON.parse(message.data);
          if (data) { data.rqid = ++rqid; message.data = JSON.stringify(data); request = message.data; }
        }
        manager.handle(message);
      }
    })();
  });
  tasks.push((async () => { for await (const _chunk of streams.omniscient) { /* drain */ } })());
  try {
    await streams.omniscient.write(`>start ${JSON.stringify({ formatid: 'gen9randombattle', seed: [seed, 2, 3, 4] })}\n` +
      `>player p1 ${JSON.stringify({ name: names.p1, seed: [seed, 11, 22, 33] })}\n>player p2 ${JSON.stringify({ name: names.p2, seed: [seed, 44, 55, 66] })}`);
    await Promise.race([Promise.all(tasks), failure]);
    return { game: true, seed, winner: winner ?? 'tie', turns, seconds: Math.round((Date.now() - started) / 1000), ...stats };
  } catch (e) {
    return { game: true, seed, winner: 'error', error: String(e.message ?? e), turns, seconds: Math.round((Date.now() - started) / 1000), ...stats };
  } finally {
    clearTimeout(timeout);
    for (const m of managers) m.disconnect();
    if (!winner) try { stream.destroy(); } catch { /* already closed */ }
  }
}

function report() {
  const rows = readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const played = rows.filter(r => r.game && r.winner !== 'error'), divs = rows.filter(r => r.divergence);
  const decisions = played.reduce((n, g) => n + g.decisions, 0), compared = played.reduce((n, g) => n + g.compared, 0);
  const failed = played.reduce((n, g) => n + g.shadowFailed, 0);
  const deltas = divs.map(d => d.delta).filter(d => d !== null);
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  const sd = Math.sqrt(deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / Math.max(1, deltas.length - 1));
  const half = 1.96 * sd / Math.sqrt(Math.max(1, deltas.length));
  // Per player per game: both sides play B, so each game holds two players' worth of divergences.
  const perPlayer = divs.length / Math.max(1, 2 * played.length);
  const better = deltas.filter(d => d > 0.01).length, worse = deltas.filter(d => d < -0.01).length;
  console.log(`${played.length} games, ${decisions} decisions, ${compared} compared (${failed} shadow failures): ` +
    `${divs.length} divergences = ${(100 * divs.length / Math.max(1, compared)).toFixed(1)}% of decisions, ${perPlayer.toFixed(2)} per player-game`);
  if (!deltas.length) { console.log('no judged divergences yet'); return; }
  console.log(`judged ${deltas.length}: B's choice minus A's, in the judge's win estimate: mean ${mean.toFixed(4)} ` +
    `[95% ${(mean - half).toFixed(4)} to ${(mean + half).toFixed(4)}]; B better in ${better}, A better in ${worse}, within 0.01 in ${deltas.length - better - worse}`);
  console.log(`about ${(100 * mean * perPlayer).toFixed(2)} points of win rate per game for the player using B ` +
    `[${(100 * (mean - half) * perPlayer).toFixed(2)} to ${(100 * (mean + half) * perPlayer).toFixed(2)}], if the judge's estimates were win probabilities`);
}

console.log(`divergence ${args.name}: ${games} games from seed ${firstSeed}, ${lanes} search lanes per player, judge ${judgeRuns} x ${judgeMs} ms`);
console.log('A', JSON.stringify(policy(A)), 'B', JSON.stringify(policy(B)), 'search', JSON.stringify({ worlds: B.worlds, msPerWorld: B.msPerWorld }));
for (let seed = firstSeed; seed < firstSeed + games; seed++) {
  if (done.has(seed)) continue;
  const result = await play(seed);
  appendFileSync(out, JSON.stringify(result) + '\n');
  console.log(`seed ${seed}: ${result.winner}${result.error ? ` (${result.error})` : ''} in ${result.turns} turns, ${result.seconds}s, ` +
    `${result.divergences} of ${result.compared} decisions differ`);
  report();
}
report();
