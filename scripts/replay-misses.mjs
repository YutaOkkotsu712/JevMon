// Replays the large misses an audit saved (scripts/divergence.mjs --audit keeps each position where the bot's choice
// fell 0.05 or more short of the judge's best) and says where each came from. The bot's own search is run again, on
// sampled worlds at its own budget, and then the same budget on the opponent's real sets:
//   - hidden information: with the real sets the search finds the judge's move, and on sampled worlds it does not;
//   - search: with the real sets at the bot's budget it still misses, so the budget, the noise or the evaluation did;
//   - noise: rerun on sampled worlds, the search itself no longer prefers the move the bot played.
//
//   node scripts/replay-misses.mjs logs/divergence/audit2.jsonl [--runs 3]
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { engineName, parseSideOne, searchWorlds } from '../dist/src/search/search.js';
import { toEngineState } from '../dist/src/search/engineState.js';
import { dex } from '../dist/src/pokemon/data.js';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  runs: { type: 'string', default: '3' }, worlds: { type: 'string', default: '16' }, ms: { type: 'string', default: '100' } } });
const bin = process.env.POKE_ENGINE_BIN?.trim() || 'vendor/poke-engine/target/release/poke-engine';
const runs = Number(args.runs), worlds = Number(args.worlds), ms = Number(args.ms);
const lanes = Math.max(1, availableParallelism() - 1);
const misses = readFileSync(positionals[0], 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.audit && r.position);

const engine = state => new Promise(resolve => execFile(bin, ['monte-carlo-tree-search', '--state', state, '-t', String(ms)],
  { timeout: ms * 4 + 2000, maxBuffer: 1 << 20 }, (error, stdout) => resolve(error ? null : parseSideOne(stdout))));
/** The bot's pooling (search.ts) over `worlds` runs on one fixed world: its pick by visit share. */
async function trueWorldPick(state, actions, world) {
  const legal = { moves: new Set(actions.filter(a => a.kind === 'move').map(a => dex.moves.get(a.label.split(' + Tera')[0]).id)),
    canSwitch: actions.some(a => a.kind === 'switch'), canTera: actions.some(a => a.command.endsWith(' terastallize')),
    forcedSwitch: state.requestKind === 'switch' };
  const engineState = toEngineState(state, state.mySide, world, legal).state;
  const share = new Map();
  for (let done = 0; done < worlds; done += lanes) {
    const results = await Promise.all(Array.from({ length: Math.min(lanes, worlds - done) }, () => engine(engineState)));
    for (const entries of results.filter(Boolean)) {
      const visits = entries.reduce((n, e) => n + e.visits, 0);
      for (const a of actions) { const e = entries.find(x => x.name === engineName(a, state)); if (e && visits) share.set(a.id, (share.get(a.id) ?? 0) + e.visits / visits); }
    }
  }
  return [...share].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
}
const sampledPick = async (state, actions) => {
  const result = await searchWorlds(state, actions, { bin, worlds, msPerWorld: ms, concurrency: lanes });
  return result ? Object.entries(result.values).sort((x, y) => y[1].visitShare - x[1].visitShare)[0]?.[0] ?? null : null;
};

const verdicts = { 'hidden information': 0, search: 0, noise: 0 };
for (const m of misses) {
  const { state, legalActions, truth } = m.position;
  const world = { sets: new Map(truth.sets), unrevealed: truth.unrevealed };
  const sampled = [], real = [];
  for (let i = 0; i < runs; i++) { sampled.push(await sampledPick(state, legalActions)); real.push(await trueWorldPick(state, legalActions, world)); }
  const count = (picks, id) => picks.filter(p => p === id).length;
  const verdict = count(sampled, m.chosen.id) * 2 <= runs ? 'noise'
    : count(real, m.best.id) * 2 > runs ? 'hidden information' : 'search';
  verdicts[verdict]++;
  const label = id => legalActions.find(a => a.id === id)?.label ?? id;
  console.log(`seed ${m.seed} ${m.side} t${m.turn}${m.forced ? ' (replacement)' : ''}: regret ${m.regret}, played ${label(m.chosen.id)}, judge ${label(m.best.id)} -> ${verdict}` +
    `\n    sampled worlds pick: ${sampled.map(label).join(' | ')}\n    real sets pick:      ${real.map(label).join(' | ')}`);
}
console.log(`\n${misses.length} misses: ${Object.entries(verdicts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
