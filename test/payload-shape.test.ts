import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures } from '../src/strategy/features.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { battle, ours } from './helpers.js';
import { JEV_TOKEN_LIMIT, estimatedTokens } from '../src/decisions/JevDecisionProvider.js';

function payload(detail: 'full' | 'reduced' | 'minimal') {
  const b = battle([
    ours('Garchomp', 78, ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Fire Fang'], 'Rough Skin', 'Life Orb', 'Fire'),
    ours('Azumarill', 82, ['Play Rough'], 'Huge Power', 'Sitrus Berry', 'Water'),
  ], 'Keldeo');
  // The helper's request never offers Tera, and Tera variants are exactly what this is about.
  const base = b.payload(2, b.state.sides.p1.team[0]!.exactHP?.max ?? 100) as
    { active: { moves: unknown[]; canTerastallize?: string }[] };
  base.active[0]!.canTerastallize = 'Fire';
  const raw = JSON.stringify(base);
  const request = parseChoiceRequest(raw)!;
  const legalActions = generateLegalActions(request);
  return { legalActions, features: extractFeatures({ state: b.state, request, legalActions }, detail) };
}

test('collapsing Tera variants and hoisting shared fields loses no action and no information', () => {
  for (const detail of ['full', 'reduced', 'minimal'] as const) {
    const { legalActions, features } = payload(detail);
    const actions = features.actions as unknown as Record<string, unknown>[];
    // The invariant that matters most: no tier may drop a legal action.
    assert.deepEqual(actions.map(a => a.id).sort(), legalActions.map(a => a.id).sort(), detail);
    for (const a of actions) {
      assert.ok(a.label, `${detail}: every action keeps its own label`);
      const base = a.sameAsWithoutTerastallising;
      if (base === undefined) continue;
      // A reference must point at an action that is actually present, or it says nothing.
      assert.ok(actions.some(x => x.id === base), `${detail}: ${String(a.id)} references a listed action`);
      assert.ok(String(a.id).endsWith('-terastallize'));
    }
    const shared = features.sharedByEveryActionBelow as Record<string, unknown> | undefined;
    if (!shared) continue;
    // Hoisted once means hoisted everywhere: a value left behind on an action would read as a difference.
    for (const key of Object.keys(shared)) {
      assert.ok(actions.every(a => !(key in a)), `${detail}: ${key} is stated once, not repeated`);
    }
  }
});

test('a Tera action still differs from its base where Terastallising actually changes something', () => {
  const { features } = payload('reduced');
  const actions = features.actions as unknown as Record<string, unknown>[];
  const delta = actions.find(a => a.sameAsWithoutTerastallising);
  assert.ok(delta, 'Tera is on offer in this fixture');
  // The whole point of the reference is that what remains is the difference, not an empty shell.
  const carried = Object.keys(delta).filter(k => !['id', 'kind', 'label', 'requestUncertain', 'sameAsWithoutTerastallising',
    'fieldsThatNoLongerApply', 'nothingModelledChangesByTerastallising'].includes(k));
  // Either it says what Tera changes, or it says outright that nothing modelled changes. A bare reference,
  // which reads as an action with no content at all, is the one thing it must never be.
  assert.ok(carried.length > 0 || delta.nothingModelledChangesByTerastallising === true,
    `got a contentless Tera action: ${JSON.stringify(Object.keys(delta))}`);
});

test('the byte budget is a relevance threshold, and the model ceiling is the only hard limit', () => {
  const { legalActions, features } = payload('reduced');
  void features;
  // Measured usage sits near a third of the ceiling, so an ordinary turn is nowhere near it.
  const body = JSON.stringify({ state: features, questions: { battle_action: { criteria: legalActions } } });
  assert.ok(estimatedTokens(body) < JEV_TOKEN_LIMIT / 2, 'an ordinary decision uses well under half the ceiling');
  // The estimate must never understate: it divides by the densest ratio actually observed.
  assert.equal(estimatedTokens('x'.repeat(2180)), 1000);
  assert.ok(estimatedTokens('x'.repeat(32_000)) > 32_000 / 2.47,
    'a conservative estimate reports more tokens than the median ratio would');
  assert.equal(JEV_TOKEN_LIMIT, 32_000, 'one question per decision, so the 32,000 ceiling applies, not 64,000');
});
