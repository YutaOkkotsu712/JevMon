import { isRecord } from '../showdown/parser.js';
import { extractFeatures, type Detail } from '../strategy/features.js';
import { RandomDecisionProvider } from './RandomDecisionProvider.js';
import type { DecisionInput, DecisionProvider, DecisionResult, ProviderMetrics } from './DecisionProvider.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
import { INSTRUCTIONS_VERSION, instructionsFor } from './instructions.js';
interface Options {
  apiKey: string;
  model?: string;
  maxCalls: number;
  timeoutMs?: number;
  request?: typeof fetch;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  onEvent?: (event: { status: string; metrics: ProviderMetrics }) => void;
}
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const tokens = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** Bounded, single-line and control-character free, so a malformed reply cannot distort the log. */
const excerpt = (value: unknown) => JSON.stringify(value)?.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) ?? 'undefined';
/**
 * Validates the documented Choice response. Every rejection names the field that failed: a generic error
 * makes a bad reply undiagnosable, and the response body is not retained anywhere else.
 */
export function validateJevResponse(value: unknown, allowed: string[]): DecisionResult {
  if (!isRecord(value)) throw new Error(`response is not an object: ${excerpt(value)}`);
  if (typeof value.model !== 'string' || !value.model) throw new Error(`model missing or not a string: ${excerpt(value.model)}`);
  if (!isRecord(value.answers) || !isRecord(value.answers.battle_action)) throw new Error('answers.battle_action missing or not an object');
  if (!isRecord(value.usage)) throw new Error('usage missing or not an object');
  const a = value.answers.battle_action;
  if (a.type !== 'choice') throw new Error(`answer type is not "choice": ${excerpt(a.type)}`);
  if (typeof a.choice !== 'string') throw new Error(`choice is not a string: ${excerpt(a.choice)}`);
  if (!allowed.includes(a.choice)) throw new Error(`choice is not an offered action: ${excerpt(a.choice)}`);
  if (!probability(a.confidence)) throw new Error(`confidence is not a probability: ${excerpt(a.confidence)}`);
  if (!isRecord(a.probabilities)) throw new Error('probabilities missing or not an object');
  const given = a.probabilities as Record<string, unknown>;
  const missing = allowed.filter(key => !Object.hasOwn(given, key));
  if (missing.length) throw new Error(`probabilities omit offered actions: ${excerpt(missing)}`);
  const extra = Object.keys(given).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`probabilities include unoffered actions: ${excerpt(extra)}`);
  const bad = allowed.filter(key => !probability(given[key]));
  if (bad.length) throw new Error(`probabilities are not all in range: ${excerpt(bad.map(k => [k, given[k]]))}`);
  if (!tokens(value.usage.input_tokens)) throw new Error(`usage.input_tokens invalid: ${excerpt(value.usage.input_tokens)}`);
  if (!tokens(value.usage.output_tokens)) throw new Error(`usage.output_tokens invalid: ${excerpt(value.usage.output_tokens)}`);
  // A reply a rounding step away from consistent is still the model's decision, and rejecting it hands the turn
  // to a random move: a 0.99 sum and a 0.23 choice against a 0.24 did exactly that. So a distribution within
  // rounding of one is rescaled, a near-tie choice is kept, and each repair is recorded. Real departures still fail.
  const raw = given as Record<string, number>;
  const sum = Object.values(raw).reduce((n, p) => n + p, 0);
  if (Math.abs(sum - 1) > 0.05) throw new Error(`probabilities sum to ${Math.round(sum * 1000) / 1000}, not 1`);
  const probabilities = Math.abs(sum - 1) > 1e-9 ? Object.fromEntries(Object.entries(raw).map(([k, p]) => [k, p / sum])) : { ...raw };
  const best = Math.max(...Object.values(probabilities));
  if (probabilities[a.choice]! + 0.05 < best) {
    throw new Error(`chosen action is not maximal: ${excerpt(a.choice)} at ${probabilities[a.choice]} against ${best}`);
  }
  const repairs = [...(Math.abs(sum - 1) > 1e-9 ? [`probabilities summed to ${Math.round(sum * 1000) / 1000} and were rescaled`] : []),
    ...(probabilities[a.choice]! + 1e-6 < best ? [`the choice was a near tie with the most probable action (${Math.round(probabilities[a.choice]! * 1000) / 1000} against ${Math.round(best * 1000) / 1000})`] : [])];
  return { chosenAction: a.choice, provider: 'jev', confidence: a.confidence, probabilities,
    ...(repairs.length ? { responseRepaired: repairs.join('; ') } : {}),
    usage: { inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens } };
}

/** Shared with offline audits: production starts reduced, minimal is an emergency fallback only. */
/**
 * TypeSafe's documented ceiling for jev-1.13.0 is 64,000 tokens for state plus all questions, or 32,000 for
 * state plus the longest single question. This bot asks one question per decision, so 32,000 is the limit.
 */
export const JEV_TOKEN_LIMIT = 32_000;
/**
 * Bytes per token measured over 223 logged calls that recorded both: median 2.47, minimum 2.18. The minimum
 * is used deliberately, so the estimate overstates tokens and errs toward refusing rather than exceeding.
 * A later 2,434 calls never went below 2.51, and their largest request was 16,837 tokens from 42,963 bytes.
 */
const DENSEST_BYTES_PER_TOKEN = 2.18;
export const estimatedTokens = (body: string) => Math.ceil(Buffer.byteLength(body) / DENSEST_BYTES_PER_TOKEN);
/**
 * The most a request may hold and still fit the token limit at the densest ratio seen: 69,760 bytes. Nothing larger
 * is sent, whatever JEV_PAYLOAD_BUDGET_BYTES says. A flat 30,000-byte cap was tried here (one token per byte) and
 * would have pushed 2,168 of the last 2,434 live requests, 89%, down to the minimal tier, all of them under
 * 17,000 tokens.
 */
export const JEV_MAX_REQUEST_BYTES = Math.floor(JEV_TOKEN_LIMIT * DENSEST_BYTES_PER_TOKEN);

/**
 * A relevance threshold, not a capacity limit. Measured usage sits around 8,700 tokens against a 32,000-token
 * ceiling, so nothing here is near running out of room; the reason to keep a decision small is that TypeSafe
 * reports irrelevant detail reducing accuracy. Raising it buys space we have and did not need. Exceeding it
 * is recorded and never a reason to stop asking; `JEV_PAYLOAD_BUDGET_BYTES` overrides it.
 */
export const DEFAULT_PAYLOAD_BUDGET_BYTES = 28_000;
export const PAYLOAD_BUDGET_BYTES = (() => {
  const raw = process.env.JEV_PAYLOAD_BUDGET_BYTES?.trim();
  if (!raw) return DEFAULT_PAYLOAD_BUDGET_BYTES;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 4_000 && value <= 500_000 ? value : DEFAULT_PAYLOAD_BUDGET_BYTES;
})();

export function buildJevPayload(input: DecisionInput, model = 'jev-latest') {
  let smallest: { body: string; detail: 'reduced' | 'minimal'; state: unknown; bytes: number } | undefined;
  for (const detail of ['reduced', 'minimal'] as const satisfies readonly Detail[]) {
    const state = extractFeatures(input, detail);
    const body = JSON.stringify({ model, state, questions: { battle_action: {
      type: 'choice', instructions: instructionsFor(state, !!input.search),
      criteria: Object.fromEntries(input.legalActions.map(a => [a.id, a.label])),
    } } });
    const bytes = Buffer.byteLength(body);
    if (bytes <= Math.min(PAYLOAD_BUDGET_BYTES, JEV_MAX_REQUEST_BYTES)) return { body, detail, state, bytes, overBudget: false };
    smallest = { body, detail, state, bytes };
  }
  // The budget is ours, not the API's, and the alternative to an oversized payload is a random move: on the
  // opening turn every set is still unknown, which is exactly when the payload is largest and the decision
  // matters most. Send the smallest tier and mark it, rather than discarding the decision entirely. The one
  // thing that is not ours to exceed is the model's own ceiling, so that is checked separately.
  if (!smallest) return null;
  if (smallest.bytes > JEV_MAX_REQUEST_BYTES) {
    // Keep every legal option and its numeric outcomes. Explanatory glossary prose is redundant
    // with the instructions and is the first thing removed at the hard ceiling.
    const compact = { ...(smallest.state as Record<string, unknown>) };
    delete compact.glossary;
    const body = JSON.stringify({ model, state: compact, questions: { battle_action: {
      type: 'choice', instructions: COMPACT_INSTRUCTIONS,
      criteria: Object.fromEntries(input.legalActions.map(a => [a.id, a.label])),
    } } });
    smallest = { ...smallest, state: compact, body, bytes: Buffer.byteLength(body) };
  }
  if (smallest.bytes > JEV_MAX_REQUEST_BYTES) return null;
  return { ...smallest, overBudget: smallest.bytes > PAYLOAD_BUDGET_BYTES };
}

/** Emergency compression removes explanatory prose, not actions or their computed outcomes. */
const COMPACT_INSTRUCTIONS = 'Choose only a listed legal action ID to maximise the chance of winning this Gen 9 singles battle; return a probability distribution with the selected choice maximal. ' +
  'All damage, race and search figures are conditional estimates, not promises of what the opponent will do. Compare accuracy, turn order, incoming damage, survival effects, opposing switches/Tera and remaining HP before valuing a knockout, setup or recovery. ' +
  'An attack that cannot execute has no damage value. A first-moving knockout can prevent the reply; excess damage beyond a knockout has no value. Check recoil, contact effects, priority and abilities. Damage into a Substitute is not necessarily damage to its holder. ' +
  'An ordinary switch costs the turn and takes hazards plus any pending opposing attack; a replacement after a faint is free. Compare both pivot branches. A sacrifice can grant a safe entry but may feed an opposing knockout boost. ' +
  'currentGamePlan is recomputed now. Its candidate and Tera rankings are provisional. raceCoverage is a simplified direct-attack race, not win probability. Never protect a former candidate at the cost of teammates whose CURRENT contribution is greater. Evaluate Tera against its present defensive benefit and all remaining teammates; never reserve it unconditionally. ' +
  'Opponent behaviour probabilities are uncertain, decaying estimates. Set frequencies describe availability, not choices. Search sees multi-turn consequences but simplifies mechanics and hidden sets. Use concrete facts when departing from it. ' +
  'Evaluate recovery after faster hits, hazards only when future entries remain, and setup only when useful and executable. Avoid losing recovery/switch loops but compare the replacement action. Rest guarantees two sleeping turns; Sleep Talk can act through sleep, and otherwise staying asleep can still be better than sacrificing a switch-in. ' +
  'sameAsWithoutTerastallising inherits all fields from the named action except written differences and fieldsThatNoLongerApply; sharedByEveryActionBelow applies to each relevant action. Missing estimates mean uncertainty, not safety. Rank all alternatives meaningfully.';

/** Retry-After in seconds, given either as a number of seconds or as an HTTP date. */
function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.ceil((at - Date.now()) / 1000);
}

/** Official TypeSafe Choice API, one bounded call per decision; no automatic paid retries. */
export class JevDecisionProvider implements DecisionProvider {
  private readonly fallback = new RandomDecisionProvider();
  private metrics: ProviderMetrics = { attempts: 0, successfulCalls: 0, failedCalls: 0, invalidResponses: 0,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: null, usageIncomplete: false, lastInvalidResponseReason: null,
    lastHttpStatus: null, lastCooldownSeconds: null };
  private disabled = false;
  private cooldownUntil = 0;
  constructor(private readonly options: Options) {
    if (!options.apiKey || /[\r\n]/.test(options.apiKey) || !Number.isSafeInteger(options.maxCalls) || options.maxCalls < 0) throw new Error('Invalid Jev configuration');
  }
  getMetrics(): ProviderMetrics { return { ...this.metrics }; }
  private emit(status: string) { this.options.onEvent?.({ status, metrics: this.getMetrics() }); }
  private async local(input: DecisionInput, reason: string): Promise<DecisionResult> {
    return { ...await this.fallback.chooseAction(input), provider: 'random', fallbackReason: reason };
  }
  async chooseAction(input: DecisionInput, context?: { signal?: AbortSignal }): Promise<DecisionResult> {
    if (context?.signal?.aborted) throw new Error('Decision cancelled');
    if (input.legalActions.length === 1) return { chosenAction: input.legalActions[0]!.id, provider: 'random' };
    if (!input.legalActions.length || input.legalActions.length > 255) return this.local(input, 'unsupported_option_count');
    if (this.disabled) return this.local(input, 'jev_disabled_after_auth_error');
    if (Date.now() < this.cooldownUntil) return this.local(input, 'jev_cooldown');
    if (this.metrics.attempts >= this.options.maxCalls) return this.local(input, 'jev_call_limit');
    // Our own payload budget, not an asserted API limit. Reduce described detail rather than
    // truncating the action set: every legal action is always offered.
    const payload = buildJevPayload(input, this.options.model ?? 'jev-latest');
    if (!payload) return this.local(input, 'jev_context_limit');
    const { body, detail: payloadDetail, overBudget } = payload;
    if (overBudget) this.emit('jev_payload_over_budget');
    this.metrics.attempts++;
    let responseReceived = false, usageRecorded = false;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 1500);
    const signal = context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    try {
      const response = await (this.options.request ?? fetch)(JEV_ENDPOINT, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' }, body,
      });
      if (response.status === 401 || response.status === 403) this.disabled = true;
      if (!response.ok) this.metrics.lastHttpStatus = response.status;
      // Rate limited or overloaded: back off for as long as the service asks, within 5 to 60 seconds, else 30.
      // The lookahead decides meanwhile, so a shorter wait gets Jev back sooner without a paid retry.
      if (response.status === 429 || response.status === 529) {
        const seconds = Math.min(60, Math.max(5, retryAfterSeconds(response.headers.get('retry-after')) ?? 30));
        this.cooldownUntil = Date.now() + seconds * 1000;
        this.metrics.lastCooldownSeconds = seconds;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Jev HTTP failure'); }
      responseReceived = true;
      const data: unknown = await response.json();
      if (isRecord(data) && isRecord(data.usage) && tokens(data.usage.input_tokens) && tokens(data.usage.output_tokens)) {
        this.metrics.inputTokens += data.usage.input_tokens;
        this.metrics.outputTokens += data.usage.output_tokens;
        usageRecorded = true;
        if (this.options.inputUsdPerMillion !== undefined && this.options.outputUsdPerMillion !== undefined) {
          this.metrics.estimatedCostUsd = (this.metrics.inputTokens * this.options.inputUsdPerMillion +
            this.metrics.outputTokens * this.options.outputUsdPerMillion) / 1_000_000;
        }
      }
      const result = validateJevResponse(data, input.legalActions.map(a => a.id));
      if (signal.aborted) throw new Error('Cancelled');
      this.metrics.successfulCalls++;
      this.emit('jev_success');
      return { ...result, instructionsVersion: INSTRUCTIONS_VERSION, payloadDetail, payloadBytes: Buffer.byteLength(body), ...(overBudget ? { payloadOverBudget: true as const } : {}) };
    } catch (error) {
      this.metrics.failedCalls++;
      if (responseReceived && !signal.aborted) {
        this.metrics.invalidResponses++;
        // Our own service's reply, already bounded and stripped by the validator.
        this.metrics.lastInvalidResponseReason = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      }
      if (!usageRecorded) this.metrics.usageIncomplete = true;
      const http = this.metrics.lastHttpStatus;
      this.emit(signal.aborted ? 'jev_cancelled_or_timed_out' : responseReceived ? 'jev_invalid_response'
        : http === 429 ? `jev_rate_limited (cooldown ${this.metrics.lastCooldownSeconds}s)`
        : http === 529 ? `jev_overloaded (cooldown ${this.metrics.lastCooldownSeconds}s)`
        : http ? `jev_failed (HTTP ${http})` : 'jev_failed');
      this.metrics.lastHttpStatus = null;
      if (context?.signal?.aborted) throw new Error('Decision cancelled');
      return this.local(input, signal.aborted ? 'jev_timeout' : 'jev_failed');
    }
  }
}
