import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusRisk, activatesTheirItem, berryRecoveryAfterHit, sleepTalkMoves } from '../src/strategy/risk.js';
import { conditionalDamage, encoreLock, encorePlan, suckerOutlook } from '../src/strategy/conditional.js';
import { battle, ours } from './helpers.js';
import { encoredIntoNothing, lethalPriority } from '../src/strategy/dominance.js';
import { damageRange } from '../src/strategy/damage.js';
import { canonicalSpecies } from '../src/pokemon/data.js';
import { inferOpponent } from '../src/strategy/inference.js';
import type { BattleAction } from '../src/battle/LegalActionGenerator.js';
import { certainFailure } from '../src/strategy/viability.js';
import { DecisionLoop } from '../src/battle/DecisionLoop.js';

test('sleep narrows into a wake-up chance as turns are lost, and Rest is not a gamble', () => {
  const b = battle([ours('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')], 'Amoonguss');
  const me = b.me();
  b.feed('|-status|p1a: Snorlax|slp');
  const fresh = statusRisk(me)!;
  assert.equal(fresh.sleep!.chanceItWakesAndMovesThisTurnPercent, 0, 'the counter starts at two to four and falls before it is checked');
  assert.equal(fresh.chanceItActsAtAllPercent, 0);
  b.feed('|cant|p1a: Snorlax|slp');
  assert.equal(statusRisk(me)!.sleep!.chanceItWakesAndMovesThisTurnPercent, 33.3, 'one to three turns lost, one already');
  b.feed('|turn|2\n|cant|p1a: Snorlax|slp');
  assert.equal(statusRisk(me)!.sleep!.chanceItWakesAndMovesThisTurnPercent, 50);
  b.feed('|turn|3\n|cant|p1a: Snorlax|slp');
  const certain = statusRisk(me)!;
  assert.equal(certain.sleep!.chanceItWakesAndMovesThisTurnPercent, 100, 'three lost turns rules out every shorter duration');
  assert.equal(certain.thisIsAGambleNotAPlan, false);
  b.feed('|-curestatus|p1a: Snorlax|slp');
  assert.equal(statusRisk(me), null);
});

test('Rest counts Sleep Talk and its accompanying sleep message as one turn', async () => {
  const b = battle([ours('Dondozo', 78, ['Rest', 'Sleep Talk', 'Curse', 'Wave Crash'], 'Unaware', 'Leftovers', 'Fairy')], 'Arceus-Fighting');
  const me = b.me();
  b.feed('|move|p1a: Dondozo|Rest|p1a: Dondozo\n|-status|p1a: Dondozo|slp|[from] move: Rest\n|turn|2');
  assert.equal(me.sleepFromRest, true);
  b.feed('|cant|p1a: Dondozo|slp\n|move|p1a: Dondozo|Sleep Talk|p1a: Dondozo\n|move|p1a: Dondozo|Wave Crash|p2a: Foe|[from] move: Sleep Talk\n|turn|3');
  assert.equal(me.sleepTurns, 1, 'both protocol lines describe the same sleeping turn');
  assert.equal(statusRisk(me)!.sleep!.chanceItWakesAndMovesThisTurnPercent, 0);
  assert.match(certainFailure(b.state, 'Wave Crash', me, 'p1', b.foe())!, /cannot wake this turn/);
  assert.equal(certainFailure(b.state, 'Sleep Talk', me, 'p1', b.foe()), null);
  const request = b.payload(3, me.exactHP!.current);
  request.side.pokemon[0]!.condition = `${me.exactHP!.current}/${me.exactHP!.max} slp`;
  const decision = await new Promise<import('../src/battle/DecisionLoop.js').DecisionRecord>(resolve => {
    const loop = new DecisionLoop({ room: b.state.battleId, username: 'Test Bot', dryRun: true,
      send: () => true, state: () => b.state, onStatus: () => {}, onDecision: resolve,
      provider: { async chooseAction() { return { chosenAction: 'move-4', probabilities: {
        'move-4': 0.8, 'move-3': 0.15, 'move-2': 0.04, 'move-1': 0.01,
      } }; } } });
    loop.request(JSON.stringify(request));
  });
  assert.equal(decision.selectedAction.id, 'move-2', 'Sleep Talk is the only move that can act on the second Rest turn');
  b.feed('|cant|p1a: Dondozo|slp\n|turn|4');
  assert.equal(me.sleepTurns, 2);
  assert.equal(statusRisk(me)!.sleep!.chanceItWakesAndMovesThisTurnPercent, 100);
  assert.match(certainFailure(b.state, 'Sleep Talk', me, 'p1', b.foe())!, /will wake before this move/);
  me.hpPercent = 60;
  me.exactHP!.current = Math.round(me.exactHP!.max * 0.6);
  assert.equal(certainFailure(b.state, 'Rest', me, 'p1', b.foe()), null,
    'the sleep check wakes Dondozo before Rest executes, so it can Rest again');
});

test('a new opposing sleep is not mistaken for an earlier Rest', () => {
  const b = battle([ours('Dondozo', 78, ['Rest', 'Sleep Talk', 'Curse', 'Wave Crash'], 'Unaware', 'Leftovers', 'Fairy')], 'Amoonguss');
  b.feed('|move|p1a: Dondozo|Rest|p1a: Dondozo\n|-status|p1a: Dondozo|slp|[from] move: Rest');
  assert.equal(b.me().sleepFromRest, true);
  b.feed('|-curestatus|p1a: Dondozo|slp\n|turn|2\n|-status|p1a: Dondozo|slp|[from] move: Spore');
  assert.equal(b.me().sleepFromRest, false, 'the new status source overrides the last move remembered');
  assert.equal(statusRisk(b.me())!.sleep!.chanceItWakesAndMovesThisTurnPercent, 0);
});

test('Sleep Talk excludes charge moves from its random picks', () => {
  const b = battle([ours('Dondozo', 78, ['Rest', 'Sleep Talk', 'Solar Beam', 'Wave Crash'], 'Unaware', 'Leftovers', 'Fairy')], 'Amoonguss');
  assert.deepEqual(sleepTalkMoves(b.me())?.picks, ['Rest', 'Wave Crash']);
});

test('paralysis and confusion stack into one chance of acting at all', () => {
  const b = battle([ours('Snorlax', 82, ['Body Slam'], 'Thick Fat', 'Leftovers', 'Normal')], 'Amoonguss');
  const me = b.me();
  b.feed('|-status|p1a: Snorlax|par');
  assert.equal(statusRisk(me)!.chanceItActsAtAllPercent, 75);
  me.volatiles['confusion'] = { sinceTurn: 1, data: null };
  const both = statusRisk(me)!;
  assert.equal(both.chanceItActsAtAllPercent, 50, 'a quarter and a third, independently rolled');
  assert.equal(both.thisIsAGambleNotAPlan, true);
});

test('a super-effective hit is flagged when it would pay a Weakness Policy holder', () => {
  const b = battle([ours('Garchomp', 78, ['Earthquake', 'Dragon Claw'], 'Rough Skin', 'Life Orb', 'Ground')], 'Magnezone');
  const foe = b.foe();
  foe.item = 'Weakness Policy';
  const paid = activatesTheirItem(b.state, 'p1', 'Earthquake')!;
  assert.equal(paid.pays[0]!.item, 'Weakness Policy');
  assert.equal(paid.pays[0]!.probability, 1);
  assert.match(paid.pays[0]!.theyGain, /\+2 Attack and \+2 Special Attack/);
  // Not super-effective, so nothing is paid.
  assert.equal(activatesTheirItem(b.state, 'p1', 'Dragon Claw'), null);
  // A different known item cannot trigger it.
  foe.item = 'Leftovers';
  assert.equal(activatesTheirItem(b.state, 'p1', 'Earthquake'), null);
  // Rocky Helmet is priced per contact move, against our own max HP, and Earthquake makes no contact.
  foe.item = 'Rocky Helmet';
  assert.equal(activatesTheirItem(b.state, 'p1', 'Earthquake'), null, 'Earthquake is not a contact move');
  const helmet = activatesTheirItem(b.state, 'p1', 'Dragon Claw', undefined, b.me())!.pays[0]! as unknown as
    { item: string; costsUsPercentOfMaxHP: number; costsUsHP: number };
  assert.equal(helmet.item, 'Rocky Helmet');
  assert.equal(helmet.costsUsPercentOfMaxHP, 16.7);
  assert.equal(helmet.costsUsHP, Math.floor(b.me().exactHP!.max / 6));
});

test('a surviving Harvest Sitrus holder may eat the same berry twice after a hit', () => {
  const b = battle([ours('Regieleki', 79, ['Explosion'], 'Transistor', 'Magnet', 'Electric')], 'Tropius');
  const foe = b.foe();
  foe.hpPercent = 54; foe.item = 'Sitrus Berry'; foe.ability = 'Harvest';
  const recovery = berryRecoveryAfterHit(b.state, foe, [43, 51])!;
  assert.deepEqual(recovery.hpAfterFirstBerryPercentRange, [28, 36]);
  assert.equal(recovery.harvestRegrowsBerryAtEndOfTurnPercent, 50);
  assert.deepEqual(recovery.hpAfterSecondBerryPercentRange, [53, 61]);
  assert.equal(berryRecoveryAfterHit(b.state, foe, [55, 65]), null, 'a guaranteed knockout never feeds the berry');
  foe.ability = 'Chlorophyll';
  assert.equal(berryRecoveryAfterHit(b.state, foe, [43, 51])!.canEatRegrownBerryThisTurn, undefined);
});

test('Counter and Pain Split carry the condition their damage depends on', () => {
  const b = battle([ours('Wobbuffet', 84, ['Counter', 'Mirror Coat'], 'Shadow Tag', 'Leftovers', 'Fighting')], 'Garchomp');
  const counter = conditionalDamage(b.state, b.me(), 'p1', 'Counter')!;
  assert.match(counter.condition!, /twice the physical damage/);
  assert.ok((counter as { wouldReturnHP: [number, number] }).wouldReturnHP[1] > 0, 'a physical attacker gives it something to return');
  const split = battle([ours('Weezing', 84, ['Pain Split'], 'Levitate', 'Black Sludge', 'Fairy')], 'Garchomp');
  const me = split.me();
  me.exactHP = { current: 40, max: 280 };
  const r = conditionalDamage(split.state, me, 'p1', 'Pain Split')! as { weGainHP: [number, number]; worthlessIfWeAreTheHealthierOne: boolean };
  assert.ok(r.weGainHP[0] > 0, 'splitting from low HP against a healthy target heals us');
  assert.equal(r.worthlessIfWeAreTheHealthierOne, false);
  me.exactHP = { current: 280, max: 280 };
  assert.equal((conditionalDamage(split.state, me, 'p1', 'Pain Split')! as { worthlessIfWeAreTheHealthierOne: boolean }).worthlessIfWeAreTheHealthierOne, true);
});

test('Sucker Punch reports how much of their movepool it can actually catch', () => {
  const b = battle([ours('Bisharp', 80, ['Sucker Punch'], 'Defiant', 'Black Glasses', 'Dark')], 'Amoonguss');
  const r = suckerOutlook(b.state, 'p1', 'Sucker Punch')!;
  assert.match(r.failsUnless, /uses a damaging move/);
  const share = r.shareOfTheirSampledMovesThatAreAttacks!;
  assert.ok(share > 0 && share < 1, `Amoonguss carries both kinds, got ${share}`);
  assert.ok(r.theirSampledStatusMoves.length > 0);
  assert.equal(suckerOutlook(b.state, 'p1', 'Knock Off'), null);
});

test('Sucker Punch never becomes the reason a move that always connects is skipped', () => {
  const b = battle([ours('Bisharp', 80, ['Sucker Punch', 'Iron Head'], 'Defiant', 'Life Orb', 'Dark')], 'Flutter Mane');
  const actions: BattleAction[] = [
    { id: 'move-1', kind: 'move', command: 'move 1', label: 'Sucker Punch', uncertain: false },
    { id: 'move-2', kind: 'move', command: 'move 2', label: 'Iron Head', uncertain: false },
  ];
  const request = { rqid: 1, active: [{ moves: [{ move: 'Sucker Punch', id: 'suckerpunch' }, { move: 'Iron Head', id: 'ironhead' }] }] } as never;
  const skipped = lethalPriority({ state: b.state, legalActions: actions, request });
  assert.ok(!skipped.has('move-2'), 'a conditional priority move cannot displace an unconditional attack');
});

test('Focus Sash and Sturdy stop a knockout being claimed from full HP', () => {
  const b = battle([ours('Iron Hands', 80, ['Close Combat'], 'Quark Drive', 'Booster Energy', 'Fighting')], 'Kingambit');
  const foe = b.foe();
  const ko = () => damageRange(b.state, 'Close Combat')!;
  foe.item = 'Leftovers';
  assert.equal(ko().conditionalKO, 'all-sampled-rolls', 'the hit is otherwise lethal several times over');
  foe.item = 'Focus Sash';
  const sashed = ko();
  assert.equal(sashed.conditionalKO, 'none-sampled', 'a Sash holder at full HP is not knocked out by one hit');
  assert.equal(sashed.survivesOnFocusSashOrSturdy!.probability, 1);
  // Neither works once the holder has taken a point of damage.
  foe.hpPercent = 99; delete foe.exactHP;
  assert.equal(ko().conditionalKO, 'all-sampled-rolls', 'below full HP they protect nothing');
  foe.hpPercent = 100; foe.item = null; foe.ability = 'Sturdy';
  assert.equal(ko().conditionalKO, 'none-sampled', 'Sturdy does the same thing');
});

test('a cosmetic forme is the same Pokémon, not an unknown one', () => {
  const b = battle([ours('Azumarill', 82, ['Aqua Jet', 'Play Rough'], 'Huge Power', 'Sitrus Berry', 'Water')], 'Vivillon-Sun');
  const foe = b.foe();
  assert.equal(canonicalSpecies('Vivillon-Sun'), 'Vivillon');
  // The dataset and the calculator both key on the base species, so without this there are no sets at all.
  assert.ok(inferOpponent(foe).candidates.length > 0, 'a wing pattern still has random-battle sets');
  const rough = damageRange(b.state, 'Play Rough')!;
  const jet = damageRange(b.state, 'Aqua Jet')!;
  assert.ok(rough.percentOfMaxHP[0] > jet.percentOfMaxHP[1], 'the stronger move is visibly stronger');
  // A forme with genuinely different stats must not be collapsed into its base.
  assert.equal(canonicalSpecies('Minior-Meteor'), 'Minior-Meteor');
  assert.equal(canonicalSpecies('Vivillon'), 'Vivillon');
  assert.equal(canonicalSpecies('Not A Real Pokemon'), 'Not A Real Pokemon');
});

test('Encore is reported as moves taken away, and escaping it needs somewhere to go', () => {
  const b = battle([
    ours('Garganacl', 80, ['Protect', 'Salt Cure'], 'Purifying Salt', 'Leftovers', 'Fairy'),
    ours('Azumarill', 82, ['Play Rough'], 'Huge Power', 'Sitrus Berry', 'Water'),
  ], 'Comfey');
  const me = b.me();
  me.volatiles['Encore'] = { sinceTurn: 1, data: null };
  me.lastMoveUsed = 'Protect';
  const lock = encoreLock(b.state, me, 'p1')!;
  assert.equal(lock.lockedInto, 'Protect');
  assert.equal(lock.theOnlyWayOutIsSwitching, true);
  assert.equal(lock.lockedMoveDealsDamage, false);

  const locked = [{ id: 'move-1', kind: 'move' as const, command: 'move 1', label: 'Protect', uncertain: false }];
  const switches = [{ id: 'switch-2', kind: 'switch' as const, command: 'switch 2', label: 'Switch to Azumarill', uncertain: false }];
  const request = { rqid: 1, active: [{ moves: [{ move: 'Protect', id: 'protect' }] }] } as never;
  const guard = (actions: typeof locked | (typeof locked[number] | typeof switches[number])[]) =>
    encoredIntoNothing({ state: b.state, legalActions: actions as never, request });
  // Encored into a move that does nothing, with a replacement to send: take the exit.
  const blocked = guard([...locked, ...switches]);
  assert.equal(blocked.size, 1);
  assert.match(blocked.get('move-1')!.reason, /Encored into Protect.*switching is the only way out/);
  // The real battle: last Pokémon standing, Encored, nowhere to go. Nothing is skipped.
  assert.equal(guard(locked).size, 0, 'a guard that leaves no legal action is no guard at all');
});

test('Encore prices three turns of whatever the opponent just did', () => {
  const b = battle([ours('Comfey', 84, ['Encore', 'Draining Kiss'], 'Triage', 'Leftovers', 'Fairy')], 'Garganacl');
  const foe = b.foe();
  assert.match((encorePlan(b.state, b.me(), 'p1', 'Encore') as { failsBecause: string }).failsBecause,
    /has not used a move yet/);
  foe.lastMoveUsed = 'Protect';
  const status = encorePlan(b.state, b.me(), 'p1', 'Encore') as { wouldLockThemInto: string; theyDealNoDamageWhileItHolds: boolean };
  assert.equal(status.wouldLockThemInto, 'Protect');
  assert.equal(status.theyDealNoDamageWhileItHolds, true);
  // Against an attack it is worth far less, and that shows as the damage it would keep taking.
  foe.lastMoveUsed = 'Body Press';
  const attack = encorePlan(b.state, b.me(), 'p1', 'Encore') as { itWouldKeepDealingPercentOfOurMaxHP: number };
  assert.ok(attack.itWouldKeepDealingPercentOfOurMaxHP > 0);
  // Encore cannot lock in an Encore.
  foe.lastMoveUsed = 'Encore';
  assert.match((encorePlan(b.state, b.me(), 'p1', 'Encore') as { failsBecause: string }).failsBecause, /cannot be Encored/);
  assert.equal(encorePlan(b.state, b.me(), 'p1', 'Draining Kiss'), null);
});
