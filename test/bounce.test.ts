import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectViability } from '../src/strategy/viability.js';
import { hazardValue } from '../src/strategy/hazards.js';
import { inferOpponent } from '../src/strategy/inference.js';
import { battle, ours } from './helpers.js';

const pincurchin = () => ours('Pincurchin', 88, ['Toxic Spikes', 'Recover', 'Discharge'], 'Electric Surge', 'Leftovers', 'Water');
const reasons = (b: ReturnType<typeof battle>, move: string) => effectViability(b.state, move, b.me(), 'p1', b.foe());

test('a move reflected by Magic Bounce is reported as turned against us, not as wasted', () => {
  const b = battle([pincurchin()], 'Hatterene', 85);
  // Every sampled Hatterene carries Magic Bounce, so it is a certainty of the set rather than a guess.
  const unknown = reasons(b, 'Toxic Spikes')!;
  assert.equal(unknown.certain.length, 0, 'the ability is not revealed yet');
  assert.equal(unknown.possible[0]!.probability, 1);
  assert.match(unknown.possible[0]!.reason, /lands on our own side instead of theirs/);
  // Once revealed it is a fact, and it says what it costs rather than only that it fails.
  b.foe().ability = 'Magic Bounce';
  const known = reasons(b, 'Toxic Spikes')!;
  assert.equal(known.possible.length, 0);
  assert.match(known.certain[0]!, /Magic Bounce reflects this, so Toxic Spikes lands on our own side/);
  // A move it cannot reflect is unaffected.
  assert.equal(reasons(b, 'Discharge'), null);
});

test('a revealed ability settles the question in both directions', () => {
  const b = battle([pincurchin()], 'Hatterene', 85);
  b.foe().ability = 'Healer';
  assert.equal(reasons(b, 'Toxic Spikes'), null, 'a different revealed ability rules the reflection out');
  b.foe().ability = 'Magic Bounce';
  b.foe().abilitySuppressed = true;
  assert.equal(reasons(b, 'Toxic Spikes'), null, 'and a suppressed ability reflects nothing');
});

test('a hazard that would be reflected is not priced as an investment', () => {
  const b = battle([pincurchin()], 'Hatterene', 85);
  const speculative = hazardValue(b.state, 'Toxic Spikes', 'p1')!;
  assert.equal(speculative.sets, 'Toxic Spikes');
  assert.ok('opposingPokemonStillToComeIn' in speculative, 'unrevealed, so it is still priced normally');
  b.foe().ability = 'Magic Bounce';
  const reflected = hazardValue(b.state, 'Toxic Spikes', 'p1')!;
  assert.ok('wouldBeReflectedOntoOurSideInstead' in reflected && reflected.wouldBeReflectedOntoOurSideInstead);
  assert.ok(!('opposingPokemonStillToComeIn' in reflected), 'and no longer advertised as collecting on their switches');
});

test('a move bounced back at us is not recorded as one the opponent knows', () => {
  const b = battle([pincurchin()], 'Hatterene', 85);
  b.feed('|move|p1a: Pincurchin|Toxic Spikes|p2a: Foe');
  b.feed('|move|p2a: Foe|Toxic Spikes|p1a: Pincurchin|[from]ability: Magic Bounce|[of] p2a: Foe');
  assert.deepEqual(b.foe().revealedMoves, [], 'our own move reflected back is not evidence of their set');
  assert.equal(inferOpponent(b.foe()).summary.status, 'candidate-pools',
    'so the inference survives, and with it the warning about the reflection');
  assert.ok(inferOpponent(b.foe()).candidates.length > 0);
  // A move genuinely called from the user's own set is still evidence of that set.
  b.feed('|move|p2a: Foe|Psychic Noise|p1a: Pincurchin|[from]move: Sleep Talk');
  assert.deepEqual(b.foe().revealedMoves, ['Psychic Noise']);
});
