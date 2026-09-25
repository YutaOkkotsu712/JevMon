import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residuals } from '../src/strategy/residual.js';
import { pendingRecovery, delayedRecoveryMove, protectOutlook } from '../src/strategy/stalling.js';
import { battle, ours } from './helpers.js';

const blissey = () => ours('Blissey', 82, ['Wish', 'Protect', 'Toxic', 'Seismic Toss'], 'Natural Cure', 'Leftovers', 'Ghost');
const jirachi = () => ours('Jirachi', 80, ['Healing Wish', 'Iron Head'], 'Serene Grace', 'Leftovers', 'Steel');

test('toxic damage grows with the turns it has been in place', () => {
  const b = battle([blissey()], 'Amoonguss');
  b.feed('|-status|p2a: Foe|tox');
  const first = residuals(b.state, b.foe(), 'p2')!;
  assert.match(first.sources.find(x => /toxic/.test(x.source))!.source, /turn 1 of it/);
  assert.equal(first.sources.find(x => /toxic/.test(x.source))!.percent, -6.3);
  b.feed('|turn|2');
  b.feed('|turn|3');
  const later = residuals(b.state, b.foe(), 'p2')!;
  assert.match(later.sources.find(x => /toxic/.test(x.source))!.source, /turn 3 of it/);
  assert.equal(later.sources.find(x => /toxic/.test(x.source))!.percent, -18.8, 'three sixteenths by the third turn');
  // Leaving the field restarts the count, so coming back in starts from the first tick again.
  b.feed('|switch|p2a: Foe2|Typhlosion, L82|100/100');
  b.feed('|switch|p2a: Foe|Amoonguss, L82|100/100 tox');
  const returned = residuals(b.state, b.foe(), 'p2')!.sources.find(x => /toxic/.test(x.source))!;
  assert.match(returned.source, /turn 1 of it/, 'the counter restarted');
  assert.equal(returned.percent, -6.3);
  b.feed('|turn|4');
  assert.match(residuals(b.state, b.foe(), 'p2')!.sources.find(x => /toxic/.test(x.source))!.source, /turn 2 of it/,
    'and climbs again from there, well below the three it had reached');
});

test('Wish is reported as something that can be passed, not only as healing', () => {
  const b = battle([blissey()], 'Amoonguss');
  const wish = delayedRecoveryMove('Wish', b.me())!;
  assert.ok('landsAtEndOfNextTurn' in wish && wish.landsAtEndOfNextTurn);
  assert.ok('healsHP' in wish && wish.healsHP === Math.floor(b.me().exactHP!.max / 2));
  assert.ok('canBePassed' in wish && /switching after it keeps the healing/.test(wish.canBePassed));
  assert.equal(delayedRecoveryMove('Seismic Toss', b.me()), null);
});

test('a Wish already cast is tracked until it lands, and goes with the slot', () => {
  const b = battle([blissey()], 'Amoonguss');
  assert.equal(pendingRecovery(b.state, 'p1'), null, 'nothing waiting yet');
  b.feed('|move|p1a: Blissey|Wish|p1a: Blissey');
  const waiting = pendingRecovery(b.state, 'p1')!;
  assert.equal(waiting.wish!.healsHP, Math.floor(b.me().exactHP!.max / 2));
  assert.equal(waiting.wish!.setBy, 'Blissey');
  assert.equal(waiting.wish!.goesToWhoeverHoldsTheSlot, true);
  assert.equal(waiting.wish!.landsAtEndOfTurn, 2);
  // It is spent once it resolves.
  b.feed(`|-heal|p1a: Blissey|${b.me().exactHP!.max}/${b.me().exactHP!.max}|[from] move: Wish|[wisher] Blissey`);
  assert.equal(pendingRecovery(b.state, 'p1'), null);
});

test('a Healing Wish is tracked as a full restore waiting for whatever comes in', () => {
  const b = battle([jirachi(), blissey()], 'Amoonguss');
  const move = delayedRecoveryMove('Healing Wish', b.me())!;
  assert.ok('theUserFaints' in move && move.theUserFaints);
  assert.ok('fullyRestoresTheNextPokemonIn' in move && move.fullyRestoresTheNextPokemonIn);
  const dance = delayedRecoveryMove('Lunar Dance', b.me())!;
  assert.ok('alsoRestoresPP' in dance && dance.alsoRestoresPP);
  b.feed('|move|p1a: Jirachi|Healing Wish|p1a: Jirachi');
  const waiting = pendingRecovery(b.state, 'p1')!;
  assert.equal(waiting.fullRestoreWaiting!.move, 'Healing Wish');
  assert.equal(waiting.fullRestoreWaiting!.appliesToWhicheverPokemonComesInNext, true);
  b.feed('|-heal|p1a: Blissey|300/300|[from] move: Healing Wish');
  assert.equal(pendingRecovery(b.state, 'p1'), null, 'spent once it lands');
});

test('Protect behind a Wish and a toxic is reported as gaining ground', () => {
  const b = battle([blissey()], 'Amoonguss');
  const flat = protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!;
  assert.equal(flat.gainsGroundIfItWorks, false, 'with nothing set up, stalling is a wash');
  b.feed('|-status|p2a: Foe|tox');
  b.feed('|turn|2');
  b.feed('|turn|3');
  const stalling = protectOutlook(b.state, 'Protect', 'p1', b.me(), b.foe())!;
  assert.ok(stalling.endOfTurnSwingPercentOfMaxHP! > 12, `an escalating toxic swings it: ${stalling.endOfTurnSwingPercentOfMaxHP}`);
  assert.equal(stalling.gainsGroundIfItWorks, true);
  assert.equal(stalling.opponentStillSpendsPPOnTheBlockedMove, true);
});

import { restPlan } from '../src/strategy/rest.js';
import { protectOutlook as protectFor, substitutePlan as subFor, opponentPP as ppOf } from '../src/strategy/stalling.js';
import { outhealed as outhealedGuard, futileUnawareSetup } from '../src/strategy/dominance.js';
import { GUARDS } from '../src/battle/DecisionLoop.js';
import { effectViability as viabilityOf } from '../src/strategy/viability.js';
import { battle as battleWith, ours as row } from './helpers.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
type Plan = { wakesAtOnce?: string; turnsLostToSleep?: number; actsThroughSleepTalk?: string[]; survivesTheSleep?: boolean };

test('Rest is priced by what the sleep costs: nothing with a Chesto Berry, two turns without Sleep Talk', () => {
  const chesto = battleWith([row('Snorlax', 84, ['Rest', 'Body Slam', 'Curse', 'Crunch'], 'Thick Fat', 'Chesto Berry', 'Ghost')], 'Garchomp');
  const c = restPlan(chesto.state, chesto.me(), 'p1') as Plan;
  assert.equal(c.wakesAtOnce, 'Chesto Berry'); assert.equal(c.turnsLostToSleep, 0);
  const talker = battleWith([row('Snorlax', 84, ['Rest', 'Sleep Talk', 'Body Slam', 'Curse'], 'Thick Fat', 'Leftovers', 'Ghost')], 'Garchomp');
  assert.deepEqual((restPlan(talker.state, talker.me(), 'p1') as Plan).actsThroughSleepTalk!.sort(), ['Body Slam', 'Curse', 'Rest'], 'Rest is a pick too, and fails while asleep');
  const bare = battleWith([row('Snorlax', 84, ['Rest', 'Body Slam', 'Curse', 'Crunch'], 'Thick Fat', 'Leftovers', 'Ghost')], 'Garchomp');
  const plan = restPlan(bare.state, bare.me(), 'p1') as Plan;
  assert.equal(plan.turnsLostToSleep, 2);
  assert.equal(typeof plan.survivesTheSleep, 'boolean', 'priced against their worst hit over the two turns');
  // Anything that keeps the user awake makes Rest fail.
  const insomniac = battleWith([row('Snorlax', 84, ['Rest'], 'Insomnia', 'Leftovers', 'Ghost')], 'Garchomp');
  insomniac.feed(`|-damage|p1a: Snorlax|200/${row('Snorlax', 84, ['Rest'], 'Insomnia', 'Leftovers', 'Ghost').maxHP}`);
  assert.match(viabilityOf(insomniac.state, 'Rest', insomniac.me(), 'p1', insomniac.foe())!.certain.join(' '), /Insomnia keeps the user from sleeping/);
});

test('Protect and Substitute say they run down our Slow Start, and Protect that it gives theirs away', () => {
  const gigas = row('Regigigas', 84, ['Protect', 'Substitute', 'Body Slam', 'Knock Off'], 'Slow Start', 'Leftovers', 'Ghost');
  const b = battleWith([gigas], 'Garchomp');
  b.feed('|-start|p1a: Regigigas|ability: Slow Start'); b.feed('|turn|2');
  b.feed(`|-damage|p1a: Regigigas|${Math.round(gigas.maxHP * 0.9)}/${gigas.maxHP}`);
  assert.match(protectFor(b.state, 'Protect', 'p1', b.me(), b.foe())!.possiblePayoffs!.join(' '), /runs down our Slow Start: \d weakened turns left/);
  assert.equal(subFor(b.state, b.me(), 'p1', 'Substitute')!.runsDownOurSlowStart, 4);
  const theirs = battleWith([row('Toxapex', 84, ['Protect', 'Toxic'], 'Regenerator', 'Black Sludge', 'Poison')], 'Regigigas', 84);
  theirs.feed('|-start|p2a: Foe|ability: Slow Start'); theirs.feed('|turn|2');
  assert.match(protectFor(theirs.state, 'Protect', 'p1', theirs.me(), theirs.foe())!.spendsTheirSlowStart!, /protecting gives one away/);
});

test('PP is charged at each use by the Pressure of the Pokémon it hit', () => {
  const suicune = row('Suicune', 84, ['Scald', 'Calm Mind'], 'Pressure', 'Leftovers', 'Water');
  const snorlax = row('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal');
  const b = battleWith([suicune, snorlax], 'Garchomp');
  b.feed('|move|p2a: Foe|Earthquake|p1a: Suicune'); b.feed('|turn|2');
  b.feed(`|switch|p1a: Snorlax|Snorlax, L82|${snorlax.maxHP}/${snorlax.maxHP}`); b.feed(b.request(3, snorlax.maxHP, 1));
  b.feed('|move|p2a: Foe|Earthquake|p1a: Snorlax'); b.feed('|turn|3');
  assert.equal(b.foe().ppSpent!.earthquake, 3, 'two into Pressure Suicune, one into Snorlax');
  assert.equal(ppOf(b.state, b.foe(), b.me())!.moves.find(m => m.move === 'Earthquake')!.atMostRemaining, 16 - 3);
});

test('a healer on its last Recover is attacked through, not switched from', () => {
  const roster = [row('Gurdurr', 86, ['Knock Off', 'Drain Punch', 'Mach Punch', 'Defog'], 'Guts', 'Eviolite', 'Fighting'),
    row('Rayquaza', 72, ['Dragon Ascent', 'Dragon Dance', 'Extreme Speed', 'Earthquake'], 'Air Lock', 'Life Orb', 'Flying')];
  const b = battleWith(roster, 'Illumise', 97);
  b.feed('|-enditem|p2a: Foe|Leftovers|[from] move: Knock Off'); b.feed('|-damage|p2a: Foe|40/100');
  for (let t = 2; t <= 4; t++) { b.feed('|move|p2a: Foe|Roost|p2a: Foe'); b.feed('|-heal|p2a: Foe|90/100'); b.feed(`|turn|${t}`); }
  const decideAt = () => { const r = parseChoiceRequest(JSON.stringify(b.payload(9, roster[0]!.maxHP)))!; return { state: b.state, legalActions: generateLegalActions(r), request: r }; };
  assert.ok(outhealedGuard(decideAt()).size > 0, 'plenty of Roost left: attacking into it is the stall');
  b.foe().ppSpent = { roost: 15 };
  assert.equal(outhealedGuard(decideAt()).size, 0, 'one Roost left: attacking through it runs the stall out');
});

test('a stall guard cannot fall through to Dragon Dance against the last Unaware foe', () => {
  const flygon = row('Flygon', 82, ['Earthquake', 'Dragon Dance', 'Stone Edge', 'Outrage'], 'Levitate', '', 'Rock');
  const backup = row('Ursaluna', 79, ['Earthquake'], 'Guts', 'Flame Orb', 'Normal');
  const b = battleWith([flygon, backup], 'Skeledirge', 82);
  b.state.sides.p2.teamSize = 1;
  b.me().boosts = { atk: 1, spe: 1 };
  b.me().hpPercent = 8;
  b.me().exactHP!.current = 22;
  b.foe().hpPercent = 64;
  b.foe().teraType = 'Water'; b.foe().terastallized = true;
  b.foe().revealedMoves = ['Slack Off', 'Torch Song'];
  b.state.healsAgainst = { [`${b.foe().id}>${b.me().id}`]: 2 };
  const r = parseChoiceRequest(JSON.stringify(b.payload(9, 22)))!;
  const input = { state: b.state, legalActions: generateLegalActions(r), request: r };
  assert.ok(GUARDS.includes(futileUnawareSetup), 'the guard is wired into live decisions');
  assert.equal(outhealedGuard(input).has('move-1'), true, 'the stall guard rules out the losing attack');
  assert.match(futileUnawareSetup(input).get('move-2')!.reason, /Unaware.*already outspeeds/,
    'Dragon Dance cannot be the replacement when its Attack boost is ignored and Speed changes nothing');
  b.me().boosts.spe = -1;
  assert.equal(futileUnawareSetup(input).has('move-2'), false, 'a Speed boost may still matter against Unaware');
  b.me().boosts.spe = 1;
  b.state.sides.p2.teamSize = 2;
  assert.equal(futileUnawareSetup(input).has('move-2'), false, 'a boost can help against a remaining opponent');
  b.state.sides.p2.teamSize = 1;
  b.me().ability = 'moldbreaker';
  assert.equal(futileUnawareSetup(input).has('move-2'), false, 'Mold Breaker makes the Attack boost count');
});
