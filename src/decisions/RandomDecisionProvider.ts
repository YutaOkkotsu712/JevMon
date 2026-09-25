import { randomInt } from 'node:crypto';
import type { DecisionInput, DecisionProvider, DecisionResult } from './DecisionProvider.js';
export class RandomDecisionProvider implements DecisionProvider {
  async chooseAction(input: DecisionInput): Promise<DecisionResult> {
    if (!input.legalActions.length) throw new Error('No legal actions');
    return { chosenAction: input.legalActions[randomInt(input.legalActions.length)]!.id };
  }
}
