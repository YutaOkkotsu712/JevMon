import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomingThreats } from '../src/strategy/threat.js';
import { damageRange } from '../src/strategy/damage.js';
import { battle, ours } from './helpers.js';

const baxcalibur = () => ours('Baxcalibur', 75, ['Glaive Rush', 'Icicle Crash', 'Earthquake', 'Ice Shard'], 'Thermal Exchange', 'Choice Band', 'Dragon');
const iceBeam = (b: ReturnType<typeof battle>) =>
  incomingThreats(b.state, b.me(), 'p1', Infinity)!.damagingMoves.find(m => m.move === 'Ice Beam')!;

test('Glaive Rush is tracked until its user next tries to move', () => {
  const b = battle([baxcalibur()], 'Dewgong', 94);
  b.feed('|move|p1a: Baxcalibur|Glaive Rush|p2a: Foe'); b.feed('|-singlemove|p1a: Baxcalibur|Glaive Rush|[silent]'); b.feed('|turn|2');
  assert.ok(b.me().volatiles['Glaive Rush'], 'announced by -singlemove');
  b.feed('|move|p1a: Baxcalibur|Glaive Rush|p2a: Foe'); b.feed('|-singlemove|p1a: Baxcalibur|Glaive Rush|[silent]');
  assert.ok(b.me().volatiles['Glaive Rush'], 'a second Glaive Rush sets it again after the move line ends the first');
  b.feed('|turn|3'); b.feed('|cant|p1a: Baxcalibur|par');
  assert.equal(b.me().volatiles['Glaive Rush'], undefined, 'a turn it cannot move still ends it');
  b.feed('|-singlemove|p1a: Baxcalibur|Destiny Bond'); b.feed('|move|p1a: Baxcalibur|Icicle Crash|p2a: Foe');
  assert.equal(b.me().volatiles['Destiny Bond'], undefined, 'Destiny Bond ends the same way');
});

test('a faster opponent hits our Glaive Rush user for double; a slower one does not reach it in time', () => {
  // Dewgong outspeeds Baxcalibur, so its Ice Beam lands while the drawback is still up.
  const plain = battle([baxcalibur()], 'Dewgong', 94);
  const rushed = battle([baxcalibur()], 'Dewgong', 94);
  rushed.feed('|move|p1a: Baxcalibur|Glaive Rush|p2a: Foe'); rushed.feed('|-singlemove|p1a: Baxcalibur|Glaive Rush|[silent]'); rushed.feed('|turn|2');
  const before = iceBeam(plain), after = iceBeam(rushed);
  assert.ok(after.percentOfMaxHP[0] >= 1.9 * before.percentOfMaxHP[0], `${before.percentOfMaxHP} -> ${after.percentOfMaxHP}`);
  assert.match((after.mechanicsNotes ?? []).join(' '), /Glaive Rush doubles/);
  // Against a slower Pokémon the user moves first and the drawback is gone before the hit.
  const slow = battle([baxcalibur()], 'Slowbro', 88), slowRushed = battle([baxcalibur()], 'Slowbro', 88);
  slowRushed.feed('|move|p1a: Baxcalibur|Glaive Rush|p2a: Foe'); slowRushed.feed('|-singlemove|p1a: Baxcalibur|Glaive Rush|[silent]'); slowRushed.feed('|turn|2');
  const scald = (b: ReturnType<typeof battle>) => incomingThreats(b.state, b.me(), 'p1', Infinity)!.damagingMoves.find(m => m.move === 'Scald')!.percentOfMaxHP;
  assert.deepEqual(scald(slowRushed), scald(slow));
});

test('our hit on their Glaive Rush user doubles only when we move first', () => {
  // Baxcalibur's sampled sets carry Ice Shard, which would let it move first and end the drawback; Extreme Speed outranks it.
  const fast = ours('Dragonite', 74, ['Extreme Speed', 'Earthquake'], 'Multiscale', 'Choice Band', 'Normal');
  const slow = ours('Snorlax', 84, ['Body Slam', 'Earthquake'], 'Thick Fat', 'Leftovers', 'Normal');
  const rush = (b: ReturnType<typeof battle>) => { b.feed('|move|p2a: Foe|Glaive Rush|p1a: Mon'); b.feed('|-singlemove|p2a: Foe|Glaive Rush|[silent]'); b.feed('|turn|2'); };
  const plainFast = battle([fast], 'Baxcalibur', 75), rushedFast = battle([fast], 'Baxcalibur', 75);
  rush(rushedFast);
  assert.ok(damageRange(rushedFast.state, 'Extreme Speed')!.percentOfMaxHP[0] >= 1.9 * damageRange(plainFast.state, 'Extreme Speed')!.percentOfMaxHP[0]);
  // Earthquake at equal priority could be beaten by Ice Shard, so it is not counted as doubled.
  assert.deepEqual(damageRange(rushedFast.state, 'Earthquake')!.percentOfMaxHP, damageRange(plainFast.state, 'Earthquake')!.percentOfMaxHP);
  const plainSlow = battle([slow], 'Baxcalibur', 75), rushedSlow = battle([slow], 'Baxcalibur', 75);
  rush(rushedSlow);
  assert.deepEqual(damageRange(rushedSlow.state, 'Body Slam')!.percentOfMaxHP, damageRange(plainSlow.state, 'Body Slam')!.percentOfMaxHP);
});
