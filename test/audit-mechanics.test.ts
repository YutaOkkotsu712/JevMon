import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, ours } from './helpers.js';
import { damageRange } from '../src/strategy/damage.js';
import { moveEffect } from '../src/pokemon/mechanics.js';
import { afterEntry } from '../src/strategy/entry.js';
import { incomingThreats } from '../src/strategy/threat.js';
import { residuals } from '../src/strategy/residual.js';
import { revivalOptions, pivotPlan } from '../src/strategy/teamTactics.js';
import { extractFeatures } from '../src/strategy/features.js';
import { generateLegalActions, type ChoiceRequest } from '../src/battle/LegalActionGenerator.js';

test('entry damage breaks Sturdy before incoming damage; Boots/Magic Guard and original state preserved',()=>{
  const b=battle([ours('Blissey',80,['Tackle'],'Natural Cure','','Normal'),ours('Donphan',84,['Earthquake'],'Sturdy','','Ground')],'Abomasnow',84);
  const p=b.state.sides.p1.team[1]!; b.state.sides.p1.hazards.Spikes=1;
  const old=structuredClone(p);
  assert.ok(afterEntry(b.state,p,'p1').hpPercent!<100);
  assert.equal(incomingThreats(b.state,p,'p1')!.conditionalKO,'all-sampled-rolls');
  assert.deepEqual(p,old);
  p.item='Heavy-Duty Boots';assert.equal(afterEntry(b.state,p,'p1').hpPercent,100);
  assert.equal(incomingThreats(b.state,p,'p1')!.conditionalKO,'none-sampled');
  p.item='';p.ability='Magic Guard';assert.equal(afterEntry(b.state,p,'p1').hpPercent,100);
});
test('Mold Breaker bypasses Sturdy but never Focus Sash; suppression restores Sturdy',()=>{
  const b=battle([ours('Haxorus',80,['Earthquake'],'Mold Breaker','','Steel')],'Golem',80);
  b.me().boosts.atk=6;b.foe().ability='Sturdy';b.foe().item='';
  assert.equal(damageRange(b.state,'Earthquake')!.conditionalKO,'all-sampled-rolls');
  b.foe().item='Focus Sash';assert.equal(damageRange(b.state,'Earthquake')!.conditionalKO,'none-sampled');
  b.foe().item='';b.me().abilitySuppressed=true;assert.equal(damageRange(b.state,'Earthquake')!.conditionalKO,'none-sampled');
});
test('Embargo disables Life Orb and Leftovers; Perish countdown retains damage ranges',()=>{
  const b=battle([ours('Pikachu',90,['Thunderbolt'],'Static','Life Orb','Electric')],'Blastoise',84);
  const boosted=damageRange(b.state,'Thunderbolt')!.hp[0];b.feed('|-start|p1a: Pikachu|Embargo');
  const suppressed=damageRange(b.state,'Thunderbolt')!.hp;
  assert.ok(suppressed[0]<boosted);b.me().item='';assert.deepEqual(damageRange(b.state,'Thunderbolt')!.hp,suppressed);
  b.me().item='Leftovers';assert.equal(residuals(b.state,b.me(),'p1')!.perTurnPercentOfMaxHP,0);
  b.feed('|-end|p1a: Pikachu|Embargo\n|-start|p1a: Pikachu|perish2');
  assert.ok(damageRange(b.state,'Thunderbolt'));assert.equal(residuals(b.state,b.me(),'p1')!.perTurnPercentOfMaxHP,6.3);
});
test('multi-hit moves break Substitute and later hits reach HP; Loaded Dice narrows count',()=>{
  const b=battle([ours('Cloyster',80,['Icicle Spear'],'Skill Link','','Water')],'Blastoise',84);
  b.foe().item='';b.foe().ability='Torrent';const full=damageRange(b.state,'Icicle Spear')!.hp;
  b.feed('|-start|p2a: Foe|Substitute');b.foe().substitute!.hp=[1,1];
  const sub=damageRange(b.state,'Icicle Spear')!;
  assert.ok(sub.hp[0]>0&&sub.hp[1]<full[1]);assert.equal(sub.substituteDamage!.laterHitsCanReachHolder,true);
  b.feed('|-end|p2a: Foe|Substitute');b.me().ability='Shell Armor';
  const random=damageRange(b.state,'Icicle Spear')!.hp;
  b.me().item='Loaded Dice';const dice=damageRange(b.state,'Icicle Spear')!.hp;
  assert.ok(dice[0]>random[0]);assert.equal(dice[1],random[1]);
});
test('multi-hit moves defeat a Sash that protects against a single hit',()=>{
  const b=battle([ours('Cloyster',80,['Icicle Spear'],'Skill Link','','Water')],'Golem',80);
  b.me().boosts.atk=6;b.foe().item='Focus Sash';b.foe().ability='Sturdy';
  assert.equal(damageRange(b.state,'Icicle Spear')!.conditionalKO,'all-sampled-rolls');
});
test('Stored Power, Rage Fist, Last Respects and formerly unsupported power moves have envelopes',()=>{
  const b=battle([ours('Annihilape',80,['Rage Fist'],'Defiant','','Ghost')],'Blastoise',84);
  const first=damageRange(b.state,'Rage Fist')!.hp[0];b.me().hitsTaken=4;
  assert.ok(damageRange(b.state,'Rage Fist')!.hp[0]>first);
  const stored=damageRange(b.state,'Stored Power')!.hp[0];b.me().boosts.spa=4;
  assert.ok(damageRange(b.state,'Stored Power')!.hp[0]>stored);
  const last=damageRange(b.state,'Last Respects')!.hp[0];b.state.sides.p1.totalFaints=3;
  assert.ok(damageRange(b.state,'Last Respects')!.hp[0]>last);
  for(const move of ['Fickle Beam','Present','Magnitude','Beat Up','Power Trip','Stomping Tantrum','Lash Out','Assurance','Pursuit','Rollout','Ice Ball','Fury Cutter','Spit Up','Fling','Natural Gift','Trump Card','Retaliate','Payback','Avalanche','Revenge','Focus Punch','Population Bomb','Triple Axel','Scale Shot'])assert.ok(damageRange(b.state,move),move);
});
test('Revival Blessing prices fainted candidates and legal revival is not a switch',()=>{
  const b=battle([ours('Rabsca',90,['Revival Blessing','Psychic'],'Synchronize','','Psychic'),ours('Donphan',84,['Earthquake'],'Sturdy','','Ground')],'Abomasnow',84);
  const p=b.state.sides.p1.team[1]!;p.fainted=true;p.hpPercent=0;p.exactHP!.current=0;
  assert.equal(moveEffect('Revival Blessing',null)!.switchesUserOut,undefined);
  assert.equal(pivotPlan(b.state,b.me(),'p1','Revival Blessing'),null);
  const options=revivalOptions(b.state,'p1');assert.equal(options.length,1);assert.ok(options[0]!.restoredToPercent<=50);
  const request=b.payload(5,b.me().exactHP!.current) as unknown as ChoiceRequest;
  request.side.pokemon[1]!.condition='0 fnt';request.side.pokemon[0]!.reviving=true;
  delete request.active;request.forceSwitch=[true];
  const legalActions=generateLegalActions(request);assert.equal(legalActions[0]!.kind,'revive');
  const f=extractFeatures({state:b.state,request,legalActions},'minimal');
  assert.equal(f.switching.selectingRevival,true);assert.equal(f.switching.forcedReplacement,false);
  assert.ok('revivedTeammate' in f.actions[0]!);
});
test('pivot context is conditional',()=>{
  const b=battle([ours('Scizor',80,['U-turn','Bullet Punch'],'Technician','','Steel'),ours('Blissey',80,['Healing Wish'],'Natural Cure','','Normal')],'Blastoise',84);
  const pivot=pivotPlan(b.state,b.me(),'p1','U-turn')!;assert.ok('ifTheySwitch' in pivot);
});
