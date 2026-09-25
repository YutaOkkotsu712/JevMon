// Independent Gen 9 simulator checks for sequential hits and Revival Blessing. No API calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {BattleTracker} from '../dist/src/battle/BattleTracker.js';
import {parseFrame} from '../dist/src/showdown/protocol.js';
import {scenario} from '../dist/src/strategy/calcCore.js';
import {parseChoiceRequest,generateLegalActions} from '../dist/src/battle/LegalActionGenerator.js';
const require=createRequire(resolve(process.env.SIMULATOR_DIR,'package.json'));
const {Battle,extractChannelMessages}=require('@pkmn/sim');
const spread={level:84,nature:'Serious',evs:{hp:85,atk:85,def:85,spa:85,spd:85,spe:85}};
let checks=0;
for(const entry of [
 {species:'Annihilape',ability:'Defiant',move:'Rage Fist',item:'',sub:false,hitsTaken:4},
 {species:'Houndstone',ability:'Sand Rush',move:'Last Respects',item:'',sub:false,faints:3},
 {species:'Espeon',ability:'Synchronize',move:'Stored Power',item:'',sub:false,boosts:{spa:2,spd:2}},
 {species:'Cloyster',ability:'Skill Link',move:'Icicle Spear',item:'',sub:false},
 {species:'Cloyster',ability:'Skill Link',move:'Icicle Spear',item:'',sub:true},
 {species:'Maushold',ability:'Technician',move:'Population Bomb',item:'Loaded Dice',sub:false},
 {species:'Cinccino',ability:'Skill Link',move:'Bullet Seed',item:'',sub:false},
]){
 const room='battle-gen9randombattle-audit',tracker=new BattleTracker(room,'Test Bot');
 const feed=t=>{for(const m of parseFrame(`>${room}\n${t}`))tracker.handle(m);};
 const sim=new Battle({formatid:'gen9customgame',seed:[41,27,32,18],
  p1:{name:'Test Bot',team:[{...spread,species:entry.species,ability:entry.ability,item:entry.item,moves:[entry.move,'Splash']}]},
  p2:{name:'Opponent',team:[{...spread,species:'Blastoise',ability:'Torrent',moves:['Splash']}]},
  send(type,data){const t=Array.isArray(data)?data.join('\n'):data;if(type==='update')feed(extractChannelMessages(t,[1])[1].join('\n'));else if(type==='sideupdate'&&t.startsWith('p1\n'))feed(t.slice(3));}});
 sim.sendUpdates();if(sim.requestState==='teampreview'){sim.makeChoices('team 1','team 1');sim.sendUpdates();}
 const defender=sim.sides[1].active[0];
 if(entry.sub){defender.addVolatile('substitute');defender.volatiles.substitute.hp=1;sim.sendUpdates();}
 const s=tracker.state,a=s.sides.p1.team[0],d=s.sides.p2.team[0];
 // Supply test-only exact defender stats; production opponent inference remains hidden.
 d.stats={...defender.baseStoredStats};d.exactHP={current:defender.hp,max:defender.maxhp};d.item='';d.ability='Torrent';
 if(entry.sub)d.substitute.hp=[1,1];
 if(entry.hitsTaken){a.hitsTaken=entry.hitsTaken;sim.sides[0].active[0].timesAttacked=entry.hitsTaken;}
 if(entry.faints){s.sides.p1.totalFaints=entry.faints;sim.sides[0].totalFainted=entry.faints;}
 if(entry.boosts){a.boosts={...entry.boosts};Object.assign(sim.sides[0].active[0].boosts,entry.boosts);}
 const prediction=scenario(s,a,d,'p1',entry.move);assert.ok(prediction,entry.move);
 const before=defender.hp;sim.makeChoices('move 1','move 1');sim.sendUpdates();
 const actual=before-defender.hp;
 assert.ok(actual>=prediction.min&&actual<=prediction.max,`${entry.move} sub=${entry.sub}: ${actual} outside ${prediction.min}..${prediction.max}`);
 sim.destroy();checks++;
}
{
 const room='battle-gen9randombattle-revival',tracker=new BattleTracker(room,'Test Bot');let pending;
 const feed=t=>{for(const m of parseFrame(`>${room}\n${t}`)){tracker.handle(m);if(m.type==='request'){try{const raw=JSON.parse(m.data);if(raw){raw.rqid=1;const request=parseChoiceRequest(JSON.stringify(raw));if(request)pending=request;}}catch(error){throw error;}}}};
 const sim=new Battle({formatid:'gen9customgame',seed:[41,27,32,18],p1:{name:'Test Bot',team:[{...spread,species:'Rabsca',ability:'Synchronize',moves:['Revival Blessing','Splash']},{...spread,species:'Pikachu',ability:'Static',moves:['Tackle']}]},p2:{name:'Opponent',team:[{...spread,species:'Blastoise',ability:'Torrent',moves:['Splash']}]},send(type,data){const t=Array.isArray(data)?data.join('\n'):data;if(type==='update')feed(extractChannelMessages(t,[1])[1].join('\n'));else if(type==='sideupdate'&&t.startsWith('p1\n'))feed(t.slice(3));}});
 sim.sendUpdates();if(sim.requestState==='teampreview'){sim.makeChoices('team 12','team 1');sim.sendUpdates();}
 const target=sim.sides[0].pokemon[1];target.faint();sim.faintMessages();sim.sendUpdates();
 sim.makeChoices('move 1','move 1');sim.sendUpdates();
 const options=generateLegalActions(pending);assert.equal(options.length,1);assert.equal(options[0].kind,'revive');
 sim.choose('p1',options[0].command);sim.sendUpdates();
 assert.equal(target.fainted,false);assert.equal(target.hp,Math.floor(target.maxhp/2));
 const tracked=tracker.state.sides.p1.team.find(p=>p.species==='Pikachu');assert.equal(tracked.fainted,false);assert.equal(tracked.exactHP.current,target.hp);
 assert.equal(sim.sides[0].active[0].species.name,'Rabsca');
 sim.destroy();checks++;
}
console.log(JSON.stringify({result:'passed',simulatorChecks:checks,revivalSelectionAndTracking:true}));
