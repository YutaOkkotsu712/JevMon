import { asleepWhileTheyBoost, doomedReplacement, futileSubstitute, statusIntoKnockout, destinyBondTrade, repeatedSelfEffect, certainlyFails, endeavorTooEarly, pickedOffOnArrival, pivotIntoKnockout, sleeperThrownAway, setupIntoSleep, baitedCrash, chargeWontFire, seededAndLosing, freeKnockoutPassedUp, healAtFullHP, setupIntoPhazer, setupRaceLost, futileUnawareSetup, dominatedMoves, healingOverAKnockout, outhealed, recoilIntoRecovery, statusThatHelpsThem, encoredIntoNothing, futileProtect, lethalPriority, lockedAndLosing, lockedIntoImmunity, needlessGamble, preserveSoleDefensiveAnswer, redundantTera } from '../strategy/dominance.js';
import { generateLegalActions, parseChoiceRequest, validateAction, type ChoiceRequest, type BattleAction } from './LegalActionGenerator.js';
import type { BattleState } from './BattleState.js';
import { cyclicSwitch } from '../strategy/loopGuard.js';
import { fasterPivot } from '../strategy/pivot.js';
import type { DecisionProvider, DecisionResult, ProviderMetrics, SearchValue } from '../decisions/DecisionProvider.js';
import { RandomDecisionProvider } from '../decisions/RandomDecisionProvider.js';

export interface DecisionRecord {
  rqid: number;
  legalActions: BattleAction[];
  selectedAction: BattleAction;
  executedAction: string | null;
  dryRun: boolean;
  fallback: boolean;
  latencyMs: number;
  providerResult?: DecisionResult;
  providerMetrics?: ProviderMetrics;
  /** Set when a provably self-defeating switch was skipped in favour of the provider's next preference. */
  skippedDominatedMove?: { from: string; to: string; reason: string };
  skippedCyclicSwitch?: { from: string; to: string; reason: string };
  /** The engine's lookahead for this decision, when search is on, and the ranking actually used in blend mode. */
  search?: { mode: SearchMode; inPayload?: boolean; values: Record<string, SearchValue>; worldsSearched: number; msTotal: number; solver?: 'endgame'; extended?: true };
  blended?: Record<string, number>;
  decidedBy?: 'provider' | 'blend' | 'search';
  /** Set when the search's pick was within the override margin of another action the provider preferred. */
  nearTie?: { searchBest: string; chosen: string };
  /** Set when the blend's Tera was played without Tera because the search ranked the plain move at least as high. */
  teraHeldBack?: { from: string; to: string };
  /** Set when a voluntary switch was played as the faster damaging pivot instead. */
  pivotInsteadOfSwitch?: { from: string; to: string; reason: string };
  /** Set when the provider was not asked: one legal action, or a search sure enough that the blend follows it anyway. */
  providerSkipped?: 'single-action' | 'search-decisive';
}
export type SearchMode = 'advise' | 'blend';
export type SearchResult = { values: Record<string, SearchValue>; worldsSearched: number; msTotal: number; solver?: 'endgame'; extended?: true } | null;
export interface DecisionLoopOptions {
  room: string;
  username: string;
  dryRun: boolean;
  send: (command: string) => boolean;
  state: () => BattleState;
  onStatus: (status: string) => void;
  onDecision: (record: DecisionRecord) => void;
  provider?: DecisionProvider;
  timeoutMs?: number;
  /** False runs no strategy guards, for measuring what they are worth on the self-play bench. */
  guards?: boolean;
  /**
   * Lookahead by poke-engine. `advise` puts its verdict in the provider's payload; `blend` also averages its visit
   * shares with the provider's probabilities and plays the top of that, the way Jaxcalibur lets its network's prior
   * steer its search. When the provider fails, the search's own ranking replaces the random fallback.
   */
  search?: { mode: SearchMode; run: (state: BattleState, actions: BattleAction[]) => Promise<SearchResult>; timeoutMs: number; weight?: number;
    /**
     * How much better, in the search's own mean score, its choice must be before it overrules the provider's. Visit
     * shares turn small value differences into lopsided votes: across eight ladder battles search overruled Jev on 22% of
     * decisions, half of them by less than 0.03, three times trading a certain knockout for a heal or a boost.
     */
    overrideMargin?: number;
    /** Whether the provider sees the search's values; in blend, leaving them out keeps the two opinions independent. */
    inPayload?: boolean;
    /**
     * In blend, the visit share at which the provider is not asked at all: with that much of the search on one action the
     * blend follows it whatever the provider says, and each call costs credit. 0 asks every time.
     */
    skipProviderAtShare?: number };
}
/** Every runtime guard, in the order applied; shared with scripts/preflight.mjs so the check runs exactly what plays. */
export const GUARDS = [lethalPriority, futileProtect, encoredIntoNothing, lockedIntoImmunity, lockedAndLosing, redundantTera, needlessGamble, preserveSoleDefensiveAnswer, baitedCrash, statusThatHelpsThem, healingOverAKnockout, outhealed, recoilIntoRecovery, futileUnawareSetup, asleepWhileTheyBoost, setupIntoPhazer, setupRaceLost, freeKnockoutPassedUp, healAtFullHP, chargeWontFire, seededAndLosing, setupIntoSleep, sleeperThrownAway, doomedReplacement, futileSubstitute, statusIntoKnockout, destinyBondTrade, repeatedSelfEffect, certainlyFails, endeavorTooEarly, pickedOffOnArrival, pivotIntoKnockout];
/**
 * Blend: average the provider's probabilities with the search's visit shares and play the top of that. Without a
 * provider ranking — a failed call — the search's ranking alone stands in for the random fallback. No pick means the
 * search had nothing to say and the provider's choice and ranking stand. Shared with scripts/preflight.mjs.
 */
/** Visits at least this many times another action's mean the search has settled between them, whatever the scores. */
export const DECISIVE_VISITS = 2;
export function blendChoice(actions: BattleAction[], prior: Record<string, number> | undefined, theirs: string | undefined,
  values: Record<string, SearchValue>, weight: number, margin: number) {
  const share = (id: string) => values[id]?.visitShare ?? 0;
  const blended = Object.fromEntries(actions.map(a => [a.id, prior ? (prior[a.id] ?? 0) * (1 - weight) + share(a.id) * weight : share(a.id)]));
  // A large search-value gap should not disappear because the provider spread its votes
  // over similar moves while putting one high prior on a much worse action. Keep the
  // provider's say among actions the search rates within 0.10 of its best. On the
  // Hariyama lead, this retains both Sticky Web variants and rejects a Sylveon switch
  // that search valued 0.17 lower, despite a 0.006 lead in the raw blend.
  const scored = actions.filter(a => values[a.id]?.meanScore != null && share(a.id) >= 0.01);
  const topScore = scored.length ? Math.max(...scored.map(a => values[a.id]!.meanScore!)) : null;
  const viable = topScore === null ? actions : actions.filter(a =>
    values[a.id]?.meanScore == null || values[a.id]!.meanScore! >= topScore - 0.10);
  const best = viable.reduce((x, a) => (blended[a.id]! > blended[x.id]! ? a : x));
  if (!(blended[best.id]! > 0)) return { blended };
  const score = (id: string) => values[id]?.meanScore;
  // A near tie by the search's own reckoning is not a reason to overrule the provider; the blend still ranks the
  // rest, so a guard that skips the provider's choice falls back on it. A tie needs both: scores within the margin and
  // visits not lopsided. Scores inside 0.03 were taken for noise, but rerun three times the search kept preferring its
  // own pick over Jev's in 108 of 120 runs, and in 71 of 75 once it gave it twice the visits (Coil over Earthquake led
  // by 0.025, 0.025 and 0.024). Deferring there handed every close call to Jev's own leanings: 103 setup moves the
  // search chose were dropped this way, and Teras the search did not want were played.
  const tied = (a: string, b: string) => score(a) != null && score(b) != null && score(a)! - score(b)! < margin &&
    share(a) < DECISIVE_VISITS * share(b);
  // Tera is spent once, and only the search prices that: the engine charges its use against every Pokémon we have
  // left. Jev is told only to spend it for a concrete gain. So a Tera is played only when the search gives it more visits
  // than the same move without it; otherwise the move goes without. Of 197 logged Teras, 39 were ones the search had
  // ranked below the plain move (Rhyperior's turn-2 Earthquake + Tera Ground at 0.144 against 0.316), 24 of them with
  // five or six of ours still standing.
  const holdTera = <T extends { chosen: string }>(pick: T): T & { teraHeldBack?: { from: string; to: string } } => {
    const plain = pick.chosen.endsWith('-terastallize') ? pick.chosen.slice(0, -'-terastallize'.length) : null;
    if (!plain || !actions.some(a => a.id === plain) || values[plain]?.meanScore == null || !values[pick.chosen]) return pick;
    return share(plain) >= share(pick.chosen) ? { ...pick, chosen: plain, teraHeldBack: { from: pick.chosen, to: plain } } : pick;
  };
  if (prior && theirs && best.id !== theirs && tied(best.id, theirs)) {
    return { blended, pick: holdTera({ chosen: theirs, decidedBy: 'provider' as const, nearTie: undefined }) };
  }
  const decidedBy = prior ? 'blend' as const : 'search' as const;
  // The same holds below the provider's top: once the search has clearly beaten that, whatever it rates within the
  // margin of its own best is a near tie, settled by the provider's ranking rather than by visit share. Meloetta faced
  // a +2 Thundurus; the search rejected Jev's switch to Salamence fairly, then put Stonjourner in at 0.228 over Hyper
  // Voice at 0.209, and the blend took the sacrifice by 0.002 though Jev gave it 0.02 to Hyper Voice's 0.36.
  // Stonjourner fainted to the Thunderbolt. Two runs of the same search disagree on their top pick about one position
  // in ten, so an order inside the margin is mostly noise.
  if (prior && theirs && best.id !== theirs && score(best.id) != null) {
    // When most of the provider's weight is on the same kind of action as the search's best, a near tie cannot flip
    // it. Glalie faced a +2 Rotom-Frost: Jev wanted to switch (0.53 across switches, Stantler first) and the search
    // wanted Victreebel in, yet the rule took Jev's 0.37 on Freeze-Dry, a resisted hit, and Glalie was paralysed.
    const kindMass = (kind: string) => actions.filter(a => a.kind === kind).reduce((n, a) => n + (prior[a.id] ?? 0), 0);
    const settled = kindMass(best.kind) >= 0.5 ? best.kind : null;
    const near = viable.filter(a => (a.id === best.id || tied(best.id, a.id)) && (!settled || a.kind === settled));
    const pick = near.reduce((x, a) => ((prior[a.id] ?? 0) > (prior[x.id] ?? 0) ? a : x), best);
    if (pick.id !== best.id) return { blended, pick: holdTera({ chosen: pick.id, decidedBy, nearTie: { searchBest: best.id, chosen: pick.id } }) };
  }
  return { blended, pick: holdTera({ chosen: best.id, decidedBy, nearTie: undefined as DecisionRecord['nearTie'] }) };
}
const userId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
export class DecisionLoop {
  private revision = 0;
  private current: ChoiceRequest | null = null;
  private signature = '';
  private highestRqid = -1;
  private rejected = new Set<string>();
  private sent: BattleAction | undefined;
  private retryCount = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelPending: (() => void) | undefined;
  private stopped = false;
  private providerAbort: AbortController | undefined;
  private readonly provider: DecisionProvider;
  constructor(private readonly options: DecisionLoopOptions) { this.provider = options.provider ?? new RandomDecisionProvider(); }

  invalidate(): void {
    this.revision++;
    this.providerAbort?.abort();
    this.cancelPending?.(); this.cancelPending = undefined;
    clearTimeout(this.pendingTimer);
  }
  disconnect(): void { this.invalidate(); this.current = null; this.signature = ''; this.sent = undefined; }
  stop(): void { this.stopped = true; this.disconnect(); }
  sentChoice(): void {
    // Reconnect history reports an already-submitted choice after its request.
    this.invalidate();
    this.options.onStatus('server reports an existing choice; waiting');
  }
  request(raw: string): void {
    if (this.stopped) return;
    let request: ChoiceRequest | null;
    try { request = parseChoiceRequest(raw); }
    catch { this.disconnect(); this.options.onStatus('invalid request; no action sent'); return; }
    if (!request) { this.disconnect(); return; }
    if (userId(request.side.name) !== userId(this.options.username)) {
      this.disconnect(); this.options.onStatus('request identity mismatch; no action sent'); return;
    }
    if (request.rqid < this.highestRqid) return;
    const signature = JSON.stringify(request);
    if (signature === this.signature) return;
    this.invalidate();
    if (request.rqid > this.highestRqid) { this.rejected.clear(); this.retryCount = 0; }
    this.highestRqid = request.rqid;
    this.signature = signature; this.current = request; this.sent = undefined;
    this.schedule();
  }
  error(message: string): void {
    if (this.stopped || !this.current || !this.sent || !/^\[(Invalid|Unavailable) choice\]/.test(message)) return;
    this.invalidate();
    this.rejected.add(this.sent.id); this.sent = undefined;
    this.retryCount++;
    this.options.onStatus('server rejected choice');
    this.signature = ''; // A revised request may reuse the same rqid.
    if (this.retryCount >= 3) { this.options.onStatus('choice retry limit reached; waiting for next request ID'); return; }
    if (message.startsWith('[Unavailable choice]')) return; // Server supplies new facts in the following request.
    this.schedule();
  }
  private schedule(): void {
    if (!this.current || this.retryCount >= 3) return;
    const version = this.revision;
    // Defer past all messages in the frame (including sentchoice/end/revised request).
    void Promise.resolve().then(() => this.decide(version)).catch(() => {
      this.options.onStatus('decision processing failed; no further action sent');
    });
  }
  private async decide(version: number): Promise<void> {
    if (version !== this.revision || !this.current || this.stopped) return;
    const request = this.current;
    const actions = generateLegalActions(request).filter(a => !this.rejected.has(a.id));
    if (!actions.length) { this.options.onStatus('no request-supported actions; waiting'); return; }
    const start = performance.now();
    // Lookahead first and bounded, so its verdict can reach the provider; a slow or failed search is simply absent.
    let search: SearchResult = null;
    if (this.options.search) {
      const { run, timeoutMs } = this.options.search;
      search = await Promise.race([run(structuredClone(this.options.state()), structuredClone(actions)).catch(() => null),
        new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs))]);
      if (version !== this.revision || this.stopped) return;
    }
    let chosen: unknown, fallback = false;
    let providerResult: DecisionResult | undefined;
    // Each provider call spends credit. Two turns are settled without one: a single legal action, and a search so sure
    // of one action that the blend follows it whatever the provider says. Across 7,555 logged blend decisions, those
    // with 70% of the visits on one action played it 96% of the time, the rest through a guard's fallback.
    const topShare = search ? Math.max(0, ...Object.values(search.values).map(v => v.visitShare ?? 0)) : 0;
    const skipAt = this.options.search?.skipProviderAtShare ?? 0;
    const providerSkipped = actions.length === 1 ? 'single-action' as const
      : this.options.search?.mode === 'blend' && search && skipAt > 0 && topShare >= skipAt ? 'search-decisive' as const : undefined;
    if (providerSkipped === 'single-action') chosen = actions[0]!.id;
    const controller = new AbortController();
    this.providerAbort = controller;
    if (!providerSkipped) try {
      const result = await Promise.race([
        this.provider.chooseAction({ state: structuredClone(this.options.state()), legalActions: structuredClone(actions), request: structuredClone(request),
          ...(search && this.options.search?.inPayload !== false ? { search: search.values } : {}) }, { signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          this.cancelPending = () => reject(new Error('Cancelled'));
          this.pendingTimer = setTimeout(() => { controller.abort(); reject(new Error('Decision timed out')); }, this.options.timeoutMs ?? 2000);
        }),
      ]);
      chosen = result?.chosenAction;
      providerResult = result;
      fallback = !!result?.fallbackReason;
    } catch { fallback = true; }
    if (version !== this.revision || this.stopped) return;
    clearTimeout(this.pendingTimer); this.cancelPending = undefined;
    let ranking = providerResult?.probabilities;
    let blended: Record<string, number> | undefined;
    let decidedBy: DecisionRecord['decidedBy'] = 'provider';
    let nearTie: DecisionRecord['nearTie'];
    let teraHeldBack: DecisionRecord['teraHeldBack'];
    if (this.options.search?.mode === 'blend' && search) {
      const blend = blendChoice(actions, ranking && !fallback ? ranking : undefined, typeof chosen === 'string' ? chosen : undefined,
        search.values, this.options.search.weight ?? 0.5, this.options.search.overrideMargin ?? 0);
      blended = blend.blended;
      if (blend.pick) { ({ chosen, decidedBy, nearTie, teraHeldBack } = blend.pick); ranking = blended; }
      // A guard's fallback must not hand the held-back Tera straight back.
      if (teraHeldBack && ranking) ranking = { ...ranking, [teraHeldBack.from]: 0 };
    }
    let action = validateAction(request, chosen);
    let pivoted: DecisionRecord['pivotInsteadOfSwitch'];
    // The provider ranks every action, so a cycle can be skipped without discarding its judgement:
    // take its next preference instead. Never applies without a ranking, and never invents an action.
    let skipped: DecisionRecord['skippedCyclicSwitch'];
    let skippedMove: DecisionRecord['skippedDominatedMove'];
    if (action && ranking) {
      const state = this.options.state();
      // A guard that throws loses its own opinion, never the turn: an exception here used to end the whole decision
      // with no choice sent, which the battle timer turns into a loss.
      const dominance = new Map<string, { by: string; reason: string; prefer?: string }>();
      for (const guard of this.options.guards === false ? [] : [dominatedMoves, ...GUARDS]) {
        let found: Map<string, { by: string; reason: string; prefer?: string }>;
        try { found = guard({ state, legalActions: actions, request }); }
        catch { this.options.onStatus(`strategy guard ${guard.name} failed; ignoring it for this decision`); continue; }
        for (const [id, entry] of found) if (!dominance.has(id)) dominance.set(id, entry);
      }
      const reasons = new Map<string, string>();
      const targetOf = (candidate: BattleAction) => {
        if (candidate.kind !== 'switch' || !state.mySide) return undefined;
        const slot = Number(candidate.command.split(' ')[1]);
        return state.sides[state.mySide].team.find(p => p.slot === slot);
      };
      const others = actions.map(targetOf).filter((p): p is NonNullable<typeof p> => !!p);
      const cyclic = (candidate: BattleAction) => {
        const target = targetOf(candidate);
        const dominated = dominance.get(candidate.id);
        if (dominated) { reasons.set(candidate.id, dominated.reason); return true; }
        if (!target || !state.mySide || request.forceSwitch?.[0] || candidate.uncertain) return false;
        // Entry death is a strategic cost, not proof that a deliberate sacrifice is dominated.
        let reason: string | null | undefined;
        try { reason = cyclicSwitch(state, state.mySide, target); } catch { reason = null; }
        if (reason) reasons.set(candidate.id, reason);
        return !!reason;
      };
      if (cyclic(action)) {
        // A guard that skips a Tera objects to the Tera, so the same move without it comes first. Ranked by the blend
        // instead, the fallback was whatever Jev's leftover votes favoured: Flamigo's skipped Tera Close Combat became
        // U-turn three turns running, each one feeding a teammate to a Chilling Neigh Glastrier (2687217753).
        // A guard that names what beats the skipped move comes next: a certain knockout skipped for a Roost fell back to
        // the blend's next choice, a switch to Pachirisu, where the guard's own reason was the Knock Off (2686662572).
        const twin = action.id.endsWith('-terastallize') ? actions.find(a => a.id === action!.id.slice(0, -'-terastallize'.length)) : undefined;
        // Several guards name the move their reason rests on in `by` (the faster knockout, the move that dominates,
        // Rest): Double-Edge skipped for a Fake Out that also knocked out fell back to a switch (2686875558). A switch
        // named there is left to the ranking, since the search often rated another move above it.
        const entry = dominance.get(action.id);
        const prefer = entry?.prefer ?? (actions.some(a => a.id === entry?.by && a.kind === 'move') ? entry!.by : undefined);
        const first = (a: BattleAction) => (a.id === twin?.id ? 2 : a.id === prefer ? 1 : 0);
        const ranked = actions.filter(a => a.id !== action!.id && !cyclic(a))
          .sort((a, b) => first(b) - first(a) || (ranking![b.id] ?? 0) - (ranking![a.id] ?? 0));
        if (ranked[0]) {
          const record = { from: action.id, to: ranked[0].id, reason: reasons.get(action.id)! };
          if (dominance.has(action.id)) skippedMove = record; else skipped = record;
          this.options.onStatus('strategy guard skipped an inferior choice; using the provider\'s next preference');
          action = ranked[0];
        }
      }
      // A voluntary switch becomes the faster pivot when one is on offer and no guard objects: the same switch, plus
      // its damage, with the replacement chosen after seeing whether they switched.
      if (action.kind === 'switch') {
        let pivot: ReturnType<typeof fasterPivot> = null;
        try { pivot = fasterPivot({ state, legalActions: actions, request }); } catch { pivot = null; }
        if (pivot && !dominance.has(pivot.action.id) && !this.rejected.has(pivot.action.id)) {
          pivoted = { from: action.id, to: pivot.action.id, reason: pivot.reason }; action = pivot.action;
        }
      }
    }
    if (!action || this.rejected.has(action.id)) {
      fallback = true;
      action = actions[0]!;
      providerResult = undefined;
      this.options.onStatus('provider failed or selected invalid action; using legal fallback');
    }
    // Re-generate against the latest authoritative request immediately before send.
    if (this.current !== request || !validateAction(this.current, action.id)) return;
    const command = `${this.options.room}|/choose ${action.command}|${request.rqid}`;
    const sent = !this.options.dryRun && this.options.send(command);
    if (sent) this.sent = action;
    else if (!this.options.dryRun) this.options.onStatus('choice send failed; waiting for reconnect or fresh request');
    this.options.onDecision({ rqid: request.rqid, legalActions: actions, selectedAction: action,
      executedAction: sent ? action.command : null, dryRun: this.options.dryRun, fallback,
      latencyMs: Math.round(performance.now() - start),
      ...(providerResult ? { providerResult } : {}),
      ...(skipped ? { skippedCyclicSwitch: skipped } : {}),
      ...(skippedMove ? { skippedDominatedMove: skippedMove } : {}),
      ...(search && this.options.search ? { search: { mode: this.options.search.mode, inPayload: this.options.search.inPayload !== false, ...search } } : {}),
      ...(blended ? { blended, decidedBy } : {}),
      ...(nearTie ? { nearTie } : {}),
      ...(teraHeldBack ? { teraHeldBack } : {}),
      ...(pivoted ? { pivotInsteadOfSwitch: pivoted } : {}),
      ...(providerSkipped ? { providerSkipped } : {}),
      ...(this.provider.getMetrics ? { providerMetrics: this.provider.getMetrics() } : {}) });
  }
}
