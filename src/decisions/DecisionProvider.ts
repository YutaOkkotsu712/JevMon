import type { BattleAction, ChoiceRequest } from '../battle/LegalActionGenerator.js';
import type { BattleState } from '../battle/BattleState.js';
/** poke-engine's lookahead per legal action: its share of search visits and its mean score, a win estimate from 0 to 1. */
export interface SearchValue { visitShare: number; meanScore: number | null }
export interface DecisionInput { state: BattleState; legalActions: BattleAction[]; request?: ChoiceRequest; search?: Record<string, SearchValue>;
  gamePlan?: import('../strategy/gamePlan.js').GamePlan | null }
export interface ProviderMetrics {
  attempts: number;
  successfulCalls: number;
  failedCalls: number;
  invalidResponses: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  usageIncomplete: boolean;
  /** Which field of the last schema-invalid response failed, so a bad reply is diagnosable after the fact. */
  lastInvalidResponseReason: string | null;
  /** The status of the last failed HTTP reply, so a rate limit (429) is told apart from an overloaded service (529). */
  lastHttpStatus?: number | null;
  /** How long the last back-off lasted, from the service's Retry-After when it gave one. */
  lastCooldownSeconds?: number | null;
}
export interface DecisionResult {
  instructionsVersion?: string;
  payloadDetail?: 'reduced' | 'minimal';
  payloadBytes?: number;
  /** Set when even the smallest tier exceeded our own budget and was sent anyway. */
  payloadOverBudget?: true;
  chosenAction: string;
  provider?: 'jev' | 'random';
  confidence?: number;
  probabilities?: Record<string, number>;
  fallbackReason?: string;
  /** Set when a reply within rounding of valid was rescaled or a near-tie choice kept, rather than discarded. */
  responseRepaired?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface DecisionProvider {
  chooseAction(input: DecisionInput, context?: { signal?: AbortSignal }): Promise<DecisionResult>;
  getMetrics?(): ProviderMetrics;
}
