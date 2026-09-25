// Summarise a ladder run from the battle logs: result, ratings, knockouts, and what overrode Jev along the way.
//   node scripts/ladder-report.mjs            every battle logged with `source: ladder`
//   node scripts/ladder-report.mjs --all      challenge battles too
//   node scripts/ladder-report.mjs --last 10  only the ten most recent, for one run
// Battles listed in logs/ladder-skip (one battle number per line, # for comments) are left out, and named as left out.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

const all = process.argv.includes('--all');
const lastAt = process.argv.indexOf('--last'), last = lastAt > 0 ? Number(process.argv[lastAt + 1]) : 0;
const skip = new Set(existsSync('logs/ladder-skip') ? readFileSync('logs/ladder-skip', 'utf8').split('\n')
  .map(l => l.replace(/#.*/, '').trim()).filter(Boolean) : []);
const skipped = [];
const files = readdirSync('logs').filter(f => f.endsWith('.jsonl'))
  .map(f => `logs/${f}`).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
const rows = [];
for (const file of files) {
  const recs = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const source = recs.find(r => r.event === 'status' && /^source: /.test(r.message ?? ''))?.message.slice(8) ?? 'challenge';
  if (!all && !source.startsWith('ladder')) continue;
  if (skip.has(file.split('-')[2])) { skipped.push(file.split('-')[2]); continue; }
  const last = recs.filter(r => r.state).at(-1)?.state;
  if (!last?.mySide) continue;
  const me = last.mySide, them = me === 'p1' ? 'p2' : 'p1';
  const decisions = recs.filter(r => r.event === 'decision').map(r => r.decision);
  const provider = recs.filter(r => r.event === 'provider').at(-1)?.metrics;
  const fainted = side => last.sides[side].team.filter(p => p.fainted).length;
  const result = !last.ended && !last.winner ? 'unfinished' : last.winner === last.sides[me].name ? 'W' : last.winner ? 'L' : 'T';
  const guards = decisions.filter(d => d.skippedDominatedMove || d.skippedCyclicSwitch);
  rows.push({
    battle: file.split('-')[2], source, result, turns: last.turn,
    opponent: last.sides[them].name, theirRating: last.sides[them].rating, ourRating: last.sides[me].rating,
    kos: `${fainted(them)}-${fainted(me)}`,
    guardSkips: guards.length,
    searchOverrides: decisions.filter(d => d.decidedBy === 'blend' && d.providerResult?.chosenAction && d.selectedAction.id !== d.providerResult.chosenAction).length,
    fallbacks: decisions.filter(d => d.fallback).length,
    slowestDecisionS: decisions.length ? Math.round(Math.max(...decisions.map(d => d.latencyMs ?? 0)) / 100) / 10 : 0,
    jevCalls: provider?.successfulCalls ?? 0, jevFailed: provider?.failedCalls ?? 0,
    reasons: guards.map(d => (d.skippedDominatedMove ?? d.skippedCyclicSwitch).reason.slice(0, 110)),
  });
}
if (last > 0) rows.splice(0, Math.max(0, rows.length - last));
if (!rows.length) { console.log(all ? 'No battle logs found.' : 'No ladder battles logged yet (they carry a `source: ladder` status line).'); process.exit(0); }
console.table(rows.map(({ reasons, ...r }) => r));
const done = rows.filter(r => r.result !== 'unfinished');
const wins = done.filter(r => r.result === 'W').length;
const rated = rows.filter(r => r.ourRating !== null);
console.log(`\n${wins}-${done.length - wins} over ${done.length} finished battles (${done.length ? Math.round(wins / done.length * 100) : 0}% won)` +
  (rated.length ? `; our rating at the start of each: ${rated.map(r => r.ourRating).join(' → ')}` : ''));
const dealt = done.reduce((n, r) => n + Number(r.kos.split('-')[0]), 0), taken = done.reduce((n, r) => n + Number(r.kos.split('-')[1]), 0);
if (done.length) console.log(`knockouts per battle: ${(dealt / done.length).toFixed(2)} dealt, ${(taken / done.length).toFixed(2)} taken`);
const fallbacks = rows.reduce((n, r) => n + r.fallbacks, 0), failed = rows.reduce((n, r) => n + r.jevFailed, 0);
if (fallbacks || failed) console.log(`provider trouble: ${failed} failed Jev calls, ${fallbacks} fallback decisions`);
if (skipped.length) console.log(`left out, as listed in logs/ladder-skip: ${[...new Set(skipped)].join(', ')}`);
for (const r of rows.filter(r => r.reasons.length)) console.log(`\n${r.battle} guard skips:\n  ${r.reasons.join('\n  ')}`);
