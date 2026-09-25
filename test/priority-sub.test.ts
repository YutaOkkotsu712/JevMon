import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lethalPriority } from '../src/strategy/dominance.js';
import { substitutePlan } from '../src/strategy/stalling.js';
import { effectViability } from '../src/strategy/viability.js';
import type { BattleAction, ChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { battle, ours } from './helpers.js';

const dodrio = () => ours('Dodrio', 85, ['Knock Off', 'Drill Run', 'Quick Attack', 'Brave Bird'], 'Early Bird', 'Choice Band', 'Flying');
const moves = (labels: string[]): BattleAction[] =>
  labels.map((label, i) => ({ id: `move-${i + 1}`, kind: 'move', command: `move ${i + 1}`, label, uncertain: false }));

function decide(b: ReturnType<typeof battle>, labels: string[]) {
  const request = b.payload(9, b.me().exactHP!.current) as unknown as ChoiceRequest;
  request.active![0]!.moves = labels.map(l => ({ move: l, id: l.toLowerCase().replace(/[^a-z0-9]/g, ''), pp: 12, maxpp: 16 }));
  return lethalPriority({ state: b.state, legalActions: moves(labels), request });
}

test('a knockout that moves first dominates one that does not', () => {
  // Cinccino on a sliver: every one of Dodrio's attacks knocks it out, but only Quick Attack goes first.
  const b = battle([dodrio()], 'Cinccino', 88);
  b.feed('|-damage|p2a: Foe|18/100');
  const map = decide(b, ['Knock Off', 'Drill Run', 'Quick Attack', 'Brave Bird']);
  assert.ok(map.size > 0, 'the slower knockouts are dominated');
  const braveBird = map.get('move-4');
  assert.ok(braveBird, 'Brave Bird is skippable');
  assert.equal(braveBird!.by, 'move-3', 'in favour of Quick Attack');
  assert.match(braveBird!.reason, /also knocks the target out .* and moves first/);
  assert.equal(map.has('move-3'), false, 'the priority move itself is never skipped');
});

test('it stays silent unless both moves are certain knockouts', () => {
  // At full health nothing knocks Cinccino out, so nothing is dominated.
  const healthy = battle([dodrio()], 'Cinccino', 88);
  assert.equal(decide(healthy, ['Quick Attack', 'Brave Bird']).size, 0);
  // A target behind a Substitute is excluded, because a knockout then means the shell.
  const shielded = battle([dodrio()], 'Cinccino', 88);
  shielded.feed('|-damage|p2a: Foe|18/100');
  shielded.feed('|-start|p2a: Foe|Substitute');
  assert.equal(decide(shielded, ['Quick Attack', 'Brave Bird']).size, 0);
});

test('a Substitute is priced by whether the shell survives what is coming', () => {
  const b = battle([ours('Enamorus', 79, ['Substitute', 'Moonblast', 'Calm Mind'], 'Cute Charm', 'Leftovers', 'Fairy')], 'Scyther', 88);
  const plan = substitutePlan(b.state, b.me(), 'p1', 'Substitute')!;
  assert.equal(plan.costsPercentOfMaxHP, 25);
  assert.equal(plan.substituteHP, Math.floor(b.me().exactHP!.max / 4));
  assert.equal(plan.leavesUsAtPercentOfMaxHP, 75);
  assert.equal(plan.blocksStatusAndStatChangesWhileItStands, true);
  assert.equal(typeof plan.shellSurvivesThatHit, 'boolean', 'the whole question is whether it holds');
  assert.equal(substitutePlan(b.state, b.me(), 'p1', 'Moonblast'), null);
});

test('Shed Tail is priced as the shell it hands over, at double the cost', () => {
  const b = battle([ours('Orthworm', 88, ['Shed Tail', 'Body Press', 'Heavy Slam'], 'Earth Eater', 'Eviolite', 'Electric'),
    ours('Enamorus', 79, ['Calm Mind'], 'Cute Charm', 'Leftovers', 'Fairy')], 'Infernape', 84);
  const plan = substitutePlan(b.state, b.me(), 'p1', 'Shed Tail')!;
  assert.equal(plan.costsPercentOfMaxHP, 50, 'twice the price of a plain Substitute');
  assert.equal(plan.substituteHP, Math.floor(b.me().exactHP!.max / 4), 'for the same size of shell');
  assert.equal(plan.passedToThePokemonComingIn, true);
  assert.match(plan.why!, /arrives already behind the shell/);
  // And it cannot be afforded below half health, where a plain Substitute still could be.
  b.feed(b.request(5, Math.floor(b.me().exactHP!.max * 0.4)));
  const reasons = effectViability(b.state, 'Shed Tail', b.me(), 'p1', b.foe())!.certain;
  assert.ok(reasons.some(r => /Shed Tail needs more than half/.test(r)), JSON.stringify(reasons));
  assert.deepEqual(effectViability(b.state, 'Substitute', b.me(), 'p1', b.foe())?.certain ?? [], [],
    'a quarter is still affordable at forty percent');
});
