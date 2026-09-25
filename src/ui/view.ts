import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import type { DecisionRecord } from '../battle/DecisionLoop.js';
import { extractFeatures } from '../strategy/features.js';
import { statusRisk } from '../strategy/risk.js';
import { pokemonTypes } from '../pokemon/mechanics.js';

const member = (p: PokemonState, active: boolean) => ({
  species: p.species, hp: p.fainted ? 0 : Math.round((p.hpPercent ?? 0) * 10) / 10,
  fainted: p.fainted, status: p.status, active, types: pokemonTypes(p),
  ...(p.terastallized && p.teraType ? { teraType: p.teraType } : {}),
  ...(p.item ? { item: p.item } : {}), ...(p.ability ? { ability: p.ability } : {}),
});
const side = (s: BattleState, id: SideId) => {
  const v = s.sides[id];
  return { name: v.name, hazards: v.hazards, conditions: Object.keys(v.conditions),
    team: v.team.map(p => member(p, p.id === v.activeId)) };
};

/**
 * Requests carry private team data and are never logged, so the one that produced this decision is rebuilt
 * from the state it produced — the same reconstruction `scripts/inspect-battle.mjs` uses.
 */
function features(record: DecisionRecord, s: BattleState) {
  const mine = s.mySide && s.sides[s.mySide];
  if (!mine) return null;
  const me = mine.team.find(p => p.id === mine.activeId);
  const condition = (p: PokemonState) => (p.fainted ? '0 fnt'
    : `${p.exactHP?.current ?? p.hpPercent}/${p.exactHP?.max ?? 100}${p.status ? ` ${p.status}` : ''}`);
  const request = { rqid: record.rqid,
    side: { id: s.mySide!, name: mine.name,
      pokemon: mine.team.map(p => ({ ident: p.ident, details: p.details, condition: condition(p), active: p.id === mine.activeId })) },
    ...(s.requestKind === 'move'
      ? { active: [{ moves: (me?.knownMoves ?? []).map(m => ({ move: m, id: m })),
          ...(me?.teraType && !me.terastallized ? { canTerastallize: me.teraType } : {}) }] }
      : { forceSwitch: [true as const] }) };
  try { return extractFeatures({ state: s, legalActions: record.legalActions, request } as never); }
  catch { return null; }
}

/**
 * One decision, flattened into what a person needs to see it: what was chosen, how confidently, what the
 * alternatives scored, and — the part worth watching — what the numbers said, so a choice that disagrees
 * with its own evidence is visible rather than buried in a log.
 */
export function decisionView(record: DecisionRecord, s: BattleState, room: string) {
  const f = features(record, s) as null | { actions?: Record<string, unknown>[] };
  const byId = new Map<string, Record<string, unknown>>((f?.actions ?? []).map(a => [String(a.id), a]));
  const probabilities = record.providerResult?.probabilities ?? {};
  const guard = record.skippedDominatedMove
    ? { kind: 'move' as const, ...record.skippedDominatedMove }
    : record.skippedCyclicSwitch ? { kind: 'switch' as const, ...record.skippedCyclicSwitch } : null;
  const ranked = record.legalActions.map(a => {
    const detail = byId.get(a.id);
    const damage = detail?.damageRange as { percentOfMaxHP?: [number, number]; conditionalKO?: string;
      substituteDamage?: { hpBefore: [number, number]; damageHP: [number, number]; breaks: string } } | undefined;
    const order = (detail?.turnOrder as { order?: string } | undefined)?.order;
    const wasted = detail?.wouldAccomplishNothing as { certain?: string[] } | undefined;
    const searched = record.search?.values?.[a.id];
    return { id: a.id, kind: a.kind, label: a.label,
      probability: probabilities[a.id] ?? null,
      // The search's view beside Jev's, and what the two came to: the choice is made on the blend, not on either alone.
      search: searched ? { share: searched.visitShare, score: searched.meanScore } : null,
      blended: record.blended?.[a.id] ?? null,
      chosen: a.id === record.selectedAction.id,
      skippedByGuard: guard?.from === a.id ? guard.reason : null,
      ...(damage?.percentOfMaxHP ? { damagePercent: damage.percentOfMaxHP } : {}),
      ...(damage?.conditionalKO && damage.conditionalKO !== 'none-sampled' ? { ko: damage.conditionalKO } : {}),
      // Damage against a Substitute reads as zero against the holder, which on its own is badly misleading.
      ...(damage?.substituteDamage ? { substitute: { damageHP: damage.substituteDamage.damageHP,
        shellHP: damage.substituteDamage.hpBefore, breaks: damage.substituteDamage.breaks } } : {}),
      ...(order ? { order } : {}),
      ...(wasted?.certain?.length ? { pointless: wasted.certain[0] } : {}),
      ...(detail?.switchIn ? { switchIn: detail.switchIn as unknown } : {}),
    };
  }).sort((a, b) => (b.blended ?? b.probability ?? -1) - (a.blended ?? a.probability ?? -1));
  const jevPick = record.providerResult?.chosenAction ?? null;
  const searchPick = record.search ? Object.entries(record.search.values).sort((x, y) => y[1].visitShare - x[1].visitShare)[0]?.[0] ?? null : null;
  const labelOf = (actionId: string | null | undefined) => record.legalActions.find(a => a.id === actionId)?.label ?? null;
  // Who settled it, in the order the loop applies them: the blend (or Jev alone when there is no search), a near tie
  // handed to Jev, a Tera the search did not want, a guard, and a switch played as a pivot.
  const how = {
    decidedBy: record.decidedBy ?? (record.search ? 'search' : 'provider'),
    jevPick: labelOf(jevPick), searchPick: labelOf(searchPick),
    agreed: !!jevPick && jevPick === searchPick,
    ...(record.providerSkipped ? { jevSkipped: record.providerSkipped } : {}),
    ...(record.nearTie ? { nearTie: { searchBest: labelOf(record.nearTie.searchBest), chosen: labelOf(record.nearTie.chosen) } } : {}),
    ...(record.teraHeldBack ? { teraHeldBack: { from: labelOf(record.teraHeldBack.from), to: labelOf(record.teraHeldBack.to) } } : {}),
    ...(record.pivotInsteadOfSwitch ? { pivot: { from: labelOf(record.pivotInsteadOfSwitch.from), to: labelOf(record.pivotInsteadOfSwitch.to) } } : {}),
    ...(record.search ? { search: { worlds: record.search.worldsSearched, ms: record.search.msTotal,
      ...(record.search.solver ? { solver: record.search.solver } : {}), ...(record.search.extended ? { extended: true } : {}) } } : {}),
  };
  const mine = s.mySide ? s.sides[s.mySide] : undefined;
  const theirs = s.mySide ? s.sides[s.mySide === 'p1' ? 'p2' : 'p1'] : undefined;
  const me = mine?.team.find(p => p.id === mine.activeId);
  const foe = theirs?.team.find(p => p.id === theirs.activeId);
  const r = record.providerResult;
  return {
    room, turn: s.turn, rqid: record.rqid, requestKind: s.requestKind, time: new Date().toISOString(),
    choice: { id: record.selectedAction.id, label: record.selectedAction.label, kind: record.selectedAction.kind,
      executed: record.executedAction, dryRun: record.dryRun, fallback: record.fallback,
      latencyMs: record.latencyMs, provider: r?.provider ?? null, confidence: r?.confidence ?? null,
      fallbackReason: r?.fallbackReason ?? null,
      payloadDetail: r?.payloadDetail ?? null, payloadBytes: r?.payloadBytes ?? null,
      instructionsVersion: r?.instructionsVersion ?? null,
      inputTokens: r?.usage?.inputTokens ?? null, outputTokens: r?.usage?.outputTokens ?? null },
    guard, ranked, how,
    us: s.mySide ? side(s, s.mySide) : null,
    them: s.mySide ? side(s, s.mySide === 'p1' ? 'p2' : 'p1') : null,
    field: s.field,
    risk: { ours: me ? statusRisk(me) : null, theirs: foe ? statusRisk(foe) : null },
    incomingThreat: (f as { incomingThreatIfWeStayIn?: unknown } | null)?.incomingThreatIfWeStayIn ?? null,
    featuresUnavailable: !f,
  };
}
export type DecisionView = ReturnType<typeof decisionView>;
