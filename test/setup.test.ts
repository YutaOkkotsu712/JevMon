import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveEffect } from '../src/pokemon/mechanics.js';
import { setupProjection, weatherProjection } from '../src/strategy/projection.js';
import { damageRange } from '../src/strategy/damage.js';
import { extractFeatures } from '../src/strategy/features.js';
import type { BattleAction, ChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { battle, ours } from './helpers.js';

const cetitan = () => ours('Cetitan', 82, ['Belly Drum', 'Earthquake', 'Ice Shard', 'Ice Spinner'], 'Thick Fat', 'Leftovers', 'Ground');
const wake = () => ours('Walking Wake', 76, ['Hydro Steam', 'Flamethrower', 'Draco Meteor', 'Sunny Day'], 'Protosynthesis', 'Life Orb', 'Fire');

test('effects the dex keeps in code rather than data are still described', () => {
  const drum = moveEffect('Belly Drum', 300)!;
  assert.deepEqual(drum.userBoosts, { atk: 6 });
  assert.equal(drum.costsPercentOfMaxHP, 50);
  assert.match(drum.alsoDoes as string, /half the user's max HP/);
  assert.deepEqual(moveEffect('Tidy Up', 300)!.userBoosts, { atk: 1, spe: 1 });
  assert.deepEqual(moveEffect('Take Heart', 300)!.userBoosts, { spa: 1, spd: 1 });
  assert.match(moveEffect('Haze', 300)!.alsoDoes as string, /resets every stat change/);
  assert.match(moveEffect('Trick', 300)!.alsoDoes as string, /swaps items/);
  // A move the dex already describes is untouched.
  assert.deepEqual(moveEffect('Swords Dance', 300)!.userBoosts, { atk: 2 });
  assert.equal(moveEffect('Swords Dance', 300)!.costsPercentOfMaxHP, undefined);
});

test('Belly Drum is projected as the sweep condition it is, health cost included', () => {
  const b = battle([cetitan()], 'Espeon', 84);
  const effect = moveEffect('Belly Drum', b.me().exactHP!.max)!;
  const drum = setupProjection(b.state, b.me(), 'p1', effect.userBoosts as Record<string, number>, effect.costsPercentOfMaxHP as number, true)!;
  assert.ok(drum.ourBestDamagePercentAfter! > drum.wasBefore! * 3, `${drum.wasBefore} -> ${drum.ourBestDamagePercentAfter}`);
  assert.equal(drum.nowKnocksOutTheActive, true);
  assert.equal(drum.leavesUsAtPercentOfMaxHP, 50, 'it is bought with half our health');
  assert.equal(drum.survivesToUseIt, null, 'some modeled rolls KO after the HP cost, so survival is uncertain');
  // At low health it cannot be afforded, and the projection says what it leaves behind.
  b.feed(b.request(5, Math.floor(b.me().exactHP!.max * 0.55)));
  const risky = setupProjection(b.state, b.me(), 'p1', { atk: 6 }, 50, true)!;
  assert.ok(risky.leavesUsAtPercentOfMaxHP! < 10, `barely anything left: ${risky.leavesUsAtPercentOfMaxHP}`);
});

test('setting weather is projected as setup for our own moves', () => {
  const b = battle([wake()], 'Sylveon', 88);
  const sun = weatherProjection(b.state, b.me(), 'p1', 'SunnyDay')!;
  assert.equal(sun.sets, 'SunnyDay');
  assert.equal(sun.ourBestMoveBecomes, 'Hydro Steam', 'which is what the weather is for');
  assert.ok(sun.damageGainedPercentagePoints! > 10, `a real gain: ${sun.damageGainedPercentagePoints}`);
  assert.ok(sun.ourBestDamagePercentAfter! > sun.wasBefore!);
  // Weather already up buys nothing.
  b.feed('|-weather|SunnyDay');
  assert.equal(weatherProjection(b.state, b.me(), 'p1', 'SunnyDay'), null);
});

test('Hydro Steam is stronger than Flamethrower even before the sun is up', () => {
  const b = battle([wake()], 'Sylveon', 88);
  const f = extract(b);
  const steam = f.find(a => a.label === 'Hydro Steam')!, flame = f.find(a => a.label === 'Flamethrower')!;
  assert.ok(steam.damage! > flame.damage!, `Hydro Steam ${steam.damage}% vs Flamethrower ${flame.damage}%`);
});

function extract(b: ReturnType<typeof battle>) {
  return b.me().knownMoves.map(name => ({ label: name, damage: damageRange(b.state, name)?.percentOfMaxHP[1] }));
}

test('Tera states what it buys on this move, since it can only be spent once', () => {
  const b = battle([ours('Basculin', 86, ['Wave Crash', 'Aqua Jet', 'Flip Turn', 'Double-Edge'], 'Adaptability', 'Choice Band', 'Water')], 'Weezing-Galar', 88);
  const request = b.payload(7, b.me().exactHP!.current) as unknown as ChoiceRequest;
  request.active![0]!.canTerastallize = 'Water';
  const actions: BattleAction[] = [
    { id: 'move-1', kind: 'move', command: 'move 1', label: 'Wave Crash', uncertain: false },
    { id: 'move-1-terastallize', kind: 'move', command: 'move 1 terastallize', label: 'Wave Crash + Tera Water', uncertain: false },
    { id: 'move-4', kind: 'move', command: 'move 4', label: 'Double-Edge', uncertain: false },
    { id: 'move-4-terastallize', kind: 'move', command: 'move 4 terastallize', label: 'Double-Edge + Tera Water', uncertain: false },
  ];
  const f = extractFeatures({ state: b.state, request, legalActions: actions }, 'full');
  const plain = f.actions[0] as any, teraed = f.actions[1] as any;
  assert.equal(plain.teraBuysUs, undefined, 'only the Tera action carries it');
  assert.equal(teraed.teraBuysUs.oncePerBattle, true);
  assert.equal(teraed.teraBuysUs.damagePercentWithout, plain.damageRange.percentOfMaxHP[1]);
  assert.ok(teraed.teraBuysUs.percentagePointsGained > 0);
  // Tera on a move of a different type buys nothing at all, which is the case worth seeing.
  const wasted = f.actions[3] as any;
  assert.equal(wasted.teraBuysUs.percentagePointsGained, 0, 'a Normal move gains nothing from a Water Tera');
  assert.equal(wasted.teraBuysUs.turnsAKnockOutIntoOne, false);
});

test('a stat change we never live to use is marked as wasted', () => {
  // Plusle at a third of its health against a healthy Espeon: Nasty Plot projects well and never happens.
  const b = battle([ours('Plusle', 95, ['Nasty Plot', 'Thunderbolt', 'Alluring Voice'], 'Lightning Rod', 'Life Orb', 'Electric'),
    ours('Cetitan', 82, ['Ice Shard'], 'Thick Fat', 'Leftovers', 'Ground')], 'Espeon', 84);
  const healthy = setupProjection(b.state, b.me(), 'p1', { spa: 2 }, 0, true)!;
  assert.equal(healthy.survivesToUseIt, true);
  assert.equal(healthy.wastedBecauseWeAreKnockedOutFirst, undefined);
  b.feed(b.request(5, Math.floor(b.me().exactHP!.max * 0.2)));
  const doomed = setupProjection(b.state, b.me(), 'p1', { spa: 2 }, 0, true)!;
  assert.equal(doomed.survivesToUseIt, false);
  assert.match(doomed.wastedBecauseWeAreKnockedOutFirst!, /stat changes are lost with the Pokémon/);
  // The projection itself is still reported, so the reason it will not happen sits beside the upside.
  assert.ok(doomed.ourBestDamagePercentAfter! > doomed.wasBefore!);
});

test('a move with no stat change of its own projects nothing', () => {
  const b = battle([ours('Bronzong', 88, ['Iron Defense', 'Body Press'], 'Levitate', 'Chesto Berry', 'Fighting')], 'Haxorus', 78);
  assert.equal(setupProjection(b.state, b.me(), 'p1', {}), null);
});

test('Sheer Force is reported as trading the secondary away, not keeping it', () => {
  const sheer = { ability: 'Sheer Force', abilitySuppressed: false } as never;
  const plain = { ability: 'Poison Point', abilitySuppressed: false } as never;
  assert.deepEqual(moveEffect('Sludge Bomb', 300, null, plain)!.secondaryChancePercent, [30]);
  const traded = moveEffect('Sludge Bomb', 300, null, sheer)!;
  assert.equal(traded.secondaryChancePercent, undefined, 'the secondary will not happen, so it is not advertised');
  assert.equal(traded.secondaryRemovedBySheerForce, true);
  // A move with no secondary is untouched, which is also how the damage boost behaves.
  assert.equal(moveEffect('Earthquake', 300, null, sheer)!.secondaryRemovedBySheerForce, undefined);
});

test('a self-penalty on an attacking move is not called wasted', () => {
  // Close Combat lowers our own defences, but it deals damage and the drop is not what it is for.
  const b = battle([ours('Lokix', 82, ['Close Combat', 'Sucker Punch'], 'Tinted Lens', 'Life Orb', 'Bug')], 'Espeon', 84);
  b.feed(b.request(5, 1));
  const attack = setupProjection(b.state, b.me(), 'p1', { def: -1, spd: -1 }, 0, false)!;
  assert.equal(attack.wastedBecauseWeAreKnockedOutFirst, undefined);
  assert.equal(attack.survivesToUseIt, undefined, 'the question does not apply to a move that deals damage');
  // The same stages on a status move at the same health do get flagged.
  const setup = setupProjection(b.state, b.me(), 'p1', { atk: 2 }, 0, true)!;
  assert.ok(setup.wastedBecauseWeAreKnockedOutFirst);
});
