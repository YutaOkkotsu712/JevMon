import {test} from 'node:test';
import assert from 'node:assert/strict';
import {battle,ours} from './helpers.js';
import {moveEffect} from '../src/pokemon/mechanics.js';
import {setupProjection} from '../src/strategy/projection.js';
import {effectiveSpeed} from '../src/strategy/speed.js';
import {afterEntry} from '../src/strategy/entry.js';
test('Contrary and Simple change projections once, including negative attacks and suppression',()=>{
 const b=battle([ours('Malamar',88,['Superpower'],'Contrary','','Dark')],'Blastoise',84);
 assert.deepEqual(moveEffect('Superpower',null,null,b.me())!.userBoosts,{atk:1,def:1});
 const up=setupProjection(b.state,b.me(),'p1',{atk:-1,def:-1},0,false,'Superpower')!;
 assert.deepEqual(up.stagesAfter,{atk:1,def:1});assert.equal(up.selfDropCost,undefined);
 b.me().abilitySuppressed=true;
 const down=setupProjection(b.state,b.me(),'p1',{atk:-1,def:-1},0,false,'Superpower')!;
 assert.deepEqual(down.stagesAfter,{atk:-1,def:-1});assert.ok(down.selfDropCost);
 assert.ok(up.sameMoveDamagePercentOnNextUse![0]>down.sameMoveDamagePercentOnNextUse![1]);
 b.me().abilitySuppressed=false;b.me().ability='Simple';
 assert.deepEqual(setupProjection(b.state,b.me(),'p1',{atk:1,spe:1},0,true,'Dragon Dance')!.stagesAfter,{atk:2,spe:2});
});
test('Scarf multiplies effective speed and Embargo removes it; named Booster Speed is usable',()=>{
 const b=battle([ours('Garchomp',80,['Earthquake'],'Rough Skin','','Ground')],'Blastoise',84);
 const plain=effectiveSpeed(b.state,b.me(),'p1')!;b.me().item='Choice Scarf';
 assert.equal(effectiveSpeed(b.state,b.me(),'p1'),Math.floor(plain*1.5));
 b.feed('|-start|p1a: Garchomp|Embargo');assert.equal(effectiveSpeed(b.state,b.me(),'p1'),plain);
 b.me().item='';b.me().volatiles={protosynthesisspe:{sinceTurn:1,data:null}};
 assert.equal(effectiveSpeed(b.state,b.me(),'p1'),Math.floor(plain*1.5));
});
test('Sticky Web affects entry speed; Boots, Contrary, Simple and Defiant have distinct outcomes',()=>{
 const b=battle([ours('Blissey',80,['Tackle'],'Natural Cure','','Normal'),ours('Garchomp',80,['Earthquake'],'Rough Skin','','Ground')],'Blastoise',84);
 const p=b.state.sides.p1.team[1]!;const plain=effectiveSpeed(b.state,p,'p1')!;b.state.sides.p1.hazards['Sticky Web']=1;
 assert.ok(effectiveSpeed(b.state,p,'p1')!<plain);
 p.item='Heavy-Duty Boots';assert.equal(effectiveSpeed(b.state,p,'p1'),plain);
 p.item='';p.ability='Contrary';assert.equal(afterEntry(b.state,p,'p1').boosts.spe,1);
 p.ability='Simple';assert.equal(afterEntry(b.state,p,'p1').boosts.spe,-2);
 p.ability='Defiant';assert.equal(afterEntry(b.state,p,'p1').boosts.atk,2);
 p.boosts.spe=-6;assert.equal(afterEntry(b.state,p,'p1').boosts.atk,undefined);
});
test('speed setup distinguishes surviving the setup turn and moving first next turn; Trick Room reverses order',()=>{
 const b=battle([ours('Regirock',84,['Rock Polish','Stone Edge'],'Clear Body','','Rock')],'Blastoise',84);
 const plan=setupProjection(b.state,b.me(),'p1',{spe:2},0,true,'Rock Polish')!;
 assert.equal(plan.setupTurnOrder,'theirs-first');
 assert.equal(plan.survivesToUseIt,true);
 assert.ok(plan.worstModeledHPAfterSetupTurn!>0);
 assert.equal(plan.nextTurnOrderAtEqualPriority,'ours-first');
 assert.equal(plan.outrunsTheActiveAfterwards,true);
 b.state.field.trickRoom=true;
 const reversed=setupProjection(b.state,b.me(),'p1',{spe:2},0,true,'Rock Polish')!;
 assert.equal(reversed.outrunsTheActiveAfterwards,false);
 b.state.field.trickRoom=false;b.feed(b.request(9,1));
 assert.equal(setupProjection(b.state,b.me(),'p1',{spe:2},0,true,'Rock Polish')!.survivesToUseIt,false);
});

test('Dragon Dance can survive a hit, gain speed and increase next-turn damage',()=>{
 const b=battle([ours('Dragonite',80,['Dragon Dance','Dragon Claw'],'Multiscale','','Dragon')],'Blastoise',84);
 const p=setupProjection(b.state,b.me(),'p1',{atk:1,spe:1},0,true,'Dragon Dance')!;
 assert.equal(p.setupTurnOrder,'theirs-first');assert.equal(p.survivesToUseIt,true);
 assert.equal(p.nextTurnOrderAtEqualPriority,'ours-first');assert.ok(p.ourBestDamagePercentAfter!>p.wasBefore!);
});
