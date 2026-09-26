// Before restarting the bot on new code: rebuild the recent logged decisions with the current build and report what
// the change does to them. An edit five minutes before a restart once put 1.4 KB of instructions on every payload and
// pushed one decision in five to the minimal tier, which nothing checked. Run with the live budget from .env:
//   npm run preflight            last 30 games
//   npm run preflight -- 60      last 60 games
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { buildJevPayload, PAYLOAD_BUDGET_BYTES } from '../dist/src/decisions/JevDecisionProvider.js';
import { INSTRUCTIONS, INSTRUCTIONS_VERSION, CONDITIONAL_INSTRUCTIONS } from '../dist/src/decisions/instructions.js';
import { GUARDS, blendChoice } from '../dist/src/battle/DecisionLoop.js';
import { dominatedMoves } from '../dist/src/strategy/dominance.js';
import { buildPokemon } from '../dist/src/strategy/calcCore.js';
import { readConfig } from '../dist/src/config/env.js';

// Payloads are rebuilt the way the current configuration would send them, search values included or not.
const config = (() => { try { return readConfig(process.env); } catch { return null; } })();
const searchShown = config ? config.search.mode !== 'off' && config.search.inPayload : true;

const games = Number(process.argv[2] ?? 30);
const files = readdirSync('logs').filter(f => f.startsWith('battle-') && f.endsWith('.jsonl')).map(f => `logs/${f}`)
  .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).slice(-games);

/** Requests are not logged, so they are rebuilt from the state they produced, as scripts/inspect-battle.mjs does. */
function inputOf(record) {
  const s = record.state, mine = s.sides[s.mySide], me = mine.team.find(p => p.id === mine.activeId);
  const teraUsed = mine.team.some(p => p.terastallized);
  const condition = p => (p.fainted ? '0 fnt' : `${p.exactHP?.current ?? p.hpPercent}/${p.exactHP?.max ?? 100}${p.status ? ` ${p.status}` : ''}`);
  const request = { rqid: record.decision.rqid, side: { id: s.mySide, name: mine.name,
    pokemon: mine.team.map(p => ({ ident: p.ident, details: p.details, condition: condition(p), active: p.id === mine.activeId })) },
    ...(s.requestKind === 'move'
      ? { active: [{ moves: (me?.knownMoves ?? []).map(m => ({ move: m, id: m })), ...(me?.teraType && !teraUsed ? { canTerastallize: me.teraType } : {}) }] }
      : { forceSwitch: [true] }) };
  return { state: s, legalActions: record.decision.legalActions, request, ...(record.decision.search && searchShown ? { search: record.decision.search.values } : {}) };
}

const tiers = { now: {}, live: {} }, bytes = [], errors = [], unavailable = new Map(), unmodelled = new Map();
const guardSkips = new Map(); let decisions = 0, recordedSkips = 0, overBudget = 0, overTokens = 0, blends = 0, blendChanges = 0, nearTies = 0;
for (const f of files) {
  let rows; try { rows = readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { continue; }
  for (const record of rows.filter(r => r.event === 'decision')) {
    decisions++;
    const live = record.decision.providerResult?.payloadDetail;
    if (live) tiers.live[live] = (tiers.live[live] ?? 0) + 1;
    if (record.decision.skippedDominatedMove) recordedSkips++;
    // The blend as it would now run, against the choice it made then (before any guard).
    const d = record.decision, prior = d.providerResult?.probabilities, theirs = d.providerResult?.chosenAction;
    if (config?.search.mode === 'blend' && d.search?.values && prior && !d.fallback) {
      blends++;
      const pick = blendChoice(d.legalActions, prior, theirs, d.search.values, config.search.weight, config.search.overrideMargin).pick;
      const then = d.skippedDominatedMove?.from ?? d.skippedCyclicSwitch?.from ?? d.selectedAction.id;
      if (pick && pick.chosen !== then) blendChanges++;
      if (pick?.nearTie) nearTies++;
    }
    const input = inputOf(record);
    let payload;
    try { payload = buildJevPayload(input); } catch (e) { errors.push(`${f.slice(29, 39)} t${record.state.turn}: ${e.message}`); continue; }
    if (!payload) { overTokens++; continue; }
    tiers.now[payload.detail] = (tiers.now[payload.detail] ?? 0) + 1;
    bytes.push(payload.bytes);
    if (payload.overBudget) overBudget++;
    const why = payload.state.estimatesUnavailable;
    if (why && why !== 'no active Pokémon on both sides') unavailable.set(why, (unavailable.get(why) ?? 0) + 1);
    const s = record.state, mine = s.sides[s.mySide], me = mine.team.find(p => p.id === mine.activeId);
    if (s.requestKind !== 'move' || !me || me.fainted) continue;
    try { buildPokemon(me); } catch { unmodelled.set(me.species, (unmodelled.get(me.species) ?? 0) + 1); }
    // Which guard, if any, would now skip the action that was actually played.
    const chosen = record.decision.selectedAction.id;
    for (const guard of [dominatedMoves, ...GUARDS]) {
      let hit; try { hit = guard(input).get(chosen); } catch { continue; }
      if (hit) { guardSkips.set(guard.name, (guardSkips.get(guard.name) ?? 0) + 1); break; }
    }
  }
}

const share = (t, k) => { const n = Object.values(t).reduce((a, b) => a + b, 0); return n ? Math.round((t[k] ?? 0) / n * 100) : 0; };
bytes.sort((a, b) => a - b);
const pick = q => bytes[Math.min(bytes.length - 1, Math.floor(bytes.length * q))];
const warnings = [];
console.log(`preflight over the last ${files.length} games, ${decisions} decisions, budget ${PAYLOAD_BUDGET_BYTES} bytes`);
console.log(`search values ${searchShown ? 'shown to' : 'kept from'} Jev`);
console.log(`instructions ${INSTRUCTIONS_VERSION}: ${Buffer.byteLength(INSTRUCTIONS)} bytes always sent, ${Object.keys(CONDITIONAL_INSTRUCTIONS).length} conditional paragraphs`);
console.log(`payload tiers now ${JSON.stringify(tiers.now)} (${share(tiers.now, 'minimal')}% minimal); as played ${JSON.stringify(tiers.live)} (${share(tiers.live, 'minimal')}% minimal)`);
console.log(`payload bytes median ${pick(0.5)}, p95 ${pick(0.95)}, max ${bytes.at(-1)}; over budget ${overBudget}; over the token limit ${overTokens}`);
if (share(tiers.now, 'minimal') > share(tiers.live, 'minimal') + 5) warnings.push('more decisions fall to the minimal tier than were played that way');
if (overTokens) warnings.push('some payloads exceed the model token limit');
if (errors.length) { warnings.push(`${errors.length} decisions fail to build`); for (const e of errors.slice(0, 5)) console.log(`  error ${e}`); }
if (unmodelled.size) { warnings.push('our own active Pokémon cannot be modelled in some decisions'); console.log(`our active unmodelled: ${JSON.stringify(Object.fromEntries(unmodelled))}`); }
if (unavailable.size) console.log(`estimates unavailable: ${JSON.stringify(Object.fromEntries(unavailable))}`);
if (blends) console.log(`blend now picks differently in ${blendChanges} of ${blends} decisions; ${nearTies} near ties go to Jev's ranking`);
console.log(`guards now skipping the action that was played: ${JSON.stringify(Object.fromEntries(guardSkips))} (${[...guardSkips.values()].reduce((a, b) => a + b, 0)} decisions; ${recordedSkips} were skipped live)`);
console.log(warnings.length ? `\nWARNINGS:\n${warnings.map(w => `  - ${w}`).join('\n')}` : '\nno warnings');
process.exitCode = warnings.length ? 1 : 0;
