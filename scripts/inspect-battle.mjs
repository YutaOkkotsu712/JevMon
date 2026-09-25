// Read a battle log back through the current feature layer: what was deduced, what was chosen, and whether
// the payload could discriminate at all. Rebuilding the features from the logged state is exact, because the
// feature layer is deterministic — so this also shows how a past battle would look under current code.
//   node scripts/inspect-battle.mjs logs/<file>.jsonl            summary
//   node scripts/inspect-battle.mjs logs/<file>.jsonl turn 11    the full payload for one turn
import { readFileSync } from 'node:fs';
import { extractFeatures } from '../dist/src/strategy/features.js';

const [path, mode, wanted] = process.argv.slice(2);
if (!path) throw new Error('Usage: node scripts/inspect-battle.mjs <log.jsonl> [turn <n>]');
const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));

/** Requests are not logged (they carry private team data), but the state they produced is. */
function rebuild(record) {
  const s = record.state, mine = s.sides[s.mySide];
  const me = mine.team.find(p => p.id === mine.activeId);
  const condition = p => (p.fainted ? '0 fnt'
    : `${p.exactHP?.current ?? p.hpPercent}/${p.exactHP?.max ?? 100}${p.status ? ` ${p.status}` : ''}`);
  const request = { rqid: record.decision.rqid,
    side: { id: s.mySide, name: mine.name,
      pokemon: mine.team.map(p => ({ ident: p.ident, details: p.details, condition: condition(p), active: p.id === mine.activeId })) },
    ...(s.requestKind === 'move'
      ? { active: [{ moves: (me?.knownMoves ?? []).map(m => ({ move: m, id: m })),
          ...(me?.teraType && !me.terastallized ? { canTerastallize: me.teraType } : {}) }] }
      : { forceSwitch: [true] }) };
  return extractFeatures({ state: s, legalActions: record.decision.legalActions, request });
}
const decisions = rows.filter(r => r.event === 'decision');

if (mode === 'turn') {
  const record = decisions.find(r => r.state.turn === Number(wanted));
  if (!record) throw new Error(`No decision recorded on turn ${wanted}`);
  console.log(JSON.stringify(rebuild(record), null, 1));
  process.exit(0);
}

console.log('=== deductions recorded during the battle ===');
const seen = new Set();
for (const r of rows) {
  if (!r.state) continue;
  for (const p of r.state.sides[r.state.mySide === 'p1' ? 'p2' : 'p1'].team) {
    for (const o of p.inference?.observations ?? []) {
      const key = `${p.species}|${o.kind}|${o.turn}|${o.before}|${o.after}|${o.contradiction ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  t${o.turn} ${p.species} ${o.kind}: ${o.before} -> ${o.after} sampled sets` +
        (o.contradiction ? '  [CONTRADICTION: model disagreed with the observation; nothing eliminated]' : ''));
    }
  }
}
if (!seen.size) console.log('  (none)');
const final = rows.filter(r => r.state).at(-1);
if (final) {
  const foes = final.state.sides[final.state.mySide === 'p1' ? 'p2' : 'p1'].team;
  console.log('  sets ruled out by the end:', JSON.stringify(Object.fromEntries(
    foes.map(p => [p.species, p.inference?.excluded.length ?? 0]))));
}

console.log('\n=== decisions ===');
let peak = 0;
const voluntary = [];
for (const r of decisions) {
  const f = rebuild(r);
  const bytes = Buffer.byteLength(JSON.stringify(f));
  peak = Math.max(peak, bytes);
  const probabilities = Object.entries(r.decision.providerResult?.probabilities ?? {});
  const top = probabilities.length ? Math.max(...probabilities.map(([, v]) => v)) : null;
  const chosen = r.decision.selectedAction;
  if (r.state.requestKind === 'move') voluntary.push({ kind: chosen.kind, confidence: r.decision.providerResult?.confidence ?? null });
  const orders = f.actions.filter(a => a.turnOrder && a.turnOrder.order !== 'uncertain').length;
  const blocked = f.actions.filter(a => a.targetSubstitute?.effect === 'absorbed-entirely').length;
  console.log(
    `t${String(r.state.turn).padStart(2)} ${r.state.requestKind.padEnd(6)} n=${String(r.decision.legalActions.length).padEnd(2)}` +
    ` ${`${chosen.kind}: ${chosen.label}`.slice(0, 34).padEnd(34)}` +
    ` conf=${String(r.decision.providerResult?.confidence ?? '-').padEnd(4)} top=${String(top ?? '-').slice(0, 4).padEnd(4)}` +
    ` unif=${probabilities.length ? (1 / probabilities.length).toFixed(2) : '-'}` +
    ` | speed=${(f.speedRelation?.relation ?? 'replacing').replace('-than-all-samples', '').padEnd(12)} orders=${orders}` +
    ` incoming=${f.incomingThreatIfWeStayIn?.worstCasePercentOfMaxHP ?? '-'}%/${f.incomingThreatIfWeStayIn?.conditionalKO ?? '-'}` +
    ` matchups=${f.actions.filter(a => a.switchIn?.ourBestDamageFromNextTurn).length}` +
    (blocked ? ` subBlocked=${blocked}` : '') +
    ` ${bytes}B${r.decision.fallback ? ' FALLBACK' : ''}${r.decision.executedAction ? '' : ' NOT-SENT'}` +
    (f.estimatesUnavailable ? `  [${f.estimatesUnavailable}]` : ''));
}
const switches = voluntary.filter(v => v.kind === 'switch').length;
const confidences = voluntary.map(v => v.confidence).filter(v => v !== null).sort((a, b) => a - b);
console.log(`\nvoluntary choices: ${voluntary.length}, of which switches: ${switches}`);
if (confidences.length) {
  console.log(`model confidence: min ${confidences[0]} median ${confidences[confidences.length >> 1]} max ${confidences.at(-1)}`);
}
console.log(`peak payload: ${peak}B of the 24000B budget`);
