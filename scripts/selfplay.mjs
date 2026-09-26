// Self-play bench: two search configurations play Gen 9 Random Battles against each other on a local simulator, with no
// Jev calls and no ladder. Every seed is played twice with the teams swapped, so team luck cancels; the verdict is B's
// win rate against A with a 95% interval. Twenty ladder games cannot tell a 50-Elo change from luck; a few hundred of
// these can, overnight and for free.
//
//   SIMULATOR_DIR=~/.cache/jevmon-sim node scripts/selfplay.mjs --pairs 100 \
//     --a '{"worlds":16,"msPerWorld":200}' --b '{"worlds":32,"msPerWorld":400,"extraWorlds":16}' --name budget
//
// A config takes the search settings (worlds, msPerWorld, extraWorlds, closeRatio, endgamePokemon, endgameWorlds,
// endgameMsPerWorld, weights: a POKE_ENGINE_WEIGHTS file), guards: false to play without the strategy guards, and
// skipGuards: ["savingTheDoomed", ...] to leave only those out, extraGuards: ["legacyHealAtFullHP", ...] to add the
// pre-audit-v12 rules kept in LEGACY_GUARDS. Results
// go to logs/bench/<name>.jsonl, one line per game; rerunning with the same name resumes where it stopped. Every decision's
// evaluation terms, from the deciding side and labelled with its result, go to <name>.positions.jsonl for fitting weights. Searches are CPU-bound and time-limited,
// so the bench refuses to run while the ladder bot is playing unless --force is given.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BattleManager } from '../dist/src/battle/BattleManager.js';
import { parseFrame } from '../dist/src/showdown/protocol.js';
import { searchOptions, searchTimeoutMs, searchWorlds } from '../dist/src/search/search.js';
import { sampleWorld, toEngineState } from '../dist/src/search/engineState.js';
import { execFileSync } from 'node:child_process';

const { values: args } = parseArgs({ options: {
  pairs: { type: 'string', default: '50' }, a: { type: 'string', default: '{}' }, b: { type: 'string', default: '{}' },
  name: { type: 'string', default: 'bench' }, lanes: { type: 'string' }, parallel: { type: 'string', default: '1' },
  'first-seed': { type: 'string', default: '1' }, force: { type: 'boolean', default: false },
  // An engine build with the `features` command; positions are skipped without one.
  'features-bin': { type: 'string', default: existsSync('vendor/poke-engine/target-next/release/poke-engine')
    ? 'vendor/poke-engine/target-next/release/poke-engine' : 'vendor/poke-engine/target/release/poke-engine' },
} });
if (!process.env.SIMULATOR_DIR) throw new Error('Set SIMULATOR_DIR to a directory containing @pkmn/sim and @pkmn/randoms');
const require = createRequire(resolve(process.env.SIMULATOR_DIR, 'package.json'));
const { BattleStreams, Teams } = require('@pkmn/sim');
const { TeamGenerators } = require('@pkmn/randoms');
Teams.setGeneratorFactory(TeamGenerators);

// The ladder bot searches on every core it can; a bench beside it would slow both, and the bot's search is time-bound.
const pidFile = 'logs/bot.pid';
if (!args.force && existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  if (alive) throw new Error(`the ladder bot (pid ${pid}) is running; stop it first, or pass --force to share the CPU`);
}

const defaults = { bin: process.env.POKE_ENGINE_BIN?.trim() || 'vendor/poke-engine/target/release/poke-engine', worlds: 16, msPerWorld: 200,
  extraWorlds: 0, closeRatio: 0.6, endgamePokemon: 0, endgameWorlds: 8, endgameMsPerWorld: 400, guards: true, skipGuards: [], extraGuards: [] };
const configs = { A: { ...defaults, ...JSON.parse(args.a) }, B: { ...defaults, ...JSON.parse(args.b) } };
const parallel = Math.max(1, Number(args.parallel));
// Both players search at once in every game.
const lanes = Math.max(1, Number(args.lanes ?? Math.floor((availableParallelism() - 1) / (2 * parallel))));
const pairs = Number(args.pairs), firstSeed = Number(args['first-seed']);
mkdirSync('logs/bench', { recursive: true });
const out = `logs/bench/${args.name}.jsonl`, positionsOut = `logs/bench/${args.name}.positions.jsonl`;
/** The evaluation's terms for one side's view of a tracked state, on a sampled world; null when the engine cannot say. */
function features(state) {
  try {
    const engineState = toEngineState(state, state.mySide, sampleWorld(state, state.mySide)).state;
    const lines = execFileSync(args['features-bin'], ['features', '--state', engineState], { timeout: 5000 }).toString().trim().split('\n');
    return Object.fromEntries(lines.map(l => l.split(' ')).filter(([k]) => k !== 'evaluation').map(([k, v]) => [k, Number(v)]));
  } catch { return null; }
}
const done = new Map();
if (existsSync(out)) for (const line of readFileSync(out, 'utf8').trim().split('\n').filter(Boolean)) {
  const r = JSON.parse(line); if (r.game) done.set(`${r.seed}:${r.bAs}`, r);
}
if (!existsSync(out)) appendFileSync(out, JSON.stringify({ header: true, a: configs.A, b: configs.B, lanes, started: new Date().toISOString() }) + '\n');

/** One game: B plays as p1 or p2, and the teams follow the slot, so the second game of a pair swaps them. */
async function play(seed, bAs) {
  const stream = new BattleStreams.BattleStream();
  const streams = BattleStreams.getPlayerStreams(stream);
  const room = `battle-gen9randombattle-bench${seed}${bAs}`;
  const slots = { p1: bAs === 'p1' ? 'B' : 'A', p2: bAs === 'p2' ? 'B' : 'A' };
  const names = { p1: 'Bot1', p2: 'Bot2' };
  const stats = { A: { decisions: 0, endgame: 0, extended: 0, skips: 0 }, B: { decisions: 0, endgame: 0, extended: 0, skips: 0 } };
  const positions = [];
  let winner = null, turns = 0, fatal;
  const failure = new Promise((_, reject) => { fatal = reject; });
  const started = Date.now();
  const timeout = setTimeout(() => fatal(new Error('timeout')), 15 * 60_000);
  const managers = [];
  const tasks = ['p1', 'p2'].map(side => {
    const who = slots[side], config = configs[who];
    let rqid = 0;
    const manager = new BattleManager({
      room, username: names[side],
      send(command) {
        const match = /\|\/choose (.+)\|(\d+)$/.exec(command);
        if (match) void Promise.resolve(streams[side].write(match[1])).catch(fatal);
        return true;
      },
      onStatus(status) { if (/invalid request|no request-supported|retry limit|processing failed/.test(status)) fatal(new Error(status)); },
      onSnapshot(event, state) { turns = Math.max(turns, state.turn); if (event === 'win') winner = state.winner; },
      play: { dryRun: false, timeoutMs: 50,
        guards: config.guards === false ? false : config.skipGuards?.length || config.extraGuards?.length ? { skip: config.skipGuards ?? [], extra: config.extraGuards ?? [] } : true,
        // Search alone decides: without a provider ranking the blend plays the search's own.
        provider: { async chooseAction() { throw new Error('search only'); } },
        search: { mode: 'blend', weight: 1, overrideMargin: 0.03, inPayload: false, timeoutMs: searchTimeoutMs(config, lanes),
          run: (state, actions) => searchWorlds(state, actions, searchOptions(config, lanes)) },
        onDecision(record, state) {
          const s = stats[who]; s.decisions++;
          if (state.requestKind === 'move') { const f = features(state); if (f) positions.push({ seed, bAs, who, turn: state.turn, f }); }
          if (record.search?.solver === 'endgame') s.endgame++;
          if (record.search?.extended) s.extended++;
          if (record.skippedDominatedMove) s.skips++;
        } },
    });
    managers.push(manager);
    manager.handle({ room, type: 'init', data: 'battle' });
    return (async () => {
      for await (const chunk of streams[side]) {
        for (const message of parseFrame(`>${room}\n${chunk}`)) {
          if (message.type === 'request') {
            const data = JSON.parse(message.data);
            if (data) { data.rqid = ++rqid; message.data = JSON.stringify(data); }
          }
          manager.handle(message);
        }
      }
    })();
  });
  tasks.push((async () => { for await (const _chunk of streams.omniscient) { /* drain */ } })());
  // The team follows the slot: in the pair's second game B takes the slot, and so the team, A had in the first.
  const seedFor = side => (side === 'p1' ? [seed, 11, 22, 33] : [seed, 44, 55, 66]);
  try {
    await streams.omniscient.write(`>start ${JSON.stringify({ formatid: 'gen9randombattle', seed: [seed, 2, 3, 4] })}\n` +
      `>player p1 ${JSON.stringify({ name: names.p1, seed: seedFor('p1') })}\n>player p2 ${JSON.stringify({ name: names.p2, seed: seedFor('p2') })}`);
    await Promise.race([Promise.all(tasks), failure]);
    const side = winner === names.p1 ? 'p1' : winner === names.p2 ? 'p2' : null;
    if (side) appendFileSync(positionsOut, positions.map(p => JSON.stringify({ ...p, won: p.who === slots[side] })).join('\n') + (positions.length ? '\n' : ''));
    return { game: true, seed, bAs, winner: side ? slots[side] : 'tie', turns, seconds: Math.round((Date.now() - started) / 1000), stats };
  } catch (e) {
    return { game: true, seed, bAs, winner: 'error', error: String(e.message ?? e), turns, seconds: Math.round((Date.now() - started) / 1000), stats };
  } finally {
    clearTimeout(timeout);
    for (const m of managers) m.disconnect();
    // A finished stream has already ended; destroying it again throws.
    if (!winner) try { stream.destroy(); } catch { /* already closed */ }
  }
}

/** Wilson score interval for B's share of decided games. */
function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = wins / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}
function report() {
  const games = [...done.values()];
  const decided = games.filter(g => g.winner === 'A' || g.winner === 'B');
  const b = decided.filter(g => g.winner === 'B').length;
  const [lo, hi] = wilson(b, decided.length);
  const elo = p => (p <= 0 ? -Infinity : p >= 1 ? Infinity : Math.round(-400 * Math.log10(1 / p - 1)));
  const bySeed = new Map(); for (const g of decided) (bySeed.get(g.seed) ?? bySeed.set(g.seed, []).get(g.seed)).push(g.winner);
  const full = [...bySeed.values()].filter(w => w.length === 2);
  const sweeps = { B: full.filter(w => w.every(x => x === 'B')).length, A: full.filter(w => w.every(x => x === 'A')).length };
  console.log(`${decided.length} decided (${games.length - decided.length} tie/error): B won ${b} = ${(100 * b / Math.max(1, decided.length)).toFixed(1)}% ` +
    `[95% ${(100 * lo).toFixed(1)}-${(100 * hi).toFixed(1)}%], about ${elo(b / Math.max(1, decided.length))} Elo; ` +
    `pairs swept by B ${sweeps.B}, by A ${sweeps.A}, split ${full.length - sweeps.A - sweeps.B}`);
}

console.log(`bench ${args.name}: ${pairs} pairs from seed ${firstSeed}, ${parallel} at a time, ${lanes} search lanes per player`);
console.log('A', JSON.stringify(configs.A)); console.log('B', JSON.stringify(configs.B));
const jobs = [];
for (let seed = firstSeed; seed < firstSeed + pairs; seed++) for (const bAs of ['p1', 'p2']) if (!done.has(`${seed}:${bAs}`)) jobs.push({ seed, bAs });
await Promise.all(Array.from({ length: parallel }, async () => {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const result = await play(job.seed, job.bAs);
    done.set(`${job.seed}:${job.bAs}`, result);
    appendFileSync(out, JSON.stringify(result) + '\n');
    console.log(`seed ${job.seed} B as ${job.bAs}: ${result.winner}${result.error ? ` (${result.error})` : ''} in ${result.turns} turns, ${result.seconds}s`);
    report();
  }
}));
report();
