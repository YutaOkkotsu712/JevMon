import { execFile } from 'node:child_process';
import { availableParallelism } from 'node:os';
import type { BattleState } from '../battle/BattleState.js';
import type { BattleAction } from '../battle/LegalActionGenerator.js';
import { dex, id } from '../pokemon/data.js';
import { sampleWorld, toEngineState, type Legal } from './engineState.js';
import { buildPokemon } from '../strategy/calcCore.js';

/**
 * Lookahead over sampled worlds, the part of Jaxcalibur its author credits with 100–150 Elo and the core of Foul Play.
 * Each world fixes one guess at every hidden opposing set, poke-engine runs Monte Carlo tree search on it with both
 * sides choosing at once, and the results are averaged. What comes back per legal action is the share of search
 * visits it drew and its mean score, a win estimate between 0 and 1 from the engine's own evaluation.
 */
export interface SearchOptions { bin: string; worlds?: number; msPerWorld?: number; concurrency?: number; random?: () => number;
  /** A file of evaluation weights for the engine (`POKE_ENGINE_WEIGHTS`); unset, the engine's own defaults. */
  weights?: string;
  /**
   * A second pass of this many worlds when the first leaves its top two actions close (the second drew at least
   * `closeRatio` of the first's visits). Reruns agreed on the top pick about nine times in ten; the tenth is where the
   * extra worlds go.
   */
  extraWorlds?: number; closeRatio?: number;
  /** Endgames with at most `maxPokemon` left on both sides together are solved by depth-limited expectiminimax instead. */
  endgame?: { maxPokemon: number; worlds: number; msPerWorld: number };
}
export interface ActionValue { visitShare: number; meanScore: number | null }

const exec = (bin: string, args: string[], timeout: number, weights?: string) => new Promise<string>((resolve, reject) =>
  execFile(bin, args, { timeout, maxBuffer: 1 << 20, ...(weights ? { env: { ...process.env, POKE_ENGINE_WEIGHTS: weights } } : {}) },
    (error, stdout) => (error ? reject(error) : resolve(stdout))));
const run = (bin: string, state: string, ms: number, weights?: string) =>
  exec(bin, ['monte-carlo-tree-search', '--state', state, '-t', String(ms)], ms * 4 + 2000, weights);

/** `side one options: a,b` / `side two options: c,d` / `matrix: …` from a fixed-depth expectiminimax, row-major. */
export function parseMatrix(output: string) {
  const field = (name: string) => output.split('\n').find(l => l.startsWith(name))?.slice(name.length).trim();
  const ours = field('side one options:')?.split(','), theirs = field('side two options:')?.split(','), cells = field('matrix:')?.split(',').map(Number);
  if (!ours?.length || !theirs?.length || !cells || cells.length !== ours.length * theirs.length || cells.some(v => !Number.isFinite(v))) return null;
  return { ours: ours.map(x => x.trim()), theirs: theirs.map(x => x.trim()), cells };
}

/**
 * The simultaneous-move game at the root, solved by regret matching: each side's average strategy converges to an
 * equilibrium of the zero-sum matrix game. The engine's own "safest" choice assumes the opponent sees our move first,
 * which on Flamigo's endgame preferred U-turn at depth 4 and Close Combat at depth 5; an equilibrium does not reward
 * that pessimism. Returns our strategy and each of our actions' payoff against theirs.
 */
export function solveMatrixGame(cells: number[], rows: number, cols: number, iterations = 4000) {
  const regretRow = new Array(rows).fill(0), regretCol = new Array(cols).fill(0);
  const sumRow = new Array(rows).fill(0), sumCol = new Array(cols).fill(0);
  const strategy = (regret: number[]) => {
    const positive = regret.map(r => Math.max(0, r)), total = positive.reduce((a, b) => a + b, 0);
    return total > 0 ? positive.map(r => r / total) : regret.map(() => 1 / regret.length);
  };
  for (let t = 0; t < iterations; t++) {
    const row = strategy(regretRow), col = strategy(regretCol);
    const rowPayoff = Array.from({ length: rows }, (_, i) => col.reduce((acc, q, j) => acc + q * cells[i * cols + j]!, 0));
    const colPayoff = Array.from({ length: cols }, (_, j) => row.reduce((acc, p, i) => acc + p * cells[i * cols + j]!, 0));
    const value = row.reduce((acc, p, i) => acc + p * rowPayoff[i]!, 0);
    for (let i = 0; i < rows; i++) { regretRow[i] += rowPayoff[i]! - value; sumRow[i] += row[i]!; }
    // The opponent minimises our payoff.
    for (let j = 0; j < cols; j++) { regretCol[j] += value - colPayoff[j]!; sumCol[j] += col[j]!; }
  }
  const row = sumRow.map(v => v / iterations), col = sumCol.map(v => v / iterations);
  const payoff = Array.from({ length: rows }, (_, i) => col.reduce((acc, q, j) => acc + q * cells[i * cols + j]!, 0));
  return { row, col, payoff, value: row.reduce((acc, p, i) => acc + p * payoff[i]!, 0) };
}

/** The engine's MCTS turns an evaluation into a win estimate this way; the solver's payoffs are put on the same scale. */
const sigmoid = (x: number) => 1 / (1 + Math.exp(-0.0125 * x));

/**
 * Expectiminimax on one world, deepened while the next depth still fits the time left. Each extra depth multiplied the
 * time by about fifteen on a five-Pokémon endgame (0.23 s at 4, 3.5 s at 5), so the next depth is tried only when
 * fifteen times the last one fits.
 */
async function solveWorld(bin: string, state: string, budgetMs: number, weights?: string) {
  const started = performance.now();
  let best: ReturnType<typeof parseMatrix> = null, lastMs = 0;
  for (let depth = 1; depth <= 8; depth++) {
    const left = budgetMs - (performance.now() - started);
    if (depth > 1 && lastMs * 15 > left) break;
    const t0 = performance.now();
    const parsed = parseMatrix(await exec(bin, ['expectiminimax', '--state', state, '--depth', String(depth)], Math.max(1000, left * 2), weights).catch(() => ''));
    if (!parsed) break;
    best = parsed; lastMs = performance.now() - t0;
  }
  return best;
}

/** Their side of the game plus ours, counted from the tracked state: what decides whether the solver can go deep. */
export function pokemonLeft(state: BattleState) {
  if (!state.mySide) return Infinity;
  return (['p1', 'p2'] as const).reduce((n, side) => n + Math.max(0, (state.sides[side].teamSize ?? 6) - state.sides[side].team.filter(p => p.fainted).length), 0);
}


/** `side one: psychic,85907.20,197070|excadrill,146148.17,332477` into move name, total score and visits. */
export function parseSideOne(output: string) {
  const line = output.split('\n').find(l => l.startsWith('side one:'));
  if (!line) return null;
  return line.slice('side one:'.length).trim().split('|').map(entry => {
    const [name = '', total = '0', visits = '0'] = entry.split(',');
    return { name: name.trim(), total: Number(total), visits: Number(visits) };
  });
}

/** The engine's name for one of our actions: the move's id, `-tera` when it Terastallises, or the switch target's species. */
export function engineName(action: BattleAction, state: BattleState): string | null {
  if (action.kind === 'switch') {
    const side = state.mySide ? state.sides[state.mySide] : undefined;
    const target = side?.team.find(p => p.slot === Number(action.command.split(' ')[1]));
    return target ? id(dex.species.get(target.species).name) : null;
  }
  if (action.kind !== 'move') return null;
  const move = dex.moves.get(action.label.split(' + Tera')[0]!);
  return move.exists ? `${move.id}${action.command.endsWith(' terastallize') ? '-tera' : ''}` : null;
}

export async function searchWorlds(state: BattleState, actions: BattleAction[], options: SearchOptions) {
  const side = state.mySide;
  if (!side) return null;
  // An active Pokémon the engine cannot be given becomes a placeholder, and then only our switches score at all: the
  // search voted "switch" at 1.00 over Minior's Earthquake. Better no lookahead than one that cannot see our moves.
  const ours = state.sides[side], me = ours.team.find(p => p.id === ours.activeId);
  if (me && !me.fainted && actions.some(a => a.kind === 'move')) {
    try { buildPokemon(me); } catch { return null; }
  }
  const legal: Legal = {
    moves: new Set(actions.filter(a => a.kind === 'move').map(a => dex.moves.get(a.label.split(' + Tera')[0]!).id)),
    canSwitch: actions.some(a => a.kind === 'switch'),
    canTera: actions.some(a => a.command.endsWith(' terastallize')),
    forcedSwitch: state.requestKind === 'switch',
  };
  const limit = Math.max(1, options.concurrency ?? availableParallelism() - 1);
  const names = new Map(actions.map(a => [a.id, engineName(a, state)] as const));
  const started = performance.now();
  const world = () => toEngineState(state, side, sampleWorld(state, side, options.random), legal).state;
  const lanes = async (count: number, job: (engineState: string) => Promise<void>) => {
    const queue = Array.from({ length: count }, world);
    await Promise.all(Array.from({ length: Math.min(limit, count) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await job(next);
    }));
  };
  const values: Record<string, ActionValue> = {};

  // Endgame: few Pokémon left, so a full-width search can go several turns deep. Each world's root matrix is solved as a
  // simultaneous-move game; our equilibrium strategy stands in for visit shares, and each action's payoff against theirs,
  // on the MCTS win scale, for the mean score.
  const endgame = options.endgame;
  if (endgame && state.requestKind === 'move' && pokemonLeft(state) <= endgame.maxPokemon) {
    const totals = new Map<string, { share: number; payoff: number; worlds: number }>();
    let solved = 0;
    await lanes(endgame.worlds, async engineState => {
      const m = await solveWorld(options.bin, engineState, endgame.msPerWorld, options.weights);
      if (!m) return;
      const game = solveMatrixGame(m.cells, m.ours.length, m.theirs.length);
      solved++;
      for (const [actionId, name] of names) {
        const i = m.ours.indexOf(name ?? '');
        if (i < 0) continue;
        const t = totals.get(actionId) ?? { share: 0, payoff: 0, worlds: 0 };
        t.share += game.row[i]!; t.payoff += game.payoff[i]! - game.value; t.worlds++;
        totals.set(actionId, t);
      }
    });
    if (solved) {
      for (const [actionId] of names) {
        const t = totals.get(actionId);
        values[actionId] = { visitShare: t ? Math.round(t.share / solved * 1000) / 1000 : 0,
          meanScore: t?.worlds ? Math.round(sigmoid(t.payoff / t.worlds) * 1000) / 1000 : null };
      }
      return { values, worldsSearched: solved, msTotal: Math.round(performance.now() - started), solver: 'endgame' as const };
    }
  }

  const totals = new Map<string, { share: number; score: number; visits: number }>();
  let searched = 0;
  const mcts = (ms: number) => async (engineState: string) => {
    const entries = parseSideOne(await run(options.bin, engineState, ms, options.weights).catch(() => ''));
    if (!entries) return;
    const visits = entries.reduce((n, e) => n + e.visits, 0);
    if (!visits) return;
    searched++;
    for (const [actionId, name] of names) {
      const e = entries.find(x => x.name === name);
      const t = totals.get(actionId) ?? { share: 0, score: 0, visits: 0 };
      // Scores are pooled by visits: averaging each world's mean gave a world where the action drew a handful of
      // visits as much say as one where it drew thousands, and the override margin was read off that noise.
      if (e) { t.share += e.visits / visits; t.score += e.total; t.visits += e.visits; }
      totals.set(actionId, t);
    }
  };
  const ms = options.msPerWorld ?? 100;
  await lanes(options.worlds ?? 16, mcts(ms));
  if (!searched) return null;
  // A close call gets more worlds, pooled with the first pass.
  const ranked = [...totals.values()].map(t => t.share).sort((a, b) => b - a);
  const extended = !!options.extraWorlds && ranked.length > 1 && ranked[1]! >= (options.closeRatio ?? 0.6) * ranked[0]!;
  if (extended) await lanes(options.extraWorlds!, mcts(ms));
  for (const [actionId, t] of totals) {
    values[actionId] = { visitShare: Math.round(t.share / searched * 1000) / 1000,
      meanScore: t.visits ? Math.round(t.score / t.visits * 1000) / 1000 : null };
  }
  return { values, worldsSearched: searched, msTotal: Math.round(performance.now() - started), ...(extended ? { extended: true as const } : {}) };
}

/** The search's settings as configured, shared by the bot and the self-play bench. */
export interface SearchConfig { bin: string; worlds: number; msPerWorld: number; extraWorlds: number; closeRatio: number;
  endgamePokemon: number; endgameWorlds: number; endgameMsPerWorld: number; weights?: string }
export function searchOptions(c: SearchConfig, lanes: number): SearchOptions {
  return { bin: c.bin, worlds: c.worlds, msPerWorld: c.msPerWorld, concurrency: lanes, ...(c.weights ? { weights: c.weights } : {}),
    ...(c.extraWorlds ? { extraWorlds: c.extraWorlds, closeRatio: c.closeRatio } : {}),
    ...(c.endgamePokemon ? { endgame: { maxPokemon: c.endgamePokemon, worlds: c.endgameWorlds, msPerWorld: c.endgameMsPerWorld } } : {}) };
}
/** Twice the expected time of the longest path, plus a second: a slow search is dropped rather than waited on. */
export function searchTimeoutMs(c: SearchConfig, lanes: number) {
  const pass = (worlds: number, ms: number) => Math.ceil(worlds / lanes) * ms * 2;
  const mcts = pass(c.worlds, c.msPerWorld) + (c.extraWorlds ? pass(c.extraWorlds, c.msPerWorld) : 0);
  const endgame = c.endgamePokemon ? pass(c.endgameWorlds, c.endgameMsPerWorld) : 0;
  return Math.max(mcts, endgame) + 1000;
}
