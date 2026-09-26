import { test } from 'node:test';
import assert from 'node:assert/strict';
import { damageRange } from '../src/strategy/damage.js';
import { inferOpponent } from '../src/strategy/inference.js';
import { protectOutlook } from '../src/strategy/stalling.js';
import { effectViability } from '../src/strategy/viability.js';
import { suckerOutlook } from '../src/strategy/conditional.js';
import { drainReversal, knockoutBoosts, reactiveAbilityRisks } from '../src/strategy/abilities.js';
import { moveEffect } from '../src/pokemon/mechanics.js';
import { statusRisk } from '../src/strategy/risk.js';
import { incomingThreats } from '../src/strategy/threat.js';
import { switchPunish } from '../src/strategy/prediction.js';
import { intimidateResponse } from '../src/strategy/intimidate.js';
import { battle, ours } from './helpers.js';
const ours_ = ours;

const mewtwo = (ability = 'Pressure') => ours('Mewtwo', 100, ['Shadow Ball', 'Focus Blast'], ability, 'Life Orb', 'Psychic');
const mew = (moves: string[], ability = 'Synchronize') => ours('Mew', 80, moves, ability, 'Leftovers', 'Psychic');
// The hazard-knockout branch of the threat has no matchup at all, so the field is read through this.
const onEntry = (t: object) => (t as { ourIntimidateOnEntry?: unknown }).ourIntimidateOnEntry;
const viability = (b: ReturnType<typeof battle>, move: string) => effectViability(b.state, move, b.me(), 'p1', b.foe());

test('a free replacement shows the defensive Tera it can use before the next attack', () => {
  const b = battle([
    ours('Cinderace', 77, ['High Jump Kick'], 'Libero', 'Heavy-Duty Boots', 'Fire'),
    ours('Scovillain', 91, ['Flamethrower'], 'Chlorophyll', 'Choice Specs', 'Fire'),
    ours('Hydreigon', 79, ['Dark Pulse'], 'Levitate', 'Choice Specs', 'Fire'),
  ], 'Kyurem-Black', 71);
  b.foe().revealedMoves = ['Dragon Dance', 'Icicle Spear'];
  b.feed('|-boost|p2a: Foe|atk|1');
  b.feed('|-boost|p2a: Foe|spe|1');
  b.feed('|-damage|p2a: Foe|24/100');
  b.feed('|-damage|p1a: Cinderace|0 fnt');
  b.feed('|faint|p1a: Cinderace');
  b.feed('|turn|4');
  const { active: _active, ...payload } = b.payload(7, 0);
  const request = parseChoiceRequest(JSON.stringify({ ...payload, forceSwitch: [true] }))!;
  const features = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'minimal');
  const hydreigon = features.actions.find(a => a.label.startsWith('Switch to Hydreigon')) as any;
  assert.equal(hydreigon.switchIn.incomingThreat.conditionalKO, 'all-sampled-rolls');
  assert.equal(hydreigon.switchIn.ifTerastallizedOnFirstMoveAfterReplacement.type, 'Fire');
  assert.equal(hydreigon.switchIn.ifTerastallizedOnFirstMoveAfterReplacement.incomingThreat.conditionalKO, 'none-sampled');
  assert.ok(hydreigon.switchIn.ifTerastallizedOnFirstMoveAfterReplacement.stopsTheseModeledKnockouts.includes('Icicle Spear'));
  b.me().terastallized = true;
  const spent = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'minimal');
  assert.equal((spent.actions.find(a => a.label.startsWith('Switch to Hydreigon')) as any).switchIn.ifTerastallizedOnFirstMoveAfterReplacement, undefined);
});

test('Charge and activated Flash Fire change damage instead of hiding every estimate', () => {
  const bellibolt = battle([ours('Bellibolt', 87, ['Thunderbolt'], 'Electromorphosis', 'Leftovers', 'Electric')], 'Snorlax');
  const baseElectric = damageRange(bellibolt.state, 'Thunderbolt')!;
  bellibolt.feed('|-start|p1a: Bellibolt|Charge|Tackle|[from] ability: Electromorphosis');
  const charged = damageRange(bellibolt.state, 'Thunderbolt')!;
  assert.ok(charged.percentOfMaxHP[1] > baseElectric.percentOfMaxHP[1] * 1.8);

  const houndoom = battle([ours('Houndoom', 87, ['Fire Blast', 'Dark Pulse'], 'Flash Fire', 'Life Orb', 'Fire')], 'Snorlax');
  const baseFire = damageRange(houndoom.state, 'Fire Blast')!;
  houndoom.feed('|-start|p1a: Houndoom|ability: Flash Fire');
  const boosted = damageRange(houndoom.state, 'Fire Blast')!;
  assert.ok(boosted.percentOfMaxHP[1] > baseFire.percentOfMaxHP[1] * 1.4);
  assert.ok(damageRange(houndoom.state, 'Dark Pulse'), 'unrelated moves also stay calculable');
});

test('Disguise takes the first hit for an eighth, and Ice Face the first physical hit for nothing', () => {
  const disguised = damageRange(battle([mewtwo()], 'Mimikyu').state, 'Shadow Ball')!;
  assert.deepEqual(disguised.percentOfMaxHP, [12.5, 12.5], 'a knockout-sized hit only breaks the disguise');
  assert.equal(disguised.conditionalKO, 'none-sampled');
  assert.match(disguised.mechanicsNotes!.join(' '), /Disguise takes the first hit/);
  // Mold Breaker reads straight through it.
  assert.equal(damageRange(battle([mewtwo('Mold Breaker')], 'Mimikyu').state, 'Shadow Ball')!.conditionalKO, 'all-sampled-rolls');
  const iceFace = battle([mewtwo()], 'Eiscue');
  assert.ok(damageRange(iceFace.state, 'Focus Blast')!.percentOfMaxHP[1] > 50, 'a special hit is not stopped by Ice Face');
});

test('a Pokémon that changes form mid-battle keeps its sets, and a broken Disguise stops protecting', () => {
  const b = battle([mewtwo()], 'Mimikyu');
  b.feed('|detailschange|p2a: Foe|Mimikyu-Busted, L82');
  assert.ok(inferOpponent(b.foe()).candidates.length > 0, 'Mimikyu-Busted is generated as Mimikyu');
  assert.equal(damageRange(b.state, 'Shadow Ball')!.conditionalKO, 'all-sampled-rolls', 'the busted form takes the full hit');
  for (const [from, to] of [['Palafin', 'Palafin-Hero'], ['Eiscue', 'Eiscue-Noice'], ['Morpeko', 'Morpeko-Hangry']]) {
    const formed = battle([mewtwo()], from!);
    formed.feed(`|detailschange|p2a: Foe|${to}, L82`);
    assert.ok(inferOpponent(formed.foe()).candidates.length > 0, `${to} keeps the sets of ${from}`);
  }
});

test('Protect names the Unseen Fist contact moves that go straight through it', () => {
  const b = battle([mew(['Protect', 'Psychic'])], 'Urshifu');
  const through = protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!.theirContactMovesGoThrough!;
  assert.equal(through.ability, 'Unseen Fist');
  assert.ok(through.moves.includes('Close Combat'));
  assert.equal(protectOutlook(battle([mew(['Protect'])], 'Garchomp').state, 'Protect', 'p1',
    battle([mew(['Protect'])], 'Garchomp').me(), undefined)!.theirContactMovesGoThrough, undefined);
});

test('status moves into an absorbing ability, a priority blocker or a cure berry are reported', () => {
  const wisp = viability(battle([mew(['Will-O-Wisp'])], 'Dachsbun'), 'Will-O-Wisp')!;
  assert.match(wisp.possible.map(p => p.reason).join(' '), /Well-Baked Body absorbs Fire moves/);
  // Mold Breaker ignores the absorber, so nothing is claimed.
  const broken = viability(battle([mew(['Will-O-Wisp'], 'Mold Breaker')], 'Dachsbun'), 'Will-O-Wisp');
  assert.ok(!broken?.possible.some(p => /Well-Baked Body/.test(p.reason)));
  const sucker = viability(battle([mew(['Sucker Punch'])], 'Tsareena'), 'Sucker Punch')!;
  assert.match(sucker.possible.map(p => p.reason).join(' '), /Queenly Majesty blocks moves with increased priority/);
  const lum = battle([mew(['Toxic'])], 'Flygon');
  assert.match(viability(lum, 'Toxic')!.possible.map(p => p.reason).join(' '), /Lum Berry cures it/);
  lum.feed('|-enditem|p2a: Foe|Lum Berry|[eat]');
  assert.ok(!viability(lum, 'Toxic')?.possible.some(p => /Lum Berry/.test(p.reason)), 'an eaten berry cures nothing');
});

test('Intimidate lands per sampled set: lowered, unmoved, or turned into a boost', () => {
  assert.deepEqual(intimidateResponse('Rough Skin', '', false), { boosts: { atk: -1 } });
  assert.deepEqual(intimidateResponse('Defiant', '', false), { boosts: { atk: 1 }, because: 'Defiant' });
  assert.deepEqual(intimidateResponse('Competitive', '', false), { boosts: { atk: -1, spa: 2 }, because: 'Competitive' });
  assert.deepEqual(intimidateResponse('Clear Body', '', false), { boosts: {}, because: 'Clear Body' });
  assert.deepEqual(intimidateResponse('Defiant', 'Clear Amulet', false), { boosts: {}, because: 'Clear Amulet' });
  assert.deepEqual(intimidateResponse('Defiant', '', true), { boosts: {}, because: 'Substitute' });
});

test('our Intimidate switch-in takes the hit from their lowered Attack', () => {
  const threat = (ability: string) => {
    const b = battle([mew(['Psychic']), ours('Gyarados', 80, ['Waterfall'], ability, 'Leftovers', 'Water')], 'Garchomp');
    return incomingThreats(b.state, b.state.sides.p1.team[1]!, 'p1')!;
  };
  const intimidating = threat('Intimidate'), plain = threat('Moxie');
  assert.ok(intimidating.worstCasePercentOfMaxHP! < plain.worstCasePercentOfMaxHP!, 'the lowered Attack hits for less');
  assert.deepEqual(onEntry(intimidating), [{ theirAttackStage: -1, probability: 1 }]);
  assert.equal(onEntry(plain), undefined);
  // Staying in is not arriving, so the Pokémon already out does not Intimidate again.
  const b = battle([ours('Gyarados', 80, ['Waterfall'], 'Intimidate', 'Leftovers', 'Water')], 'Garchomp');
  assert.equal(onEntry(incomingThreats(b.state, b.me(), 'p1')!), undefined);
});

test('their arriving Intimidate lowers our damage in the switch read, unless our ability stops it', () => {
  const read = (ability: string) => {
    const b = battle([ours('Garchomp', 80, ['Stone Edge'], ability, 'Life Orb', 'Ground')], 'Toxapex');
    b.feed('|switch|p2a: Bench|Arcanine, L80|100/100'); b.feed('|switch|p2a: Foe|Toxapex, L82|100/100'); b.feed('|turn|2');
    return switchPunish(b.state, b.me(), 'p1', ['Stone Edge'])!.likelyToComeIn.find(x => x.species === 'Arcanine')!;
  };
  const lowered = read('Rough Skin'), unmoved = read('Clear Body');
  assert.deepEqual(lowered.intimidatesUsOnArrival, { probability: 1, ourAttackStageAfter: -1 });
  assert.equal(unmoved.intimidatesUsOnArrival!.because, 'Clear Body');
  assert.ok(lowered.ourMoveDamage['Stone Edge']!.percentOfItsMaxHP[1] < unmoved.ourMoveDamage['Stone Edge']!.percentOfItsMaxHP[1]);
});

test('Thunderclap is priced like Sucker Punch, and knockout boosts are named', () => {
  const b = battle([mew(['Thunderclap'])], 'Garchomp');
  assert.match(suckerOutlook(b.state, 'p1', 'Thunderclap')!.failsUnless, /damaging move/);
  assert.deepEqual(knockoutBoosts(battle([mew(['Psychic'])], 'Magearna').foe())!.map(x => x.ability), ['Soul-Heart']);
  assert.equal(knockoutBoosts(battle([mew(['Psychic'])], 'Garchomp').foe()), null);
});

test('Weak Armor warns on a physical hit even without contact, while contact effects require contact', () => {
  const b = battle([mew(['Earthquake', 'Psychic', 'Drain Punch'])], 'Armarouge');
  const request = parseChoiceRequest(JSON.stringify(b.payload(2, b.me().exactHP!.max)))!;
  const features = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'minimal');
  const quake = features.actions.find(action => action.label === 'Earthquake') as { triggersTheirAbility?: { ability: string }[] };
  assert.equal(quake.triggersTheirAbility?.[0]?.ability, 'Weak Armor', 'the warning survives a compact decision payload');
  b.foe().ability = 'Weak Armor';
  const armor = reactiveAbilityRisks(b.foe(), 'Earthquake')!;
  assert.deepEqual(armor.map(x => x.ability), ['Weak Armor']);
  assert.match(armor[0]!.effect, /Speed can rise two stages/);
  assert.equal(reactiveAbilityRisks(b.foe(), 'Psychic'), null);
  b.foe().ability = 'Flame Body';
  assert.equal(reactiveAbilityRisks(b.foe(), 'Earthquake'), null);
  assert.equal(reactiveAbilityRisks(b.foe(), 'Drain Punch')![0]!.ability, 'Flame Body');
  assert.equal(reactiveAbilityRisks(b.foe(), 'Drain Punch', false), null);
  b.foe().ability = 'Cursed Body';
  assert.equal(reactiveAbilityRisks(b.foe(), 'Psychic')![0]!.trigger, 'damaging hit');
  b.foe().ability = 'Cute Charm';
  assert.equal(reactiveAbilityRisks(b.foe(), 'Psychic'), null);
  assert.equal(reactiveAbilityRisks(b.foe(), 'Drain Punch')![0]!.trigger, 'contact');
});

test('accuracy is the one this move actually has here, and Serene Grace doubles secondary chances', () => {
  const user = (ability: string, item = '') => battle([ours('Mew', 80, ['Hurricane'], ability, item, 'Psychic')], 'Garchomp').me();
  assert.equal(moveEffect('Hurricane', 300, 'RainDance')!.accuracyPercentNow, 'cannot-miss');
  assert.equal(moveEffect('Thunder', 300, 'SunnyDay')!.accuracyPercentNow, 50);
  assert.equal(moveEffect('Blizzard', 300, 'Snow')!.accuracyPercentNow, 'cannot-miss');
  assert.equal(moveEffect('Hurricane', 300, null)!.accuracyPercentNow, undefined, 'unchanged accuracy is not repeated');
  assert.equal(moveEffect('Hurricane', 300, 'RainDance', user('Pressure', 'Utility Umbrella'))!.accuracyPercentNow, undefined,
    'Utility Umbrella shields its holder from the rain as well');
  assert.equal(moveEffect('Stone Edge', 300, null, user('Hustle'))!.accuracyPercentNow, 64);
  assert.deepEqual(moveEffect('Air Slash', 300, null, user('Serene Grace'))!.secondaryChancePercent, [60]);
  assert.deepEqual(moveEffect('Air Slash', 300, null, user('Pressure'))!.secondaryChancePercent, [30]);
});

test('Liquid Ooze turns our drain into damage, unless Magic Guard stops it', () => {
  const b = battle([ours('Mew', 80, ['Giga Drain', 'Leech Seed'], 'Synchronize', 'Leftovers', 'Psychic')], 'Tentacruel');
  assert.equal(drainReversal(b.foe(), 'Giga Drain', b.me())!.ability, 'Liquid Ooze');
  assert.match(drainReversal(b.foe(), 'Leech Seed', b.me())!.what, /each turn of seeding/);
  assert.equal(drainReversal(b.foe(), 'Psychic', b.me()), null, 'a move that drains nothing is unaffected');
  const guarded = battle([ours('Clefable', 80, ['Draining Kiss'], 'Magic Guard', 'Life Orb', 'Fairy')], 'Tentacruel');
  assert.equal(drainReversal(guarded.foe(), 'Draining Kiss', guarded.me()), null);
});

test('Truant loafs the turn after it acts, and that is stated as a schedule, not a gamble', () => {
  const b = battle([mew(['Psychic'])], 'Slaking');
  assert.equal(statusRisk(b.foe(), b.state.turn)!.truant, 'acts this turn, loafs next turn');
  b.feed('|move|p2a: Foe|Double-Edge|p1a: Mew'); b.feed('|turn|2');
  const loafing = statusRisk(b.foe(), b.state.turn)!;
  assert.equal(loafing.chanceItActsAtAllPercent, 0);
  assert.equal(loafing.thisIsAGambleNotAPlan, false, 'a certainty is not a gamble');
  b.feed('|cant|p2a: Foe|ability: Truant'); b.feed('|turn|3');
  assert.equal(statusRisk(b.foe(), b.state.turn)!.truant, 'acts this turn, loafs next turn');
  // A turn stopped by paralysis after Truant has run still counts as the turn it allowed.
  b.feed('|cant|p2a: Foe|par'); b.feed('|turn|4');
  assert.equal(statusRisk(b.foe(), b.state.turn)!.truant, 'loafs this turn, acts next turn');
});

test('a draining attack at full HP is not reported as accomplishing nothing', () => {
  // Drain moves carry the heal flag, which once put Drain Punch beside Recover as a wasted turn at full HP.
  const b = battle([ours('Mew', 80, ['Drain Punch', 'Recover'], 'Synchronize', 'Leftovers', 'Psychic')], 'Garchomp');
  assert.equal(b.me().hpPercent, 100);
  assert.ok(!viability(b, 'Drain Punch')?.certain.some(r => /restores nothing/.test(r)), 'the punch still lands');
  assert.match(viability(b, 'Recover')!.certain.join(' '), /restores nothing/, 'a pure heal at full HP is still wasted');
});

import { lockedIntoImmunity } from '../src/strategy/dominance.js';
import { extractFeatures } from '../src/strategy/features.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';

/** Terrakion after a Close Combat, with the request offering only that move, as a Choice lock does. */
function locked(foe: string, item = 'Choice Band') {
  const roster = [ours('Terrakion', 79, ['Close Combat', 'Stone Edge', 'Earthquake'], 'Justified', item, 'Ground'),
    ours('Magearna', 77, ['Flash Cannon'], 'Soul-Heart', 'Leftovers', 'Water')];
  const b = battle(roster, foe);
  b.feed('|move|p1a: Terrakion|Close Combat|p2a: Foe'); b.feed('|turn|2');
  const payload = b.payload(3, roster[0]!.maxHP, 0);
  for (const m of payload.active[0]!.moves) if (m.id !== 'closecombat') Object.assign(m, { disabled: true });
  const request = parseChoiceRequest(JSON.stringify(payload))!;
  return { b, input: { state: b.state, legalActions: generateLegalActions(request), request } };
}

test('a Choice lock into a move the target is immune to is skipped for a switch', () => {
  const { input } = locked('Sinistcha');
  const skipped = lockedIntoImmunity(input);
  assert.ok(skipped.size > 0, 'Close Combat into a Ghost type is a free turn for them');
  assert.match([...skipped.values()][0]!.reason, /locked into Close Combat by its Choice Band, and Sinistcha takes nothing from it/);
  assert.ok(input.legalActions.filter(a => a.kind === 'switch').every(a => !skipped.has(a.id)), 'switches are never skipped');
  assert.equal(extractFeatures(input, 'reduced').ourChoiceLock?.move, 'Close Combat');
  // A resisted hit is still damage: staying in to chip is a judgement, not a provable error.
  assert.equal(lockedIntoImmunity(locked('Munkidori').input).size, 0);
});

test('each voluntary switch is priced against the attack aimed at the Pokémon we withdraw', () => {
  const roster = [ours('Ogerpon', 80, ['Ivy Cudgel'], 'Defiant', '', 'Grass'),
    ours('Hoopa', 85, ['Psyshock'], 'Magician', 'Choice Specs', 'Psychic'),
    ours('Magearna', 77, ['Flash Cannon'], 'Soul-Heart', 'Leftovers', 'Water')];
  const b = battle(roster, 'Glastrier');
  const request = parseChoiceRequest(JSON.stringify(b.payload(2, roster[0]!.maxHP, 0)))!;
  const f = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'reduced');
  assert.equal(f.switchTurnAttack, f.incomingThreatIfWeStayIn!.damagingMoves[0]!.move, 'the attack that threatens Ogerpon');
  // Actions are a union of move and switch shapes; only switches carry this field.
  const hit = (species: string) => (f.actions.find(a => a.label.includes(species)) as { takesSwitchTurnAttack?: [number, number] }).takesSwitchTurnAttack!;
  assert.ok(hit('Magearna')[1] < hit('Hoopa')[1], 'Steel resists the Ice attack aimed at the Grass type');
});

import { afterTerastallizing, teraAlsoRaises } from '../src/strategy/forme.js';
import { defensiveTera } from '../src/strategy/projection.js';
import { turnOrder } from '../src/strategy/speed.js';

test('Ogerpon\'s Tera raises its mask\'s stat that turn, counted once', () => {
  const teal = battle([ours('Ogerpon', 80, ['Ivy Cudgel'], 'Defiant', '', 'Grass')], 'Dragapult');
  const projected = afterTerastallizing(teal.me(), 'Grass');
  assert.equal(projected.species, 'Ogerpon-Teal-Tera');
  assert.equal(projected.boosts.spe, 1);
  assert.equal(teraAlsoRaises(teal.me(), 'Grass'), 'Speed +1 from Embody Aspect (Teal), this turn');
  assert.equal(turnOrder(teal.state, teal.me(), 'Ivy Cudgel')!.order, 'theirs-first');
  assert.equal(turnOrder(teal.state, projected, 'Ivy Cudgel')!.order, 'ours-first', 'the Speed boost wins the turn');
  const flame = () => battle([ours('Ogerpon-Hearthflame', 80, ['Ivy Cudgel'], 'Mold Breaker', 'Hearthflame Mask', 'Fire')], 'Garchomp');
  const b = flame();
  const plain = damageRange(b.state, 'Ivy Cudgel')!.percentOfMaxHP[1], tera = damageRange(b.state, 'Ivy Cudgel', 'Fire')!.percentOfMaxHP[1];
  // Tera Fire and one stage of Attack; the calculator's own Embody Aspect boost is not added on top.
  assert.ok(tera / plain > 1.9 && tera / plain < 2.1, `Tera multiplies by about 2, got ${(tera / plain).toFixed(2)}`);
  // Once it really has Terastallised, the log's +1 is the only one.
  const done = flame();
  done.feed('|-terastallize|p1a: Ogerpon-Hearthflame|Fire');
  done.feed('|detailschange|p1a: Ogerpon-Hearthflame|Ogerpon-Hearthflame-Tera, L80, tera:Fire');
  done.feed('|-boost|p1a: Ogerpon-Hearthflame|atk|1|[from] ability: Embody Aspect (Hearthflame)');
  const me = done.me();
  me.ability = 'Embody Aspect (Hearthflame)';
  assert.equal(me.boosts.atk, 1);
  assert.ok(Math.abs(damageRange(done.state, 'Ivy Cudgel')!.percentOfMaxHP[1] - tera) < 1.5, 'the same damage as the projection');
});

test('Terapagos Terastallises into its Stellar form, with its HP and without Tera Shell', () => {
  const roster = [ours('Terapagos-Terastal', 80, ['Tera Starstorm'], 'Tera Shell', 'Leftovers', 'Stellar')];
  const b = battle(roster, 'Garchomp');
  b.feed(b.request(2, Math.round(roster[0]!.maxHP * 0.6), 0));
  const stellar = afterTerastallizing(b.me(), 'Stellar');
  assert.equal(stellar.species, 'Terapagos-Stellar');
  assert.equal(stellar.ability, 'Teraform Zero');
  assert.ok(stellar.exactHP!.max > b.me().exactHP!.max, '160 base HP against 95');
  const def = defensiveTera(b.state, b.me(), 'p1', 'Stellar')!;
  assert.ok(def.worstIncomingPercentBecomes < def.wasBefore, 'below full HP, Tera Shell is inactive and the Stellar HP only helps');
});

import { teraDependents } from '../src/strategy/teamTactics.js';

test('Tera\'s costs are stated: a type that doubles their hit, and teammates whose sets need it', () => {
  const roster = [ours('Lurantis', 88, ['Superpower', 'Leaf Storm'], 'Contrary', 'Leftovers', 'Fighting'),
    ours('Spectrier', 76, ['Shadow Ball', 'Tera Blast'], 'Grim Neigh', 'Leftovers', 'Fighting'),
    ours('Ting-Lu', 76, ['Earthquake'], 'Vessels of Ruin', 'Leftovers', 'Poison')];
  const b = battle(roster, 'Girafarig');
  // Grass takes Psychic neutrally; Tera Fighting is in place before their move and doubles it.
  const def = defensiveTera(b.state, b.me(), 'p1', 'Fighting')!;
  assert.equal(def.makesUsWeakerToTheirAttack, true);
  assert.ok(def.worstIncomingPercentBecomes > def.wasBefore * 1.8);
  assert.deepEqual(teraDependents(b.state, 'p1').map(x => x.species), ['Spectrier'], 'Ting-Lu does not depend on it');
  const payload = b.payload(2, roster[0]!.maxHP, 0);
  const withTera = { ...payload, active: [{ ...payload.active[0]!, canTerastallize: 'Fighting' }] };
  const input = (p: object) => { const request = parseChoiceRequest(JSON.stringify(p))!; return { state: b.state, legalActions: generateLegalActions(request), request }; };
  assert.match(extractFeatures(input(withTera), 'reduced').teraIsAlsoNeededBy![0]!.why, /Tera Blast is Fighting only after Terastallising/);
  assert.equal(extractFeatures(input(payload), 'reduced').teraIsAlsoNeededBy, undefined, 'once Tera is spent there is nothing to protect');
});

import { switchingPattern } from '../src/strategy/prediction.js';

test('the opponent\'s switching is logged and read back as a pattern, with our moves priced into its arrival', () => {
  const rotom = ours('Rotom-Heat', 83, ['Overheat', 'Discharge'], 'Levitate', 'Leftovers', 'Electric');
  const b = battle([rotom, ours('Latios', 78, ['Draco Meteor'], 'Levitate', 'Soul Dew', 'Steel')], 'Dewgong');
  const swap = (turn: number, to: string) => { b.feed(`|switch|p2a: ${to}|${to}, L85|100/100`); b.feed(`|turn|${turn}`); };
  // Dewgong and Excadrill trade places each turn against Rotom-Heat, one for each of its attacking types.
  b.feed('|switch|p2a: Excadrill|Excadrill, L85|100/100'); b.feed('|turn|2');
  swap(3, 'Dewgong'); swap(4, 'Excadrill'); swap(5, 'Dewgong');
  const log = b.state.sides.p2.switches!.filter(x => x.turn >= 1);
  assert.deepEqual(log.map(x => `${x.from}->${x.to}`), ['Dewgong->Excadrill', 'Excadrill->Dewgong', 'Dewgong->Excadrill', 'Excadrill->Dewgong']);
  assert.ok(log.every(x => x.facing === 'Rotom-Heat' && !x.afterFaint));
  const p = switchingPattern(b.state, b.me(), 'p1', ['Overheat', 'Discharge'])!;
  assert.equal(p.theyHaveSwitchedOnEachOfTheLast, 4);
  assert.equal(p.fromThisOneTheyHaveGoneTo, 'Excadrill');
  const into = p.ourMovesIntoIt as Record<string, number[]>;
  assert.deepEqual(into['Discharge'], [0, 0], 'Electric does nothing to the Ground type they keep bringing in');
  assert.ok(into['Overheat']![1]! > 30, 'while Overheat hits it hard');
});

test('a fainted switch destination cannot hide the living Ground-type answer', () => {
  const b = battle([ours('Rotom', 88, ['Thunderbolt', 'Trick'], 'Levitate', 'Choice Scarf', 'Ghost')], 'Noctowl');
  b.feed('|switch|p2a: Rotom-Fan|Rotom-Fan, L86|100/100');
  b.feed('|switch|p2a: Alcremie|Alcremie, L90, F|100/100');
  b.feed('|switch|p2a: Noctowl|Noctowl, L95, M|100/100');
  const theirs = b.state.sides.p2;
  const fan = theirs.team.find(p => p.species === 'Rotom-Fan')!;
  fan.fainted = true; fan.hpPercent = 0;
  const alcremie = theirs.team.find(p => p.species === 'Alcremie')!;
  alcremie.terastallized = true; alcremie.teraType = 'Ground';
  const switched = (turn: number, to: string) => ({ turn, from: 'Noctowl', to, facing: 'Rotom', afterFaint: false, dragged: false, via: null });
  theirs.switches = [switched(10, 'Rotom-Fan'), switched(18, 'Rotom-Fan'),
    { ...switched(26, 'Noctowl'), from: 'Alcremie', facing: 'Arboliva' },
    switched(28, 'Alcremie'),
    { ...switched(30, 'Noctowl'), from: 'Alcremie', facing: 'Arboliva' }];
  b.state.turn = 32;
  const pattern = switchingPattern(b.state, b.me(), 'p1', ['Thunderbolt'])!;
  assert.equal(pattern.fromThisOneTheyHaveGoneTo, 'Alcremie');
  assert.deepEqual((pattern.ourMovesIntoIt as Record<string, number[]>)['Thunderbolt'], [0, 0]);
});

test('a free replacement after a knockout is not counted as a chosen switch', () => {
  const b = battle([ours('Mew', 80, ['Psychic'], 'Synchronize', 'Leftovers', 'Psychic')], 'Dewgong');
  b.feed('|faint|p2a: Dewgong'); b.feed('|switch|p2a: Excadrill|Excadrill, L85|100/100'); b.feed('|turn|2');
  assert.equal(b.state.sides.p2.switches!.at(-1)!.afterFaint, true);
  assert.equal(switchingPattern(b.state, b.me(), 'p1', ['Psychic']), null, 'nothing chosen, so no pattern');
});

import { redundantTera } from '../src/strategy/dominance.js';

test('Tera spent only for surplus damage on a certain knockout is skipped, but not Tera that protects us', () => {
  const setup = (roster: ReturnType<typeof ours>[], foe: string, foeHP: number, tera: string) => {
    const b = battle(roster, foe);
    b.feed(`|-damage|p2a: Foe|${foeHP}/100`);
    const payload = b.payload(2, roster[0]!.maxHP, 0);
    const request = parseChoiceRequest(JSON.stringify({ ...payload, active: [{ ...payload.active[0]!, canTerastallize: tera }] }))!;
    return { b, input: { state: b.state, legalActions: generateLegalActions(request), request } };
  };
  const medicham = () => [ours('Medicham', 86, ['Close Combat', 'Zen Headbutt'], 'Pure Power', 'Choice Scarf', 'Fighting')];
  const low = setup(medicham(), 'Rillaboom', 40, 'Fighting');
  const skipped = redundantTera(low.input);
  const teraClose = low.input.legalActions.find(a => a.label === 'Close Combat + Tera Fighting')!;
  assert.ok(skipped.has(teraClose.id), 'Close Combat already knocks it out without Tera');
  assert.match(skipped.get(teraClose.id)!.reason, /already knocks out Rillaboom at every sampled roll without Terastallising/);
  assert.ok(![...skipped.keys()].some(k => !k.endsWith('terastallize')), 'only Tera versions are ever skipped');
  // At full health the plain move is not a certain knockout, so Tera may be buying one.
  assert.equal(redundantTera(setup(medicham(), 'Rillaboom', 100, 'Fighting').input).size, 0);
  // Tera Electric removes Rotom-Heat's Water weakness, which is worth having even on a knockout turn.
  const rotom = setup([ours('Rotom-Heat', 83, ['Discharge', 'Overheat'], 'Levitate', 'Leftovers', 'Electric')], 'Dewgong', 15, 'Electric');
  assert.equal(damageRange(rotom.b.state, 'Discharge')!.conditionalKO, 'all-sampled-rolls');
  assert.equal(redundantTera(rotom.input).size, 0);
});

import { flinchRisk } from '../src/strategy/risk.js';
import { movePriority } from '../src/strategy/speed.js';

test('Gale Wings priority is known from HP, which is public', () => {
  const roster = [ours('Talonflame', 86, ['Brave Bird', 'Overheat'], 'Gale Wings', 'Heavy-Duty Boots', 'Flying')];
  const b = battle(roster, 'Meowstic-F');
  assert.equal(movePriority(b.state, b.me(), 'Brave Bird'), 1, 'full HP');
  assert.equal(movePriority(b.state, b.me(), 'Overheat'), 0, 'only Flying moves');
  b.feed(b.request(2, roster[0]!.maxHP - 10, 0));
  assert.equal(movePriority(b.state, b.me(), 'Brave Bird'), 0, 'lost the moment it is not full');
});

test('a faster opponent\'s flinching move is a turn-loss risk, and paralysis compounds it', () => {
  const roster = [ours('Gothitelle', 88, ['Thunderbolt'], 'Shadow Tag', 'Leftovers', 'Flying')];
  const b = battle(roster, 'Registeel');
  b.feed('|move|p2a: Foe|Iron Head|p1a: Gothitelle');
  b.feed('|-status|p1a: Gothitelle|par'); b.feed('|turn|2');
  const risk = flinchRisk(b.state, b.me(), 'p1')!;
  assert.equal(risk.moves.find(m => m.move === 'Iron Head')!.flinchChancePercent, 30);
  assert.equal(risk.ifTheyUseTheWorstWeActPercent, 52.5, '0.75 to act through paralysis times 0.7 not flinched');
  assert.equal(risk.aSwitchCannotBeLost, true);
  // Inner Focus cannot be flinched at all.
  const focused = battle([ours('Gothitelle', 88, ['Thunderbolt'], 'Inner Focus', 'Leftovers', 'Flying')], 'Registeel');
  focused.feed('|move|p2a: Foe|Iron Head|p1a: Gothitelle'); focused.feed('|-status|p1a: Gothitelle|par'); focused.feed('|turn|2');
  assert.equal(flinchRisk(focused.state, focused.me(), 'p1'), null);
});

test('a pairing that has stalled says so: they hold their HP while ours drains', () => {
  const roster = [mew(['Psychic']), ours('Klefki', 88, ['Play Rough', 'Thunder Wave'], 'Prankster', 'Leftovers', 'Water')];
  const b = battle(roster, 'Fezandipiti');
  // Klefki meets a Fezandipiti already down to 40%, which then Roosts back while Play Rough barely scratches it.
  b.feed('|-damage|p2a: Foe|40/100');
  b.feed(`|switch|p1a: Klefki|Klefki, L88|${roster[1]!.maxHP}/${roster[1]!.maxHP}`); b.feed('|turn|2');
  const hp = (ours: number, theirs: number, turn: number) => {
    b.feed(b.request(turn, Math.round(roster[1]!.maxHP * ours / 100), 1));
    b.feed(`|-damage|p2a: Foe|${theirs}/100`); b.feed(`|turn|${turn}`);
  };
  hp(85, 70, 3); hp(70, 55, 4); hp(55, 60, 5);
  const request = parseChoiceRequest(JSON.stringify(b.payload(9, Math.round(roster[1]!.maxHP * 0.55), 1)))!;
  const f = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'minimal');
  assert.deepEqual(f.thisMatchupSoFar, { turns: 3, ourHPChange: -45, theirHPChange: 20, theyAreNotLosingGround: true });
});

test('Tera that stops the likely attacks from knocking us out is not redundant, even when a rarer hit stays the worst', () => {
  // Beartic at 47/321 and slower than Regieleki, which has shown Volt Switch. Earthquake knocks Regieleki out with or
  // without Tera Ground, but only Tera Ground lets Beartic live to use it; Explosion, unaffected, stays the worst hit.
  const roster = [ours('Beartic', 91, ['Icicle Crash', 'Close Combat', 'Aqua Jet', 'Earthquake'], 'Slush Rush', 'Choice Band', 'Ground')];
  const b = battle(roster, 'Regieleki', 79);
  b.feed('|move|p2a: Foe|Volt Switch|p1a: Beartic'); b.feed(`|-damage|p1a: Beartic|47/${roster[0]!.maxHP}`); b.feed('|turn|2');
  const payload = b.payload(2, 47, 0);
  const request = parseChoiceRequest(JSON.stringify({ ...payload, active: [{ ...payload.active[0]!, canTerastallize: 'Ground' }] }))!;
  const input = { state: b.state, legalActions: generateLegalActions(request), request };
  assert.equal(damageRange(b.state, 'Earthquake')!.conditionalKO, 'all-sampled-rolls');
  const def = defensiveTera(b.state, b.me(), 'p1', 'Ground')!;
  assert.ok(def, 'Tera Ground changes what we take even though the worst hit does not move');
  assert.ok(def.stopsTheseFromKnockingUsOut!.includes('Volt Switch'), JSON.stringify(def));
  assert.equal(redundantTera(input).size, 0);
});

test('a lower worst hit is not protection when the new type lets another attack knock us out', () => {
  // Latias at 18%, slower than Regieleki. Plain, it resists the revealed Thunderbolt and survives to Draco Meteor, a
  // certain knockout; Tera Steel resists the rarer Explosion instead, which still knocks it out, and turns Thunderbolt
  // into a knockout too.
  const roster = [ours('Latias', 79, ['Recover', 'Draco Meteor', 'Psyshock', 'Calm Mind'], 'Levitate', 'Soul Dew', 'Steel')];
  const b = battle(roster, 'Regieleki', 79);
  const hp = Math.round(roster[0]!.maxHP * 0.176);
  b.feed('|move|p2a: Foe|Thunderbolt|p1a: Latias'); b.feed(`|-damage|p1a: Latias|${hp}/${roster[0]!.maxHP}`);
  b.feed('|-boost|p1a: Latias|spd|1'); b.feed('|-damage|p2a: Foe|59/100'); b.feed('|turn|2');
  const payload = b.payload(2, hp, 0);
  const request = parseChoiceRequest(JSON.stringify({ ...payload, active: [{ ...payload.active[0]!, canTerastallize: 'Steel' }] }))!;
  const input = { state: b.state, legalActions: generateLegalActions(request), request };
  const def = defensiveTera(b.state, b.me(), 'p1', 'Steel')!;
  assert.ok(def.worstIncomingPercentBecomes < def.wasBefore, 'Explosion, the worst hit, is resisted');
  assert.ok(def.letsTheseKnockUsOut!.includes('Thunderbolt'), JSON.stringify(def));
  const teraDraco = input.legalActions.find(a => a.label === 'Draco Meteor + Tera Steel')!;
  assert.match(redundantTera(input).get(teraDraco.id)!.reason, /lets Thunderbolt( and Volt Switch)? knock us out first/);
});

test('Tera that buys no knockout and makes us weaker to the incoming hit is skipped', () => {
  const roster = [ours('Carbink', 90, ['Body Press', 'Moonblast'], 'Sturdy', 'Chesto Berry', 'Fighting')];
  const b = battle(roster, 'Hoopa-Unbound');
  const payload = b.payload(2, roster[0]!.maxHP, 0);
  const request = parseChoiceRequest(JSON.stringify({ ...payload, active: [{ ...payload.active[0]!, canTerastallize: 'Fighting' }] }))!;
  const skipped = redundantTera({ state: b.state, legalActions: generateLegalActions(request), request });
  const teraPress = generateLegalActions(request).find(a => a.label === 'Body Press + Tera Fighting')!;
  assert.match(skipped.get(teraPress.id)!.reason, /improves no knockout odds with Body Press and raises the worst hit on us/);
});

import { futileProtect } from '../src/strategy/dominance.js';

test('a crash move warns when the target may Protect, and a third Protect in a row is skipped', () => {
  assert.match(String(moveEffect('Supercell Slam', 300)!.crashesForHalfOurHPIf), /blocked by Protect/);
  const b = battle([ours('Zebstrika', 88, ['Supercell Slam', 'Overheat'], 'Sap Sipper', 'Life Orb', 'Electric')], 'Alomomola');
  b.feed('|move|p2a: Foe|Protect|p2a: Foe'); b.feed('|turn|2');
  assert.match(viability(b, 'Supercell Slam')!.possible.map(p => p.reason).join(' '), /if they use Protect this crashes and costs half our max HP/);
  const m = battle([ours('Morpeko', 88, ['Protect', 'Aura Wheel'], 'Hunger Switch', 'Leftovers', 'Electric')], 'Mamoswine');
  for (const turn of [2, 3]) { m.feed('|move|p1a: Morpeko|Protect|p1a: Morpeko'); m.feed(`|turn|${turn}`); }
  const request = parseChoiceRequest(JSON.stringify(m.payload(9, 100, 0)))!;
  const skipped = futileProtect({ state: m.state, legalActions: generateLegalActions(request), request });
  assert.match([...skipped.values()][0]!.reason, /protected 2 turns in a row, so this succeeds about 11% of the time/);
});

import { saltCureOutlook } from '../src/strategy/conditional.js';
import { asleepChanceOfMove } from '../src/strategy/risk.js';

test('Salt Cure is priced by its chip, a quarter a turn against Water and Steel', () => {
  const b = battle([ours('Garganacl', 80, ['Salt Cure'], 'Purifying Salt', 'Leftovers', 'Water')], 'Suicune');
  assert.deepEqual(saltCureOutlook(b.foe()), { thenEachTurnPercentOfTheirMaxHP: 25, untilTheySwitch: true, noBoostRecoveryOrRestRemovesIt: true });
  assert.equal(saltCureOutlook(battle([mew(['Psychic'])], 'Garchomp').foe())!.thenEachTurnPercentOfTheirMaxHP, 12.5);
  b.feed('|-start|p2a: Foe|Salt Cure'); b.feed('|turn|2');
  assert.deepEqual(saltCureOutlook(b.foe()), { alreadySaltCured: true });
});

test('a sleeping Sleep Talk user still acts, and a fresh Rester is weighed by the sets that carry Sleep Talk', () => {
  const b = battle([mew(['Psychic'])], 'Suicune');
  b.feed('|move|p2a: Foe|Rest|p2a: Foe'); b.feed('|-status|p2a: Foe|slp|[from] move: Rest'); b.feed('|turn|2');
  // Rest just used, Sleep Talk not shown: every random-battle Rest set carries it, so Scald on a switch is one in three.
  assert.equal(asleepChanceOfMove(b.foe(), 'Scald'), 33.3);
  b.feed('|move|p2a: Foe|Sleep Talk|p2a: Foe'); b.feed('|move|p2a: Foe|Calm Mind|p2a: Foe|[from]Sleep Talk');
  b.feed('|move|p2a: Foe|Scald|p1a: Mew|[from]Sleep Talk'); b.feed('|turn|3');
  assert.equal(b.foe().sleepTurns, 1, 'Sleep Talk spends a turn of sleep without a cant line');
  const risk = statusRisk(b.foe(), b.state.turn)!;
  assert.equal(risk.chanceItActsAtAllPercent, 100, 'it acts every turn through Sleep Talk');
  const talk = (risk as { sleep?: { actsThroughSleepTalk?: { picks: string[]; restFailsWhileAsleep: boolean } } }).sleep!.actsThroughSleepTalk!;
  assert.deepEqual(talk.picks.sort(), ['Calm Mind', 'Rest', 'Scald']);
  assert.equal(talk.restFailsWhileAsleep, true);
  // Without Sleep Talk, a Rest sleeper that cannot wake gives a free switch.
  const lone = battle([mew(['Psychic'])], 'Snorlax');
  lone.feed('|move|p2a: Foe|Rest|p2a: Foe'); lone.feed('|-status|p2a: Foe|slp|[from] move: Rest'); lone.feed('|move|p2a: Foe|Body Slam|p1a: Mew'); lone.feed('|turn|2');
  lone.foe().knownMoves = [];
  assert.ok(asleepChanceOfMove(lone.foe(), 'Body Slam')! < 34);
});

import { lockedAndLosing } from '../src/strategy/dominance.js';

test('a Choice lock that keeps losing the exchange is skipped for a switch', () => {
  const roster = [mew(['Psychic']), ours('Clawitzer', 88, ['Aura Sphere', 'Dragon Pulse'], 'Mega Launcher', 'Choice Specs', 'Fighting'),
    ours('Malamar', 82, ['Knock Off', 'Superpower'], 'Contrary', 'Leftovers', 'Steel')];
  const b = battle(roster, 'Suicune');
  b.feed('|-damage|p2a: Foe|75/100');
  b.feed(`|switch|p1a: Clawitzer|Clawitzer, L88|${roster[1]!.maxHP}/${roster[1]!.maxHP}`); b.feed('|turn|2');
  const input = (ourHP: number) => {
    const payload = b.payload(9, Math.round(roster[1]!.maxHP * ourHP / 100), 1);
    for (const m of payload.active[0]!.moves) if (m.id !== 'aurasphere') Object.assign(m, { disabled: true });
    const request = parseChoiceRequest(JSON.stringify(payload))!;
    return { state: b.state, legalActions: generateLegalActions(request), request };
  };
  b.feed('|move|p1a: Clawitzer|Aura Sphere|p2a: Foe');
  const turn = (ourHP: number, theirs: number, n: number) => { b.feed(b.request(n, Math.round(roster[1]!.maxHP * ourHP / 100), 1)); b.feed(`|-damage|p2a: Foe|${theirs}/100`); b.feed(`|turn|${n}`); };
  turn(90, 60, 3); turn(80, 90, 4);
  assert.equal(lockedAndLosing(input(80)).size, 0, 'two turns in is too early to call it');
  turn(70, 85, 5);
  const skipped = lockedAndLosing(input(70));
  assert.ok(skipped.size > 0);
  assert.match([...skipped.values()][0]!.reason, /locked into Aura Sphere by its Choice Specs, and over 3 turns Suicune has moved 10% while we moved -30%/);
});

import { needlessGamble } from '../src/strategy/dominance.js';

test('a healthy Pokémon is not staked on a miss when a switch-in takes the knockout for certain', () => {
  const roster = [ours('Jumpluff', 87, ['Acrobatics', 'Strength Sap', 'U-turn', 'Sleep Powder'], 'Infiltrator', '', 'Steel'),
    ours('Wyrdeer', 87, ['Body Slam', 'Psychic Noise', 'Megahorn', 'Earthquake'], 'Intimidate', 'Assault Vest', 'Ground')];
  const b = battle(roster, 'Volcanion', 79);
  const at = (percent: number) => Math.round(roster[0]!.maxHP * percent / 100);
  b.feed('|move|p2a: Foe|Flamethrower|p1a: Jumpluff'); b.feed(`|-damage|p1a: Jumpluff|${at(68)}/${roster[0]!.maxHP}`);
  b.feed('|-damage|p2a: Foe|34/100'); b.feed(b.request(5, at(68))); b.feed('|turn|5');
  const input = (hp: number) => {
    const request = parseChoiceRequest(JSON.stringify(b.payload(5, at(hp))))!;
    return { state: b.state, legalActions: generateLegalActions(request), request };
  };
  const labels = (m: Map<string, unknown>, i: ReturnType<typeof input>) => [...m.keys()].map(k => i.legalActions.find(a => a.id === k)!.label).sort();
  const i = input(68), skipped = needlessGamble(i);
  assert.deepEqual(labels(skipped, i), ['Acrobatics', 'Sleep Powder'], 'the coin flip and the chip that hands them the knockout; Strength Sap and U-turn are left alone');
  assert.match(skipped.get(i.legalActions.find(a => a.label === 'Sleep Powder')!.id)!.reason,
    /Sleep Powder misses 25% of the time, and then Flamethrower knocks Jumpluff out .* while Wyrdeer can come in, take two hits .* Earthquake at every sampled roll/);

  b.feed('|-status|p2a: Foe|slp'); b.state.sides.p2.team[0]!.status = 'slp';
  assert.equal(needlessGamble(input(68)).size, 0, 'asleep, they cannot punish the miss this turn');
  b.state.sides.p2.team[0]!.status = null;
  b.feed(b.request(6, at(40)));
  assert.equal(needlessGamble(input(40)).size, 0, 'below half HP, the active is a fair price for a free switch-in');
});

test('a likely knockout is not blocked for a switch that costs more than the Pokémon it risks', () => {
  // 2687507386: Cinccino's Tail Slap knocked a Toxtricity out 84% of the time and moved first; Jev and the search both
  // chose it (the search at 0.96), and the guard sent Ting-Lu into two 35% hits instead.
  const roster = [ours('Jumpluff', 87, ['Acrobatics', 'Strength Sap', 'U-turn', 'Sleep Powder'], 'Infiltrator', '', 'Steel'),
    ours('Wyrdeer', 87, ['Body Slam', 'Psychic Noise', 'Megahorn', 'Earthquake'], 'Intimidate', 'Assault Vest', 'Ground')];
  const skippedAt = (foePercent: number) => {
    const b = battle(roster, 'Volcanion', 79);
    const at = (percent: number) => Math.round(roster[0]!.maxHP * percent / 100);
    b.feed('|move|p2a: Foe|Flamethrower|p1a: Jumpluff'); b.feed(`|-damage|p1a: Jumpluff|${at(68)}/${roster[0]!.maxHP}`);
    b.feed(`|-damage|p2a: Foe|${foePercent}/100`); b.feed(b.request(5, at(68))); b.feed('|turn|5');
    const request = parseChoiceRequest(JSON.stringify(b.payload(5, at(68))))!;
    const i = { state: b.state, legalActions: generateLegalActions(request), request };
    return [...needlessGamble(i).keys()].map(k => i.legalActions.find(a => a.id === k)!.label).sort();
  };
  assert.deepEqual(skippedAt(26), ['Sleep Powder'], 'Acrobatics knocks a 26% Volcanion out on most rolls, first; a miss by Sleep Powder removes nothing');
  assert.deepEqual(skippedAt(29), ['Acrobatics', 'Sleep Powder'], 'at 29% it almost never does, and the switch is the better price');
});

test('a rampage move reports the chance an unrevealed Pokémon takes nothing from it', () => {
  // 2687511902: Kingdra's Outrage knocked Hydreigon out, and an unrevealed Mimikyu came in immune and set up twice.
  const b = battle([ours('Kingdra', 84, ['Outrage', 'Wave Crash', 'Iron Head', 'Dragon Dance'], 'Sniper', 'Life Orb', 'Steel')], 'Hydreigon', 80);
  const rampage = effectViability(b.state, 'Outrage', b.me(), 'p1', b.foe())!.possible;
  const unseen = rampage.find(p => /5 of their Pokémon are unrevealed and \d+% of the Random Battle pool takes nothing from Outrage/.test(p.reason))!;
  assert.ok(unseen.probability! > 0.1 && unseen.probability! < 0.6, `about one Fairy type in the pool of every sixteen, five times over: ${unseen.probability}`);
  assert.equal(effectViability(b.state, 'Wave Crash', b.me(), 'p1', b.foe()), null, 'a move that does not lock carries no such risk');
  b.state.sides.p2.teamSize = 1;
  assert.ok(!(effectViability(b.state, 'Outrage', b.me(), 'p1', b.foe())?.possible ?? []).some(p => /unrevealed/.test(p.reason)), 'nobody left unseen');
});

test('without a switch-in that wins outright, the gamble stays a judgement call', () => {
  const roster = [ours('Jumpluff', 87, ['Acrobatics', 'Strength Sap', 'U-turn', 'Sleep Powder'], 'Infiltrator', '', 'Steel'),
    ours('Cinderace', 82, ['Pyro Ball', 'U-turn'], 'Libero', 'Choice Band', 'Fire')];
  const b = battle(roster, 'Volcanion', 79);
  const at = (percent: number) => Math.round(roster[0]!.maxHP * percent / 100);
  b.feed('|move|p2a: Foe|Flamethrower|p1a: Jumpluff'); b.feed(`|-damage|p1a: Jumpluff|${at(68)}/${roster[0]!.maxHP}`);
  b.feed('|-damage|p2a: Foe|34/100'); b.feed(b.request(5, at(68))); b.feed('|turn|5');
  const request = parseChoiceRequest(JSON.stringify(b.payload(5, at(68))))!;
  assert.equal(needlessGamble({ state: b.state, legalActions: generateLegalActions(request), request }).size, 0);
});

import { baitedCrash } from '../src/strategy/dominance.js';

test('a Choice-locked crash move is not thrown into the immune switch the opponent has already shown', () => {
  const roster = [ours('Mienshao', 86, ['High Jump Kick'], 'Regenerator', 'Choice Band', 'Fighting'),
    ours('Excadrill', 79, ['Iron Head', 'Earthquake'], 'Mold Breaker', 'Assault Vest', 'Ground')];
  const input = (b: ReturnType<typeof battle>) => {
    const request = parseChoiceRequest(JSON.stringify(b.payload(9, roster[0]!.maxHP)))!;
    return { state: b.state, legalActions: generateLegalActions(request), request };
  };
  // They have gone from Appletun to Hoopa against Mienshao before: the switch is a habit, not a guess.
  const b = battle(roster, 'Appletun', 86);
  b.feed('|-damage|p2a: Foe|29/100'); b.feed('|turn|2');
  b.feed('|switch|p2a: Hoopa|Hoopa, L80|100/100'); b.feed('|turn|3');
  b.feed('|switch|p2a: Foe|Appletun, L86|29/100'); b.feed('|turn|4');
  const skipped = baitedCrash(input(b));
  assert.equal(skipped.size, 1);
  assert.match([...skipped.values()][0]!.reason, /locked into High Jump Kick by its Choice Band.*a switch to Hoopa, which takes nothing from it/);

  // Hoopa led and has never been brought in: they may well let the target fall, so the knockout stands.
  const fresh = battle(roster, 'Hoopa', 80);
  fresh.feed('|switch|p2a: Appletun|Appletun, L86|29/100'); fresh.feed('|turn|2');
  assert.equal(baitedCrash(input(fresh)).size, 0);
});

test('Supercell Slam is held back from a Protect that is ready, and from anything that would knock us out', () => {
  const roster = [ours('Zebstrika', 88, ['Supercell Slam', 'Volt Switch', 'High Horsepower'], 'Sap Sipper', 'Life Orb', 'Electric')];
  const b = battle(roster, 'Alomomola', 88);
  const at = (percent: number) => Math.round(roster[0]!.maxHP * percent / 100);
  const input = (hp: number) => {
    b.feed(b.request(9, at(hp)));
    const request = parseChoiceRequest(JSON.stringify(b.payload(9, at(hp))))!;
    return { state: b.state, legalActions: generateLegalActions(request), request };
  };
  const labels = (i: ReturnType<typeof input>) => [...baitedCrash(i).keys()].map(k => i.legalActions.find(a => a.id === k)!.label);
  b.feed('|move|p2a: Foe|Protect|p2a: Foe'); b.feed('|turn|2');
  assert.deepEqual(labels(input(100)), [], 'a second Protect in a row succeeds a third of the time, so attacking now is the usual answer');
  assert.deepEqual(labels(input(30)), ['Supercell Slam'], 'unless the crash itself would knock us out');
  b.feed('|move|p2a: Foe|Scald|p1a: Zebstrika'); b.feed('|turn|3');
  assert.deepEqual(labels(input(100)), ['Supercell Slam'], 'Protect is ready again, and Supercell Slam is the hit they expect');
});

import { accumulate } from '../src/strategy/calcCore.js';
import { healingOverAKnockout } from '../src/strategy/dominance.js';

test('coverage is measured against the sets still possible, not the prior they started from', () => {
  const target = battle([ours('Clefable', 88, ['Moonblast'], 'Magic Guard', 'Leftovers', 'Steel')], 'Garchomp').foe();
  // Keldeo narrowed to its three Tera Water sets: 13.5% of the prior between them, and every one modelled.
  const rolls = [0.039, 0.066, 0.030].map(probability => ({ min: 93, max: 111, probability }));
  assert.equal(accumulate(rolls, target, 273, 0.135)!.coveredProbabilityMass, undefined, 'all three were modelled');
  assert.equal(accumulate(rolls, target, 273, 0.27)!.coveredProbabilityMass, 0.5, 'half of what was still possible');
  assert.equal(accumulate(rolls, target, 273)!.coveredProbabilityMass, 0.135, 'a caller that passes nothing keeps the old reading');
});

test('a heal that cannot keep up is not taken over a certain knockout', () => {
  const roster = [ours('Clefable', 60, ['Moonblast', 'Moonlight', 'Thunder Wave'], 'Magic Guard', 'Leftovers', 'Steel')];
  const b = battle(roster, 'Garchomp', 88);
  const at = (percent: number) => Math.round(roster[0]!.maxHP * percent / 100);
  const input = (hp: number) => {
    b.feed(b.request(9, at(hp)));
    const request = parseChoiceRequest(JSON.stringify(b.payload(9, at(hp))))!;
    return { state: b.state, legalActions: generateLegalActions(request), request };
  };
  const labels = (i: ReturnType<typeof input>) => [...healingOverAKnockout(i).keys()].map(k => i.legalActions.find(a => a.id === k)!.label).sort();
  b.feed('|move|p2a: Foe|Earthquake|p1a: Clefable'); b.feed(`|-damage|p1a: Clefable|${at(32)}/${roster[0]!.maxHP}`);
  assert.deepEqual(labels(input(32)), [], 'nothing is a certain knockout on a healthy Garchomp');
  b.feed('|-damage|p2a: Foe|17/100'); b.feed('|turn|5');
  const i = input(32);
  assert.deepEqual(labels(i), ['Moonlight'], 'Moonblast and Thunder Wave are left alone');
  assert.match([...healingOverAKnockout(i).values()][0]!.reason, /Moonblast knocks Garchomp out at every sampled roll, and Garchomp's Earthquake takes at least [\d.]+% a hit, more than the 50% Moonlight restores/);
  // Without a revealed attack to outpace it, there is no proof the heal is wasted.
  const quiet = battle(roster, 'Garchomp', 88);
  quiet.feed('|-damage|p2a: Foe|17/100'); quiet.feed('|turn|2');
  quiet.feed(quiet.request(9, at(32)));
  const request = parseChoiceRequest(JSON.stringify(quiet.payload(9, at(32))))!;
  assert.equal(healingOverAKnockout({ state: quiet.state, legalActions: generateLegalActions(request), request }).size, 0);
});

test('a heal after their hit restores from the lower HP, and a recoil knockout is not a free one', () => {
  // Ho-Oh at 56%, slower than a burned +1 Annihilape at 35% that has taken two hits (2688231548).
  const roster = [ours('Ho-Oh', 71, ['Brave Bird', 'Recover', 'Earthquake', 'Sacred Fire'], 'Regenerator', 'Heavy-Duty Boots', 'Ground')];
  const setup = (hpPercent: number, moves?: string[]) => {
    const team = moves ? [ours('Ho-Oh', 71, moves, 'Regenerator', 'Heavy-Duty Boots', 'Ground')] : roster;
    const b = battle(team, 'Annihilape', 76);
    const hp = Math.round(team[0]!.maxHP * hpPercent / 100);
    b.feed('|move|p2a: Foe|Rage Fist|p1a: Ho-Oh'); b.feed(`|-damage|p1a: Ho-Oh|${hp}/${team[0]!.maxHP}`);
    b.feed('|-damage|p2a: Foe|35/100'); b.feed('|-status|p2a: Foe|brn'); b.feed('|-boost|p2a: Foe|atk|1'); b.feed('|turn|18');
    b.foe().hitsTaken = 2;
    b.feed(b.request(18, hp));
    const request = parseChoiceRequest(JSON.stringify(b.payload(18, hp)))!;
    const input = { state: b.state, legalActions: generateLegalActions(request), request };
    const hit = incomingThreats(b.state, b.me(), 'p1', 8)!.damagingMoves.find(m => m.move === 'Rage Fist')!.percentOfMaxHP;
    return { input, hit, skipped: [...healingOverAKnockout(input).keys()].map(k => input.legalActions.find(a => a.id === k)!.label) };
  };
  const { hit, skipped } = setup(56);
  assert.ok(hit[0] > 43.7 && hit[0] < 50, `Rage Fist's least is more than the 43.7% Recover has room for, less than its 50%: ${hit}`);
  assert.deepEqual(skipped, [], 'Recover comes after Rage Fist and puts back all 50%, more than the hit');
  // With Brave Bird the only knockout, its recoil after Rage Fist costs Ho-Oh too, so it does not count as a free one.
  const reckless = setup(30, ['Brave Bird', 'Recover']);
  assert.ok(reckless.hit[0] > 30, 'Rage Fist would knock a 30% Ho-Oh out anyway');
  assert.deepEqual(reckless.skipped, [], 'no free knockout to insist on');
});

import { suckerPunchReadFailed } from '../src/strategy/dominance.js';

test('Sucker Punch is not clicked again into a Pokémon that just declined to attack into it', () => {
  const roster = [ours('Kingambit', 77, ['Sucker Punch', 'Kowtow Cleave', 'Iron Head', 'Swords Dance'], 'Supreme Overlord', 'Black Glasses', 'Dark')];
  const after = (turn1: string[], turn2: string[] = [], hp = roster[0]!.maxHP) => {
    const b = battle(roster, 'Spiritomb', 89);
    for (const line of turn1) b.feed(line);
    b.feed('|turn|2');
    for (const line of turn2) b.feed(line);
    if (turn2.length) b.feed('|turn|3');
    const rqid = turn2.length ? 3 : 2;
    b.feed(b.request(rqid, hp));
    const request = parseChoiceRequest(JSON.stringify(b.payload(rqid, hp)))!;
    const input = { state: b.state, legalActions: generateLegalActions(request), request };
    const found = suckerPunchReadFailed(input);
    return { labels: [...found.keys()].map(k => input.legalActions.find(a => a.id === k)!.label), reason: [...found.values()][0]?.reason };
  };
  const failed = ['|move|p1a: Kingambit|Sucker Punch|p2a: Foe', '|-fail|p2a: Foe', '|move|p2a: Foe|Pain Split|p1a: Kingambit'];
  const refused = after(failed);
  assert.deepEqual(refused.labels, ['Sucker Punch']);
  assert.match(refused.reason!, /Sucker Punch failed on Spiritomb last turn, when it chose to heal instead of attacking/);
  // It attacked, so the read was right and Sucker Punch stays open.
  assert.deepEqual(after(['|move|p1a: Kingambit|Sucker Punch|p2a: Foe', '|-damage|p2a: Foe|60/100', '|move|p2a: Foe|Foul Play|p1a: Kingambit']).labels, []);
  // A turn of something else in between: the failure is no longer last turn's.
  assert.deepEqual(after(failed, ['|move|p1a: Kingambit|Kowtow Cleave|p2a: Foe', '|move|p2a: Foe|Will-O-Wisp|p1a: Kingambit']).labels, []);
  // Near fainting to an attack they have shown, priority is our only way to act first, and they must attack sooner or later.
  const low = Math.round(roster[0]!.maxHP * 0.02);
  const hit = ['|move|p2a: Foe|Foul Play|p1a: Kingambit', `|-damage|p1a: Kingambit|${low}/${roster[0]!.maxHP}`];
  assert.deepEqual(after(hit, failed, low).labels, [], 'a revealed Foul Play knocks a 2% Kingambit out');
  assert.deepEqual(after(hit, failed).labels, ['Sucker Punch'], 'at full HP the same Foul Play does not, so the read stands');
});

import { datasetSpeciesId } from '../src/pokemon/data.js';

test('a forme the set pools do not list takes its base species\' sets', () => {
  for (const forme of ['Maushold-Four', 'Tatsugiri-Droopy', 'Toxtricity-Low-Key', 'Dudunsparce-Three-Segment', 'Pikachu-Unova', 'Polteageist-Antique']) {
    const b = battle([mewtwo()], forme);
    assert.ok(inferOpponent(b.foe()).candidates.length > 0, `${forme} has sets`);
    assert.ok(damageRange(b.state, 'Shadow Ball'), `${forme} gets a damage estimate`);
  }
  // Keldeo, whose pools list only the Resolute forme, still resolves the other way round.
  assert.equal(datasetSpeciesId('Keldeo', new Set(['keldeoresolute'])), 'keldeoresolute');
});

test('No Retreat and Supreme Overlord no longer hide every damage estimate', () => {
  const falinks = battle([ours('Falinks', 88, ['Close Combat', 'No Retreat'], 'Defiant', 'Leftovers', 'Fighting')], 'Snorlax', 84);
  falinks.feed('|-start|p1a: Falinks|move: No Retreat'); falinks.feed('|turn|2');
  assert.ok(damageRange(falinks.state, 'Close Combat'), 'No Retreat only boosts and traps');
  const plain = battle([mewtwo()], 'Kingambit', 76), fallen = battle([mewtwo()], 'Kingambit', 76);
  fallen.feed('|-start|p2a: Foe|fallen3|[silent]'); fallen.feed('|turn|2');
  const hit = (b: ReturnType<typeof battle>) => incomingThreats(b.state, b.me(), 'p1', Infinity)!.damagingMoves.find(m => m.move === 'Kowtow Cleave')?.percentOfMaxHP;
  assert.ok(hit(fallen) && hit(plain) && hit(fallen)![1] > hit(plain)![1], `three fallen allies raise its power: ${hit(plain)} -> ${hit(fallen)}`);
});

import { effectiveSpeed } from '../src/strategy/speed.js';

test('Unburden doubles Speed once the item is lost during this stay, on either side', () => {
  const ours = battle([ours_('Hitmonlee', 90, ['High Jump Kick', 'Knock Off'], 'Unburden', 'White Herb', 'Fighting')], 'Snorlax', 84);
  const held = effectiveSpeed(ours.state, ours.me(), 'p1')!;
  assert.ok(held > 0, 'holding its item, Hitmonlee has an ordinary known Speed');
  ours.feed('|-enditem|p1a: Hitmonlee|White Herb'); ours.state.sides.p1.team[0]!.item = ''; ours.feed('|turn|2');
  assert.equal(effectiveSpeed(ours.state, ours.me(), 'p1'), held * 2);
  const foe = battle([mewtwo()], 'Hawlucha', 84);
  const set = inferOpponent(foe.foe()).candidates.find(c => c.ability === 'Unburden')!;
  const before = effectiveSpeed(foe.state, foe.foe(), 'p2', set)!;
  foe.feed('|-enditem|p2a: Foe|White Herb'); foe.feed('|turn|2');
  assert.equal(effectiveSpeed(foe.state, foe.foe(), 'p2', set), before * 2, 'its White Herb was used up while it was out');
});

import { freeKnockoutPassedUp } from '../src/strategy/dominance.js';

test('outsped and knocked out before acting still says how fast they are: a Heracross doing it has a Scarf', () => {
  const serperior = ours_('Serperior', 86, ['Leaf Storm', 'Glare'], 'Contrary', 'Leftovers', 'Grass');
  const b = battle([serperior, ours_('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')], 'Heracross', 80);
  assert.ok(inferOpponent(b.foe()).candidates.some(c => c.item !== 'Choice Scarf'), 'before, slower sets are possible');
  b.state.ourChoice = { turn: 1, move: 'Leaf Storm' };
  b.feed('|move|p2a: Foe|Megahorn|p1a: Serperior'); b.feed('|-damage|p1a: Serperior|0 fnt'); b.feed('|faint|p1a: Serperior');
  const left = inferOpponent(b.foe()).candidates;
  assert.ok(left.length > 0 && left.every(c => c.item === 'Choice Scarf'), JSON.stringify([...new Set(left.map(c => c.item))]));
  // Had we switched, their moving first would say nothing.
  const switched = battle([serperior, ours_('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')], 'Heracross', 80);
  switched.state.ourChoice = { turn: 1, move: null };
  switched.feed('|move|p2a: Foe|Megahorn|p1a: Serperior'); switched.feed('|-damage|p1a: Serperior|0 fnt'); switched.feed('|faint|p1a: Serperior');
  assert.ok(inferOpponent(switched.foe()).candidates.some(c => c.item !== 'Choice Scarf'));
});

test('a recharge turn is tracked as lost, and Giga Impact costs a Truant user nothing', () => {
  const b = battle([mewtwo()], 'Snorlax', 84);
  // No Snorlax set carries Giga Impact, so the move line is left out rather than rule every set out.
  b.feed('|-mustrecharge|p2a: Foe'); b.feed('|turn|2');
  assert.equal(statusRisk(b.foe(), 2)!.chanceItActsAtAllPercent, 0);
  assert.ok(damageRange(b.state, 'Shadow Ball'), 'recharging leaves damage estimates alone');
  b.feed('|cant|p2a: Foe|recharge');
  assert.equal(b.foe().volatiles.mustrecharge, undefined);
  const slaking = ours_('Slaking', 83, ['Giga Impact', 'Knock Off'], 'Truant', 'Choice Band', 'Normal');
  const sb = battle([slaking], 'Snorlax', 84);
  assert.match(String(moveEffect('Giga Impact', 400, null, sb.me())!.losesItsNextTurnToRecharge), /no cost/);
  assert.equal(moveEffect('Hyper Beam', 300, null, battle([mewtwo()], 'Snorlax', 84).me())!.losesItsNextTurnToRecharge, true);
});

test('a knockout in a speed tie is not passed up for Spikes when nothing of theirs knocks us out first', () => {
  const klefki = ours_('Klefki', 84, ['Thunder Wave', 'Dazzling Gleam', 'Foul Play', 'Spikes'], 'Prankster', 'Leftovers', 'Water');
  const b = battle([klefki, ours_('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')], 'Baxcalibur', 75);
  b.feed('|move|p2a: Foe|Earthquake|p1a: Klefki'); b.feed(`|-damage|p1a: Klefki|${klefki.maxHP}/${klefki.maxHP}`);
  b.feed('|-damage|p2a: Foe|6/100'); b.feed('|turn|2');
  const request = parseChoiceRequest(JSON.stringify(b.payload(2, klefki.maxHP, 0)))!;
  const input = { state: b.state, legalActions: generateLegalActions(request), request };
  const skipped = freeKnockoutPassedUp(input);
  const label = (k: string) => input.legalActions.find(a => a.id === k)!.label;
  assert.deepEqual([...skipped.keys()].map(label).sort(), ['Spikes', 'Thunder Wave']);
});

test('our Minior in Meteor form is modelled though the protocol names its core colour', () => {
  const meteor = ours_('Minior-Meteor', 79, ['Shell Smash', 'Earthquake', 'Acrobatics', 'Power Gem'], 'Shields Down', 'White Herb', 'Rock');
  // The helper names the Pokémon on the field from its details, so the ident follows them.
  const b = battle([{ ...meteor, ident: 'p1: Minior-Orange', details: 'Minior-Orange, L79' }], 'Snorlax', 84);
  assert.ok(damageRange(b.state, 'Earthquake'), 'damage is estimated');
  assert.ok(effectiveSpeed(b.state, b.me(), 'p1'), 'and speed is known');
});

import { knockoutCosts } from '../src/strategy/knockoutCosts.js';
import { destinyBondTrade } from '../src/strategy/dominance.js';

test('a knockout into a faster Destiny Bond carrier is flagged, and one into a bond already up is skipped', () => {
  // Froslass outspeeds Houndoom and carries Destiny Bond in some sets: the knockout may be a trade.
  const houndoom = ours_('Houndoom', 87, ['Dark Pulse', 'Fire Blast', 'Sucker Punch', 'Sludge Bomb'], 'Flash Fire', 'Life Orb', 'Fire');
  const b = battle([houndoom], 'Froslass', 87);
  b.feed('|-damage|p2a: Foe|55/100'); b.feed('|turn|2');
  const risk = knockoutCosts(b.foe(), 'Dark Pulse', 'theirs-first')!;
  assert.equal((risk.destinyBond as { active: boolean }).active, false);
  assert.ok((risk.destinyBond as { carriedPercent: number }).carriedPercent > 0);
  assert.equal(knockoutCosts(b.foe(), 'Dark Pulse', 'ours-first'), null, 'moving first, there is no bond to meet');
  b.state.sides.p2.team[0]!.lastMoveUsed = 'Destiny Bond';
  assert.equal(knockoutCosts(b.foe(), 'Dark Pulse', 'theirs-first'), null, 'a second Destiny Bond in a row fails');

  const dragapult = ours_('Dragapult', 78, ['Shadow Ball', 'Will-O-Wisp', 'Draco Meteor', 'U-turn'], 'Infiltrator', 'Choice Specs', 'Ghost');
  const up = battle([dragapult, ours_('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')], 'Froslass', 87);
  up.feed('|move|p2a: Foe|Destiny Bond|p2a: Foe'); up.feed('|-singlemove|p2a: Foe|Destiny Bond'); up.feed('|-damage|p2a: Foe|30/100'); up.feed('|turn|2');
  const request = parseChoiceRequest(JSON.stringify(up.payload(2, dragapult.maxHP, 0)))!;
  const input = { state: up.state, legalActions: generateLegalActions(request), request };
  const skipped = destinyBondTrade(input);
  const label = (k: string) => input.legalActions.find(a => a.id === k)!.label;
  assert.ok([...skipped.keys()].map(label).includes('Shadow Ball'), 'the knockout would faint Dragapult with it');
  assert.ok(![...skipped.keys()].map(label).includes('Will-O-Wisp'), 'a turn without the knockout is left');
  up.state.sides.p2.teamSize = 1;
  assert.equal(destinyBondTrade(input).size, 0, 'against their last Pokémon the knockout wins whatever happens to ours');
});

import { instructionsFor, CONDITIONAL_INSTRUCTIONS, INSTRUCTIONS } from '../src/decisions/instructions.js';

test('a paragraph about a situational field is sent only when that field is in the payload', () => {
  const plain = instructionsFor({ actions: [{ id: 'move-1', damageRange: {} }] }, false);
  assert.equal(plain, INSTRUCTIONS, 'nothing situational, nothing extra');
  const trick = instructionsFor({ actions: [{ id: 'move-1', choiceItemTrick: { gives: 'Choice Scarf' } }] }, false);
  assert.ok(trick.includes(CONDITIONAL_INSTRUCTIONS.choiceItemTrick!));
  assert.ok(!trick.includes(CONDITIONAL_INSTRUCTIONS.triggersTheirAbility!));
});

test('an unlocked crash move is thrown unless the crash itself would knock us out', () => {
  // They have brought Mamoswine, which Electric cannot touch, in against Zebstrika once. At full HP the crash costs half
  // our HP only if they do it again, which in the logs they mostly did not; at 30% the crash would knock us out.
  const roster = [ours_('Zebstrika', 87, ['Supercell Slam', 'High Horsepower'], 'Sap Sipper', 'Life Orb', 'Electric'),
    ours_('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')];
  const b = battle(roster, 'Skarmory', 80);
  b.feed('|switch|p2a: Mamo|Mamoswine, L81|100/100'); b.feed('|turn|2');
  b.feed('|switch|p2a: Foe|Skarmory, L80|100/100'); b.feed('|turn|3');
  const at = (percent: number) => {
    const hp = Math.round(roster[0]!.maxHP * percent / 100);
    b.feed(b.request(9, hp));
    const request = parseChoiceRequest(JSON.stringify(b.payload(9, hp)))!;
    return { state: b.state, legalActions: generateLegalActions(request), request };
  };
  assert.equal(baitedCrash(at(100)).size, 0, 'our hardest hit, and they may well stay');
  const low = at(30), skipped = baitedCrash(low);
  assert.deepEqual([...skipped.keys()].map(k => low.legalActions.find(a => a.id === k)!.label), ['Supercell Slam']);
});

test('a heal that comes with a Tera stopping the knockout on us is not swapped for a knockout that never moves', () => {
  const decidueye = ours_('Decidueye-Hisui', 87, ['Leaf Blade', 'Roost', 'Triple Arrows', 'Knock Off'], 'Scrappy', 'Heavy-Duty Boots', 'Water');
  const b = battle([decidueye, ours_('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')], 'Lunala', 70);
  // Low enough that Psyshock knocks it out as a Grass/Fighting type, and not once Tera Water removes the weakness.
  const hp = Math.round(decidueye.maxHP * 0.5);
  b.feed('|move|p2a: Foe|Psyshock|p1a: Decidueye-Hisui'); b.feed(`|-damage|p1a: Decidueye-Hisui|${hp}/${decidueye.maxHP}`);
  b.feed('|-damage|p2a: Foe|27/100'); b.feed('|turn|2');
  const payload = b.payload(2, hp, 0);
  const request = parseChoiceRequest(JSON.stringify({ ...payload, active: [{ ...payload.active[0]!, canTerastallize: 'Water' }] }))!;
  const input = { state: b.state, legalActions: generateLegalActions(request), request };
  const labels = [...healingOverAKnockout(input).keys()].map(k => input.legalActions.find(a => a.id === k)!.label);
  assert.ok(!labels.includes('Roost + Tera Water'), `Tera Water stops Psyshock knocking Decidueye out: ${labels}`);
});

import { endgame } from '../src/strategy/endgame.js';

test('executionRisk names the attack that knocks us out first and whether it has been seen', () => {
  const houndoom = ours_('Houndoom', 87, ['Dark Pulse', 'Fire Blast'], 'Flash Fire', 'Life Orb', 'Fire');
  const b = battle([houndoom, ours_('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')], 'Floatzel', 86);
  const low = Math.round(houndoom.maxHP * 0.2);
  b.feed('|move|p2a: Foe|Wave Crash|p1a: Houndoom'); b.feed(`|-damage|p1a: Houndoom|${low}/${houndoom.maxHP}`); b.feed('|turn|2');
  const request = parseChoiceRequest(JSON.stringify(b.payload(2, low, 0)))!;
  const f = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'reduced') as Record<string, unknown>;
  const risk = JSON.stringify(f.sharedByEveryActionBelow ?? f.actions);
  assert.match(risk, /If the opponent uses Wave Crash \(revealed\)/);
});

test('evidence carries its facts once each, with the method said once', () => {
  const b = battle([mewtwo()], 'Garchomp');
  b.foe().inference = { excluded: [], contradictions: 0, observations: [
    { kind: 'damage', turn: 1, before: 9, after: 5, note: 'Observed Shadow Ball: noncritical single hit; public HP rounding and censored overkill included. Unmodeled scenarios retained.' },
    { kind: 'speed', turn: 1, before: 5, after: 5, note: 'Equal-priority observed order; ties retained; speed modifiers and Trick Room included. Candidates with ambiguous order effects retained.' }] };
  const request = parseChoiceRequest(JSON.stringify(b.payload(2, mewtwo().maxHP, 0)))!;
  const f = extractFeatures({ state: b.state, legalActions: generateLegalActions(request), request }, 'reduced') as unknown as { evidenceMethod?: string; opponentInference: { evidence: unknown[] }[] };
  assert.deepEqual(f.opponentInference[0]!.evidence, [{ kind: 'damage', turn: 1, move: 'Shadow Ball', before: 9, after: 5 }, { kind: 'speed', turn: 1, before: 5, after: 5 }]);
  assert.match(f.evidenceMethod!, /noncritical single hit/);
});

test('the endgame read uses the HP each side has now', () => {
  const b = battle([mewtwo(), ours_('Snorlax', 82, ['Body Slam', 'Earthquake'], 'Thick Fat', 'Leftovers', 'Normal')], 'Garchomp');
  const read = () => endgame(b.state, 'p1')!.ourPokemon.find(x => x.species === 'Mewtwo');
  assert.ok(read()!.beats.includes('Garchomp'), 'fresh, Mewtwo wins the race');
  b.feed(b.request(3, Math.round(mewtwo().maxHP * 0.05), 0)); b.feed('|turn|3');
  assert.ok(!read()?.beats.includes('Garchomp'), 'at 5% it does not');
});

test('a type change and an Illusion reveal no longer blank every estimate', () => {
  const b = battle([mewtwo()], 'Greninja');
  b.feed('|-start|p2a: Foe|typechange|Normal|[from] ability: Protean'); b.feed('|turn|2');
  assert.deepEqual(damageRange(b.state, 'Shadow Ball')!.percentOfMaxHP, [0, 0], 'Protean into Normal takes nothing from Shadow Ball');
  assert.ok(damageRange(b.state, 'Focus Blast')!.percentOfMaxHP[1] > 0);
  const z = battle([mewtwo()], 'Zoroark-Hisui', 79);
  z.feed('|replace|p2a: Foe|Zoroark-Hisui, L79|100/100'); z.feed('|turn|2');
  assert.equal(z.state.sides.p2.identityUncertain, true, 'the history is still flagged as uncertain');
  assert.ok(damageRange(z.state, 'Focus Blast'), 'but the Pokémon now named is estimated');
});
