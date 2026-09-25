// Fit poke-engine's evaluation weights to who actually won. Every position is described by the evaluation's own
// unweighted terms (`poke-engine features`, side one minus side two) and labelled with the game's result for that side.
//
//   node scripts/fit-weights.mjs --ladder --bench endgame5,weights1 --out logs/weights/fitted.txt
//
// --ladder reads our logged ladder decisions (hidden sets sampled, as the search does); --bench reads the positions the
// self-play bench recorded. Positions within a game share one result, so they are far from independent: folds are split
// by game, and the weights are pulled toward the current ones (scaled to predict wins) so that a term seen in a handful
// of games cannot swing on them. The written weights keep the current weights' overall scale, so only their proportions
// change and the search's rewards stay as sharp as before.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  ladder: { type: 'boolean', default: false }, bench: { type: 'string', default: '' }, out: { type: 'string', default: 'logs/weights/fitted.txt' },
  bin: { type: 'string', default: existsSync('vendor/poke-engine/target-next/release/poke-engine')
    ? 'vendor/poke-engine/target-next/release/poke-engine' : 'vendor/poke-engine/target/release/poke-engine' },
  folds: { type: 'string', default: '5' },
} });

// The default weights and term names, straight from the engine: a zero state's features name every term, and a
// weights file of one term at a time would be slow, so the defaults are listed here and checked against the engine.
const DEFAULTS = { alive: 30, hp: 100, item: 10, used_tera_per_pokemon_left: -12.5, attack_boost: 30, defense_boost: 15,
  special_attack_boost: 30, special_defense_boost: 15, speed_boost: 30, frozen: -40, asleep_per_turn: -12.5, paralyzed: -25,
  toxic: -30, poisoned: -10, poison_heal: 15, poison_boosted: 10, burned: -25, burn_boosted: 50, leech_seed: -30,
  substitute: 30, confusion: -20, reflect: 20, light_screen: 20, aurora_veil: 40, safeguard: 5, tailwind: 7, healing_wish: 30,
  stealth_rock: -10, spikes: -7, toxic_spikes: -7, sticky_web: -25,
  // New terms start at nothing, so the pull toward the current weights holds them at zero unless the data moves them.
  speed_advantage: 0, matchup: 0 };
const NAMES = Object.keys(DEFAULTS);

const rows = [];
if (args.ladder) {
  const { toEngineState, sampleWorld } = await import('../dist/src/search/engineState.js');
  let seen = 0;
  for (const f of readdirSync('logs').filter(f => f.startsWith('battle-') && f.endsWith('.jsonl'))) {
    let lines; try { lines = readFileSync(`logs/${f}`, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { continue; }
    const end = lines.find(r => r.event === 'win'); if (!end) continue;
    const won = end.state.winner === end.state.sides[end.state.mySide].name;
    for (const r of lines.filter(r => r.event === 'decision' && r.state.requestKind === 'move')) {
      let features;
      try {
        const state = toEngineState(r.state, r.state.mySide, sampleWorld(r.state, r.state.mySide)).state;
        features = Object.fromEntries(execFileSync(args.bin, ['features', '--state', state], { timeout: 5000 }).toString().trim().split('\n')
          .map(l => l.split(' ')).filter(([k]) => k !== 'evaluation').map(([k, v]) => [k, Number(v)]));
      } catch { continue; }
      rows.push({ game: `ladder:${f}`, x: NAMES.map(n => features[n] ?? 0), y: won ? 1 : 0 });
      if (++seen % 1000 === 0) console.error(`ladder positions: ${seen}`);
    }
  }
}
for (const name of args.bench.split(',').filter(Boolean)) {
  const path = `logs/bench/${name}.positions.jsonl`;
  if (!existsSync(path)) { console.error(`no positions at ${path}`); continue; }
  for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
    const p = JSON.parse(line);
    rows.push({ game: `bench:${name}:${p.seed}:${p.bAs}`, x: NAMES.map(n => p.f[n] ?? 0), y: p.won ? 1 : 0 });
  }
}
const games = [...new Set(rows.map(r => r.game))];
console.log(`${rows.length} positions from ${games.length} games (${rows.filter(r => r.y).length} from the winning side)`);
if (games.length < 20) throw new Error('too few games to fit anything');

const sigmoid = z => 1 / (1 + Math.exp(-z));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const w0 = NAMES.map(n => DEFAULTS[n]);
const logloss = (data, beta) => -data.reduce((s, r) => { const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(dot(r.x, beta)))); return s + (r.y ? Math.log(p) : Math.log(1 - p)); }, 0) / data.length;

/** One scale on the current weights: the best the current evaluation can do at predicting wins. */
function fitScale(data) {
  let k = 0.0125;
  for (let it = 0; it < 50; it++) {
    let g = 0, h = 0;
    for (const r of data) { const e = dot(r.x, w0), p = sigmoid(k * e); g += (r.y - p) * e; h += p * (1 - p) * e * e; }
    if (h <= 0) break;
    k += g / h;
  }
  return k;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

/**
 * Logistic regression pulled toward the scaled current weights: maximise the log-likelihood minus
 * lambda * n * sum(var_i * (beta_i - prior_i)^2), by Newton's method. Scaling the pull by each term's variance makes it
 * even across terms measured in different units, and a term that never varies keeps its prior exactly.
 */
function fit(data, prior, variance, lambda) {
  const n = NAMES.length, N = data.length;
  let beta = [...prior];
  for (let it = 0; it < 30; it++) {
    const g = new Array(n).fill(0), H = Array.from({ length: n }, () => new Array(n).fill(0));
    for (const r of data) {
      const p = sigmoid(dot(r.x, beta)), d = r.y - p, w = p * (1 - p);
      for (let i = 0; i < n; i++) { if (!r.x[i]) continue; g[i] += d * r.x[i]; for (let j = 0; j < n; j++) if (r.x[j]) H[i][j] += w * r.x[i] * r.x[j]; }
    }
    for (let i = 0; i < n; i++) { const pull = 2 * lambda * N * Math.max(variance[i], 1e-6); g[i] -= pull * (beta[i] - prior[i]); H[i][i] += pull; }
    const step = solve(H, g);
    beta = beta.map((b, i) => b + step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return beta;
}

const variance = NAMES.map((_, i) => { const m = rows.reduce((s, r) => s + r.x[i], 0) / rows.length; return rows.reduce((s, r) => s + (r.x[i] - m) ** 2, 0) / rows.length; });
// Game-level folds, fixed by a hash of the game id so reruns agree.
const hash = s => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const folds = Number(args.folds), foldOf = new Map(games.map(g => [g, hash(g) % folds]));
const lambdas = [0.001, 0.01, 0.1, 1];
const score = { current: 0 }; for (const l of lambdas) score[l] = 0;
for (let k = 0; k < folds; k++) {
  const train = rows.filter(r => foldOf.get(r.game) !== k), test = rows.filter(r => foldOf.get(r.game) === k);
  const scale = fitScale(train), prior = w0.map(w => w * scale);
  score.current += logloss(test, prior) * test.length;
  for (const l of lambdas) score[l] += logloss(test, fit(train, prior, variance, l)) * test.length;
}
for (const key of Object.keys(score)) score[key] /= rows.length;
console.log(`held-out log-loss (lower is better; 0.693 is a coin flip): current weights, rescaled ${score.current.toFixed(4)}; ` +
  lambdas.map(l => `fitted, pull ${l}: ${score[l].toFixed(4)}`).join('; '));
const bestLambda = lambdas.reduce((b, l) => (score[l] < score[b] ? l : b), lambdas[0]);
if (score[bestLambda] >= score.current) console.log('no fitted weights beat the current ones on held-out games; writing them anyway for inspection');

const scale = fitScale(rows), beta = fit(rows, w0.map(w => w * scale), variance, bestLambda);
// Back on the current weights' own scale: only the proportions change, so the search's rewards stay as sharp.
const fitted = beta.map(b => b / scale);
console.log(`scale on current weights ${scale.toFixed(5)} (the search uses 0.0125); pull ${bestLambda}`);
console.log('term                          current    fitted   seen in');
NAMES.forEach((n, i) => console.log(`${n.padEnd(28)} ${String(DEFAULTS[n]).padStart(8)} ${fitted[i].toFixed(1).padStart(9)}   ${rows.filter(r => r.x[i]).length}`));
mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `# fitted ${new Date().toISOString()} on ${rows.length} positions from ${games.length} games; ` +
  `held-out log-loss ${score[bestLambda].toFixed(4)} against ${score.current.toFixed(4)} for the current weights\n` +
  NAMES.map((n, i) => `${n} ${fitted[i].toFixed(3)}`).join('\n') + '\n');
console.log(`wrote ${args.out}`);
