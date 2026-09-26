// What the bot saw, weighed and chose on a few turns of one logged battle, followed by what happened: the position
// (both actives, the benches, the field), every legal option with the search's share and score, Jev's probability and
// the blend, what any guard or tactical correction changed, and the battle lines of that turn. Offline and exact: it
// only reads logs/battle-*.jsonl, so the output can be pasted for a second look without sharing the whole log.
//   node scripts/explain-turns.mjs 2688221733 22 28     turns 22 to 28
//   node scripts/explain-turns.mjs 2688221733 13        one turn
//   node scripts/explain-turns.mjs logs/<file>.jsonl 13 a log file by path
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const [which, fromArg, toArg] = process.argv.slice(2);
if (!which) throw new Error('Usage: node scripts/explain-turns.mjs <battle number | log path> [first turn] [last turn]');
let path = which;
if (!existsSync(path)) {
  const found = readdirSync('logs').filter(f => f.startsWith('battle-') && f.endsWith('.jsonl') && f.includes(which));
  if (!found.length) throw new Error(`No log in logs/ for battle ${which}`);
  path = `logs/${found[0]}`;
}
const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
const from = fromArg ? Number(fromArg) : 1, to = toArg ? Number(toArg) : fromArg ? from : Infinity;

const pct = n => (n == null ? '?' : `${Math.round(n * 10) / 10}%`);
const share = n => (n == null ? '   -  ' : `${(n * 100).toFixed(1).padStart(5)}%`);
const score = n => (n == null ? '   -  ' : n.toFixed(3).padStart(6));
function hp(p) {
  if (p.fainted) return 'fainted';
  const value = p.exactHP ? `${pct(p.exactHP.current / p.exactHP.max * 100)} (${p.exactHP.current}/${p.exactHP.max})` : pct(p.hpPercent);
  return value + (p.status ? ` ${p.status}` : '');
}
function describe(p, full) {
  const boosts = Object.entries(p.boosts ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`);
  const volatiles = Object.keys(p.volatiles ?? {});
  const parts = [`${p.species} ${hp(p)}`];
  if (boosts.length) parts.push(`[${boosts.join(', ')}]`);
  if (p.terastallized) parts.push(`Tera ${p.teraType}`);
  else if (full && p.teraType) parts.push(`Tera ${p.teraType} unused`);
  if (full) {
    if (p.item !== undefined) parts.push(`item ${p.item ?? 'none/unknown'}`);
    if (p.ability) parts.push(`ability ${p.ability}`);
    const moves = p.knownMoves?.length ? p.knownMoves : p.revealedMoves;
    if (moves?.length) parts.push(`moves ${moves.join(', ')}`);
    if (volatiles.length) parts.push(`volatiles ${volatiles.join(', ')}`);
    if (p.substitute) parts.push('behind a Substitute');
  }
  return parts.join('  ');
}
function side(s, id, label) {
  const team = s.sides[id], active = team.team.find(p => p.id === team.activeId);
  const lines = [`  ${label} ${active ? describe(active, true) : '(no active)'}`];
  const bench = team.team.filter(p => p !== active).map(p => `${p.species} ${hp(p)}`);
  const unseen = (team.teamSize ?? 6) - team.team.length;
  if (bench.length || unseen > 0) lines.push(`       bench: ${bench.join(', ')}${unseen > 0 ? `${bench.length ? ', ' : ''}${unseen} unseen` : ''}`);
  const field = [...Object.entries(team.hazards ?? {}).filter(([, v]) => v).map(([k, v]) => (v > 1 ? `${k} x${v}` : k)),
    ...Object.entries(team.conditions ?? {}).map(([k, v]) => `${k} since t${v.sinceTurn}`)];
  if (field.length) lines.push(`       their field: ${field.join(', ')}`.replace('their', label === 'us:  ' ? 'our' : 'their'));
  return lines;
}

// Battle lines by the turn they resolve: everything after `|turn|N` up to `|turn|N+1` follows the choices made on turn N.
const linesByTurn = new Map();
let lineTurn = 0;
for (const r of rows) {
  if (r.event !== 'line') continue;
  const m = /^\|turn\|(\d+)/.exec(r.line);
  if (m) { lineTurn = Number(m[1]); continue; }
  if (!linesByTurn.has(lineTurn)) linesByTurn.set(lineTurn, []);
  linesByTurn.get(lineTurn).push(r.line);
}
const mySide = rows.find(r => r.state?.mySide)?.state.mySide;
const boring = /^\|\|?$|^\|(t:|upkeep|j|l|c|raw|html|inactive|inactiveoff|n|chat|debug|split|timestamp)\||^\|-weather\|[^|]*\|\[upkeep\]$/;
function readable(line) {
  const parts = line.split('|').slice(1);
  const who = s => s.replace(/^p([12])[a-z]?: /, (_, n) => (`p${n}` === mySide ? 'us:' : 'them:'));
  return `${parts[0].padEnd(15)} ${parts.slice(1).filter(Boolean).map(who).join('  ')}`;
}

let printedLines = new Set();
const decisions = rows.filter(r => r.event === 'decision' && r.state.turn >= from && r.state.turn <= to);
if (!decisions.length) console.log(`No decisions logged between turns ${from} and ${to}.`);
for (const [i, r] of decisions.entries()) {
  const s = r.state, d = r.decision, foe = s.mySide === 'p1' ? 'p2' : 'p1';
  console.log(`\n=== turn ${s.turn}, ${s.requestKind === 'switch' ? 'replacement' : 'move'} request (rqid ${d.rqid}) ===`);
  for (const line of [...side(s, s.mySide, 'us:  '), ...side(s, foe, 'them:')]) console.log(line);
  const f = s.field ?? {};
  const field = [f.weather, f.terrain, f.trickRoom ? 'Trick Room' : null].filter(Boolean);
  if (field.length) console.log(`  field: ${field.join(', ')}`);

  const values = d.search?.values ?? {}, probabilities = d.providerResult?.probabilities ?? {}, blended = d.blended ?? {};
  const searchTop = Object.entries(values).sort((x, y) => (y[1].visitShare ?? 0) - (x[1].visitShare ?? 0))[0]?.[0];
  const corrections = d.tacticalRanking?.corrections ?? {};
  console.log(`  ${'option'.padEnd(34)} search  score   Jev    blend   (* search's top, > played)`);
  for (const a of d.legalActions) {
    const v = values[a.id];
    const mark = `${a.id === d.selectedAction.id ? '>' : ' '}${a.id === searchTop ? '*' : ' '}`;
    const note = corrections[a.id] ? `  tactical ${corrections[a.id].logAdjustment.toFixed(2)}: ${corrections[a.id].reasons.join('; ')}` : '';
    console.log(`${mark} ${a.label.slice(0, 34).padEnd(34)}${share(v?.visitShare)} ${score(v?.meanScore)} ${share(probabilities[a.id])} ${share(blended[a.id])}${note}`);
  }
  const how = [`played ${d.selectedAction.label}`, d.decidedBy ? `decided by ${d.decidedBy}` : null,
    d.providerSkipped ? `Jev not asked (${d.providerSkipped})` : null, d.fallback ? 'Jev failed, fallback' : null,
    d.search ? `${d.search.worldsSearched} worlds${d.search.solver ? `, ${d.search.solver} solver` : ''}${d.search.extended ? ', extended' : ''}` : null,
    `${(d.latencyMs / 1000).toFixed(1)}s`].filter(Boolean);
  console.log(`  ${how.join('; ')}`);
  const label = id => d.legalActions.find(a => a.id === id)?.label ?? id;
  if (d.skippedDominatedMove) console.log(`  guard ${d.skippedDominatedMove.guard ?? ''} skipped ${label(d.skippedDominatedMove.from)} for ${label(d.skippedDominatedMove.to)}: ${d.skippedDominatedMove.reason}`);
  if (d.skippedCyclicSwitch) console.log(`  cycle check skipped ${label(d.skippedCyclicSwitch.from)} for ${label(d.skippedCyclicSwitch.to)}: ${d.skippedCyclicSwitch.reason}`);
  if (d.pivotInsteadOfSwitch) console.log(`  pivot: ${label(d.pivotInsteadOfSwitch.from)} played as ${label(d.pivotInsteadOfSwitch.to)}: ${d.pivotInsteadOfSwitch.reason}`);
  if (d.teraHeldBack) console.log(`  Tera held back: ${label(d.teraHeldBack.from)} played as ${label(d.teraHeldBack.to)}`);
  if (d.nearTie) console.log(`  near tie: search's best ${label(d.nearTie.searchBest)}, played ${label(d.nearTie.chosen)}`);
  for (const a of d.tacticalRanking?.advice ?? []) if (!corrections[a.action]?.reasons.some(r => r.includes(a.reason))) console.log(`  advice (${a.guard}) on ${label(a.action)}: ${a.reason}`);
  if (d.tacticalRanking && d.tacticalRanking.from !== d.tacticalRanking.to) console.log(`  tactical ranking moved ${label(d.tacticalRanking.from)} to ${label(d.tacticalRanking.to)}`);
  if (!d.executedAction) console.log('  NOT SENT');

  // The turn's battle lines follow its last decision, the replacement included.
  const next = decisions[i + 1];
  if ((!next || next.state.turn !== s.turn) && !printedLines.has(s.turn)) {
    printedLines.add(s.turn);
    const lines = (linesByTurn.get(s.turn) ?? []).filter(l => !boring.test(l));
    console.log(`  --- what happened on turn ${s.turn} ---`);
    for (const l of lines) console.log(`  ${readable(l)}`);
  }
}
