// Offline replay of retained states through CURRENT features/instructions. No HTTP or paid model calls.
// Requests were not retained: recover move slots from logged legal labels, PP from private tracked state.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildJevPayload } from '../dist/src/decisions/JevDecisionProvider.js';
import { extractFeatures } from '../dist/src/strategy/features.js';
import { dominatedMoves } from '../dist/src/strategy/dominance.js';
import { INSTRUCTIONS_VERSION } from '../dist/src/decisions/instructions.js';
const ids = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const result = { instructionsVersion: INSTRUCTIONS_VERSION, decisions: 0, probabilityRecords: 0, reduced: 0, minimal: 0,
  overBudget: 0, largestPayloadBytes: 0, historicalChosenNowDominated: [], strongerImmediateDamageAlternatives: 0,
  chosenExecutionRisk: 0, substituteDecisions: 0, substituteWithDamage: 0, optionalPPUnknown: 0, invalidHistoricalDistributions: 0, guardsChangedHistoricalChoice: 0 };
const lifts = [];
for (const file of readdirSync('logs').filter(f => f.endsWith('.jsonl'))) {
  for (const r of readFileSync('logs/' + file, 'utf8').trim().split('\n').map(JSON.parse)) {
    if (r.event !== 'decision' || !r.state.mySide) continue;
    const s = r.state, mine = s.sides[s.mySide], me = mine.team.find(p => p.id === mine.activeId);
    const moves = (me?.knownMoves ?? []).map(m => ({ id: ids(m), move: m, ...(me.movePP?.[ids(m)] ? { pp: me.movePP[ids(m)].remaining, maxpp: me.movePP[ids(m)].max } : {}) }));
    for (const a of r.decision.legalActions.filter(a => a.kind === 'move')) {
      const name = a.label.split(' + Tera')[0], key = ids(name), slot = Number(a.command.split(' ')[1]) - 1;
      moves[slot] = { id: key, move: name, ...(me?.movePP?.[key] ? { pp: me.movePP[key].remaining, maxpp: me.movePP[key].max } : {}) };
    }
    const request = { rqid: r.decision.rqid, side: { id: s.mySide, name: mine.name, pokemon: mine.team.map(p => ({ ident: p.ident, details: p.details,
      condition: p.fainted ? '0 fnt' : `${p.exactHP?.current ?? p.hpPercent}/${p.exactHP?.max ?? 100}`, active: p.id === mine.activeId })) },
      ...(s.requestKind === 'move' ? { active: [{ moves, ...(me?.teraType && !me.terastallized ? { canTerastallize: me.teraType } : {}) }] } : { forceSwitch: [true] }) };
    const input = { state: s, legalActions: r.decision.legalActions, request };
    const payload = buildJevPayload(input);
    result.decisions++;
    if (!payload) { result.overBudget++; continue; }
    result[payload.detail]++; result.largestPayloadBytes = Math.max(result.largestPayloadBytes, payload.bytes);
    const chosen = payload.state.actions.find(a => a.id === r.decision.selectedAction.id);
    if (chosen?.strongerImmediateDamageAvailable) result.strongerImmediateDamageAlternatives++;
    if (chosen?.executionRisk) result.chosenExecutionRisk++;
    if (payload.state.actions.some(a => a.targetSubstitute)) {
      result.substituteDecisions++;
      if (payload.state.actions.some(a => a.damageRange)) result.substituteWithDamage++;
    }
    if (moves.some(m => m.pp === undefined)) result.optionalPPUnknown++;
    const dominated = dominatedMoves(input).get(r.decision.selectedAction.id);
    if (dominated) result.historicalChosenNowDominated.push({ battle: /^battle-gen9randombattle-(\d+)/.exec(s.battleId)?.[1], turn: s.turn, chosen: r.decision.selectedAction.label, ...dominated });
    const probabilities = Object.values(r.decision.providerResult?.probabilities ?? {});
    if (probabilities.length) {
      result.probabilityRecords++;
      const sum = probabilities.reduce((n, v) => n + v, 0);
      if (Math.abs(sum - 1) > 0.01) result.invalidHistoricalDistributions++;
      else lifts.push(Math.max(...probabilities) * probabilities.length);
    }
    if (r.decision.providerResult?.chosenAction && r.decision.providerResult.chosenAction !== r.decision.selectedAction.id) result.guardsChangedHistoricalChoice++;
  }
}
lifts.sort((a, b) => a - b);
const output = { ...result, historicalMedianTopProbabilityVsUniform: lifts.length ? lifts[Math.floor(lifts.length / 2)] : null,
  historicalMinTopProbabilityVsUniform: lifts[0] ?? null,
  caveat: 'Historical choices/distributions are unchanged. Payload/guard replay uses current code and set data with reconstructed requests, not a rerun of Jev. This does not measure prompt quality, win rate, or actual original payload size.' };
writeFileSync('docs/DECISION-AUDIT.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));
