import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupProjection, statusProjection, defensiveTera } from '../src/strategy/projection.js';
import { hazardValue } from '../src/strategy/hazards.js';
import { endgame } from '../src/strategy/endgame.js';
import { choiceLock } from '../src/strategy/stalling.js';
import { effectViability } from '../src/strategy/viability.js';
import { damageRange } from '../src/strategy/damage.js';
import { incomingThreats } from '../src/strategy/threat.js';
import { pinchAbility, pinchAbilityRisk } from '../src/strategy/abilities.js';
import { inferOpponent } from '../src/strategy/inference.js';
import { formeChange, teraFormeChange, switchOutForme } from '../src/strategy/forme.js';
import { battle, ours } from './helpers.js';

const haxorus = () => ours('Haxorus', 78, ['Outrage', 'Dragon Dance', 'Iron Head', 'Close Combat'], 'Mold Breaker', 'Lum Berry', 'Steel');
const skarmory = () => ours('Skarmory', 84, ['Stealth Rock', 'Spikes', 'Defog', 'Body Press'], 'Sturdy', 'Leftovers', 'Dragon');
const misdreavus = () => ours('Misdreavus', 90, ['Will-O-Wisp', 'Thunder Wave', 'Shadow Ball'], 'Levitate', 'Eviolite', 'Fairy');

test('a boosting move is projected to what it buys, not just what it raises', () => {
  const b = battle([haxorus()], 'Amoonguss');
  const dance = setupProjection(b.state, b.me(), 'p1', { atk: 1, spe: 1 })!;
  assert.ok(dance.ourBestDamagePercentAfter! > dance.wasBefore!, `${dance.wasBefore} -> ${dance.ourBestDamagePercentAfter}`);
  assert.equal(dance.outrunsTheActiveAfterwards, true);
  // At the cap it buys nothing, and says so by projecting no change.
  b.feed('|-setboost|p1a: Haxorus|atk|6');
  b.feed('|-setboost|p1a: Haxorus|spe|6');
  const capped = setupProjection(b.state, b.me(), 'p1', { atk: 1, spe: 1 })!;
  assert.equal(capped.ourBestDamagePercentAfter, capped.wasBefore, 'already maxed, so nothing changes');
});

test('a status is valued by what it blunts, not only by landing', () => {
  const b = battle([misdreavus()], 'Haxorus', 78);
  const burn = statusProjection(b.state, b.foe(), 'p1', b.me(), 'brn')!;
  assert.ok((burn.worstIncomingPercentBecomes as number) < (burn.wasBefore as number),
    `a burn halves physical Attack: ${burn.wasBefore} -> ${burn.worstIncomingPercentBecomes}`);
  const para = statusProjection(b.state, b.foe(), 'p1', b.me(), 'par')!;
  assert.equal(para.fullParalysisChancePercent, 25);
  // A target that already has a status gains nothing from another.
  b.feed('|-status|p2a: Foe|brn');
  assert.equal(statusProjection(b.state, b.foe(), 'p1', b.me(), 'par'), null);
});

test('our own Tera is evaluated for what it stops, not only for what it hits', () => {
  const b = battle([ours('Gyarados', 79, ['Waterfall'], 'Intimidate', 'Leftovers', 'Steel')], 'Raging Bolt', 80);
  const tera = defensiveTera(b.state, b.me(), 'p1', 'Steel')!;
  assert.ok(tera.worstIncomingPercentBecomes < tera.wasBefore, `${tera.wasBefore} -> ${tera.worstIncomingPercentBecomes}`);
  assert.equal(tera.stopsItFromKnockingUsOut, true, 'Steel turns a guaranteed KO into a survivable hit');
  assert.equal(defensiveTera(b.state, b.me(), 'p1', 'Stellar'), null, 'Stellar is outside the model');
  // Only a Tera that actually reduces what we take is reported as defence, and only before we have used it.
  b.me().terastallized = true;
  assert.equal(defensiveTera(b.state, b.me(), 'p1', 'Steel'), null, 'already spent');
});

test('hazards are priced by how many are still to come in, and removal by what it clears', () => {
  const b = battle([skarmory(), haxorus()], 'Amoonguss');
  assert.equal(hazardValue(b.state, 'Defog', 'p1'), null, 'with nothing up there is nothing to clear');
  const rocks = hazardValue(b.state, 'Stealth Rock', 'p1')!;
  assert.equal(rocks.sets, 'Stealth Rock', 'keyed the way the tracker keys hazards');
  assert.equal(rocks.layersAfterThis, 1);
  assert.equal(rocks.opposingPokemonStillToComeIn, 5);
  b.feed('|-sidestart|p2: Foe|move: Stealth Rock');
  assert.equal(hazardValue(b.state, 'Stealth Rock', 'p1'), null, 'already up, so it is worth nothing');
  assert.equal(hazardValue(b.state, 'Spikes', 'p1')!.layersAfterThis, 1, 'Spikes still has room');
  b.feed('|-sidestart|p1: Test Bot|move: Spikes');
  const defog = hazardValue(b.state, 'Defog', 'p1')!;
  assert.ok('clearsFromOurSide' in defog, 'removal reports what it clears');
  assert.deepEqual(defog.clearsFromOurSide, { Spikes: 1 });
  assert.deepEqual(defog.alsoClearsFromTheirs, { 'Stealth Rock': 1 });
});

test('the endgame reads past the active pair and names what we cannot answer', () => {
  const b = battle([skarmory(), haxorus()], 'Amoonguss');
  b.feed('|switch|p2a: Foe2|Typhlosion, L82|100/100');
  const e = endgame(b.state, 'p1')!;
  assert.equal(e.revealedOpposingPokemon, 2);
  assert.deepEqual(e.remaining, { ours: 2, theirs: 6 });
  assert.ok(e.ourPokemon.every(x => x.beats.includes('Amoonguss')), 'both of ours handle Amoonguss');
  assert.deepEqual(e.theirsWeHaveNoAnswerTo, ['Typhlosion'], 'and neither handles Typhlosion');
});

test('a Choice item makes the next move known, with the item probability attached', () => {
  const b = battle([misdreavus()], 'Typhlosion');
  assert.equal(choiceLock(b.foe()), null, 'nothing used yet, so nothing is locked');
  b.feed('|move|p2a: Foe|Eruption|p1a: Misdreavus');
  const guessed = choiceLock(b.foe())!;
  assert.equal(guessed.lockedInto, 'Eruption');
  assert.equal(guessed.certainty, 'from-candidate-items');
  assert.equal(guessed.probability, 1, 'every sampled Typhlosion carries a Choice item');
  b.foe().item = 'Choice Specs';
  assert.equal(choiceLock(b.foe())!.certainty, 'item-is-known');
  // A known non-Choice item rules it out entirely.
  b.foe().item = 'Leftovers';
  assert.equal(choiceLock(b.foe()), null);
});

test('Sleep Clause is respected, so a second sleep move is not offered as if it worked', () => {
  const b = battle([ours('Amoonguss', 82, ['Spore'], 'Regenerator', 'Rocky Helmet', 'Steel')], 'Typhlosion');
  assert.deepEqual(effectViability(b.state, 'Spore', b.me(), 'p1', b.foe())?.certain ?? [], []);
  b.feed('|switch|p2a: Asleep|Pyroar, L84|100/100');
  b.feed('|-status|p2a: Asleep|slp');
  b.feed('|switch|p2a: Foe|Typhlosion, L82|100/100');
  const blocked = effectViability(b.state, 'Spore', b.me(), 'p1', b.foe())!.certain;
  assert.ok(blocked.some(r => /Sleep Clause/.test(r) && /Pyroar/.test(r)), JSON.stringify(blocked));
});

test('an ability that takes nothing is named, so a zero is not read as a low roll', () => {
  const b = battle([ours('Gyarados', 79, ['Waterfall', 'Earthquake'], 'Intimidate', 'Leftovers', 'Flying')], 'Gastrodon', 82);
  const water = damageRange(b.state, 'Waterfall')!;
  assert.deepEqual(water.percentOfMaxHP, [0, 0]);
  const absorbed = water.takesNothingFromIt!;
  assert.equal(absorbed.probability, 1);
  assert.ok('abilities' in absorbed && absorbed.abilities.includes('Storm Drain'), JSON.stringify(absorbed));
  const ground = damageRange(b.state, 'Earthquake')!;
  assert.ok(ground.percentOfMaxHP[1] > 0);
  assert.equal(ground.takesNothingFromIt, undefined, 'a move that lands is not annotated');
});

test('an attacker that reads through abilities is not told the move is absorbed', () => {
  const breaker = battle([ours('Gyarados', 79, ['Waterfall'], 'Mold Breaker', 'Leftovers', 'Flying')], 'Gastrodon', 82);
  const through = damageRange(breaker.state, 'Waterfall')!;
  assert.ok(through.percentOfMaxHP[1] > 0, 'Mold Breaker reads straight through Storm Drain');
  assert.equal(through.takesNothingFromIt, undefined, 'so no absorption is claimed');
  // The same applies to setting up into Unaware.
  const ordinary = battle([ours('Gyarados', 79, ['Waterfall', 'Dragon Dance'], 'Intimidate', 'Leftovers', 'Flying')], 'Skeledirge', 82);
  const blocked = setupProjection(ordinary.state, ordinary.me(), 'p1', { atk: 1, spe: 1 })!;
  assert.equal(blocked.ignoredByUnawareWithProbability, 1);
  assert.equal(blocked.ourBestDamagePercentAfter, blocked.wasBefore, 'and the damage genuinely does not move');
  const moldy = battle([ours('Haxorus', 78, ['Outrage', 'Dragon Dance'], 'Mold Breaker', 'Lum Berry', 'Steel')], 'Skeledirge', 82);
  const allowed = setupProjection(moldy.state, moldy.me(), 'p1', { atk: 1, spe: 1 })!;
  assert.equal(allowed.ignoredByUnawareWithProbability, undefined);
  assert.ok(allowed.ourBestDamagePercentAfter! > allowed.wasBefore!, 'and the boost does apply');
});

test('our own ability absorbing an incoming move is stated, since we know it for certain', () => {
  const b = battle([ours('Gastrodon', 82, ['Earth Power'], 'Storm Drain', 'Leftovers', 'Grass')], 'Basculegion-F', 83);
  const threat = incomingThreats(b.state, b.me(), 'p1', 4)!;
  const water = threat.damagingMoves.filter(m => m.takesNothingBecauseOfOurAbility);
  assert.ok(water.length >= 1, JSON.stringify(threat.damagingMoves.map(m => m.move)));
  assert.ok(water.every(m => m.percentOfMaxHP[1] === 0 && m.takesNothingBecauseOfOurAbility === 'Storm Drain'));
  assert.ok(threat.damagingMoves.some(m => !m.takesNothingBecauseOfOurAbility), 'other moves still land');
});

test('a pinch ability is reported with its threshold, and as a possibility when unknown', () => {
  const b = battle([ours('Venusaur', 82, ['Giga Drain'], 'Overgrow', 'Life Orb', 'Grass')], 'Typhlosion');
  const full = pinchAbility(b.me())!;
  assert.equal(full.ability, 'Overgrow');
  assert.equal(full.active, false);
  assert.equal(full.atOrBelowPercentOfMaxHP, 33.3);
  b.feed(b.request(5, Math.floor(b.me().exactHP!.max * 0.25)));
  assert.equal(pinchAbility(b.me())!.active, true, 'below a third it is live');
  // The opponent's is only ever a possibility until the ability is revealed.
  const risk = pinchAbilityRisk(b.foe(), inferOpponent(b.foe()).candidates)!;
  assert.equal(risk.ability, 'Blaze');
  assert.ok(risk.probability > 0 && risk.probability < 1, `Typhlosion also rolls Flash Fire, got ${risk.probability}`);
  b.foe().ability = 'Flash Fire';
  assert.equal(pinchAbilityRisk(b.foe(), inferOpponent(b.foe()).candidates), null, 'a revealed ability settles it');
});

test('a move that changes our form is projected, including what it saves', () => {
  const b = battle([ours('Meloetta', 82, ['Close Combat', 'Triple Axel', 'Knock Off', 'Relic Song'], 'Serene Grace', 'Leftovers', 'Fighting')], 'Oinkologne', 88);
  assert.equal(formeChange(b.state, b.me(), 'p1', 'Close Combat'), null, 'an ordinary move changes no form');
  const relic = formeChange(b.state, b.me(), 'p1', 'Relic Song')!;
  assert.equal(relic.becomes, 'Meloetta-Pirouette');
  assert.deepEqual(relic.wasTypes, ['Normal', 'Psychic']);
  assert.deepEqual(relic.types, ['Normal', 'Fighting'], 'the Fighting typing Tera would otherwise buy');
  assert.equal(relic.baseStatShifts.atk, '+51');
  assert.equal(relic.baseStatShifts.spe, '+38');
  assert.ok(relic.ourBestDamagePercentAfter! > relic.wasBefore! * 2, `${relic.wasBefore} -> ${relic.ourBestDamagePercentAfter}`);
  assert.ok('reachesThisFormWithoutSpendingTera' in relic && relic.reachesThisFormWithoutSpendingTera);
  assert.ok('revertsOnSwitchingOut' in relic && relic.revertsOnSwitchingOut);
  // Once the Tera is spent there is nothing left to save, so that line goes away.
  b.me().terastallized = true;
  assert.ok(!('reachesThisFormWithoutSpendingTera' in formeChange(b.state, b.me(), 'p1', 'Relic Song')!));
});

test('the projected form keeps our real spread rather than a guessed one', () => {
  const b = battle([ours('Meloetta', 82, ['Relic Song'], 'Serene Grace', 'Leftovers', 'Fighting')], 'Oinkologne', 88);
  const me = b.me();
  const relic = formeChange(b.state, me, 'p1', 'Relic Song')!;
  // Pirouette swaps Meloetta's offensive and defensive stats, so the projection must not simply reuse ours.
  assert.equal(relic.baseStatShifts.spa, '-51');
  assert.equal(relic.baseStatShifts.spd, '-51');
  assert.ok(relic.worstIncomingPercentAfter !== undefined, 'what it then takes is projected too');
  // A Pokemon whose private stats we never received cannot be projected, rather than being guessed at.
  const blind = { ...me, stats: {} };
  delete (blind as { exactHP?: unknown }).exactHP;
  assert.equal(formeChange(b.state, blind, 'p1', 'Relic Song'), null);
});

test('Terastallising into a form is projected by what the form costs, not only what it gains', () => {
  const b = battle([ours('Terapagos-Terastal', 75, ['Tera Starstorm', 'Earth Power', 'Calm Mind'], 'Tera Shell', 'Leftovers', 'Stellar')], 'Iron Boulder', 79);
  const tera = teraFormeChange(b.state, b.me(), 'p1')!;
  assert.equal(tera.becomes, 'Terapagos-Stellar');
  // Tera Shell halves every hit at full health, and the Stellar form does not have it.
  assert.equal(tera.wasAbility, 'Tera Shell');
  assert.equal(tera.abilityBecomes, 'Teraform Zero');
  assert.ok(tera.worstIncomingPercentAfter! > tera.incomingWasBefore! * 2,
    `losing Tera Shell more than doubles what we take: ${tera.incomingWasBefore} -> ${tera.worstIncomingPercentAfter}`);
  assert.ok(tera.ourBestDamagePercentAfter! > tera.wasBefore!, 'while the offence gains comparatively little');
  assert.ok('spendsOurTera' in tera && tera.spendsOurTera, 'and it costs the one Tera we have');
  assert.ok('permanent' in tera && tera.permanent, 'a Terastallised form does not revert on switching');
  // Nothing to project once it has already been used.
  b.me().terastallized = true;
  assert.equal(teraFormeChange(b.state, b.me(), 'p1'), null);
});

test('a latent Stellar Tera type no longer blanks every estimate', () => {
  const b = battle([ours('Terapagos-Terastal', 75, ['Earth Power'], 'Tera Shell', 'Leftovers', 'Stellar')], 'Iron Boulder', 79);
  // Having Stellar as the Tera type changes nothing until it is used, so estimates must still be produced.
  assert.ok(damageRange(b.state, 'Earth Power'), 'a damage estimate exists');
  assert.ok(incomingThreats(b.state, b.me(), 'p1', 1), 'and so does an incoming threat');
});

test('a Pokemon that transforms by leaving the field makes switching a gain', () => {
  const b = battle([ours('Palafin', 77, ['Jet Punch', 'Wave Crash', 'Flip Turn', 'Close Combat'], 'Zero to Hero', 'Choice Band', 'Water'),
    ours('Cetitan', 82, ['Ice Shard'], 'Thick Fat', 'Leftovers', 'Ground')], 'Weezing-Galar', 88);
  const hero = switchOutForme(b.state, b.me(), 'p1')!;
  assert.equal(hero.becomes, 'Palafin-Hero');
  assert.equal(hero.baseStatShifts.atk, '+90', 'base Attack goes from 70 to 160');
  assert.ok(hero.ourBestDamagePercentAfter! > hero.wasBefore! * 1.8, `${hero.wasBefore} -> ${hero.ourBestDamagePercentAfter}`);
  assert.ok('costsNothingButTheSwitchItself' in hero && hero.costsNothingButTheSwitchItself);
  assert.ok('permanent' in hero && hero.permanent);
  assert.equal(hero.happensOnSwitchingOut, true);
  // Once it has transformed there is nothing further to gain.
  b.me().species = 'Palafin-Hero';
  assert.equal(switchOutForme(b.state, b.me(), 'p1'), null);
});

test('only an ability that actually transforms on switching is reported', () => {
  const b = battle([ours('Cetitan', 82, ['Ice Shard'], 'Thick Fat', 'Leftovers', 'Ground'),
    ours('Palafin', 77, ['Jet Punch'], 'Zero to Hero', 'Choice Band', 'Water')], 'Weezing-Galar', 88);
  assert.equal(switchOutForme(b.state, b.me(), 'p1'), null, 'an ordinary Pokemon gains nothing from leaving');
  // A suppressed ability transforms nothing.
  const p = battle([ours('Palafin', 77, ['Jet Punch'], 'Zero to Hero', 'Choice Band', 'Water'),
    ours('Cetitan', 82, ['Ice Shard'], 'Thick Fat', 'Leftovers', 'Ground')], 'Weezing-Galar', 88);
  p.me().abilitySuppressed = true;
  assert.equal(switchOutForme(p.state, p.me(), 'p1'), null);
});
