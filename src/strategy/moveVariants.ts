import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
export interface MoveVariant { hits: number; powers?: number[]; note?: string }
/** Bounds are conditional on a hit; variable hit counts and unknown history are not a uniform distribution. */
export function moveVariants(s: BattleState, p: PokemonState, side: SideId, name: string, ability: string, item: string): MoveVariant[] {
  const m = dex.moves.get(name), key = m.id;
  const powers = (xs: number[], note?: string): MoveVariant[] => xs.map(bp=>({hits:1,powers:[bp],...(note?{note}:{})}));
  const ambiguous = 'conditional power/history envelope, not a probability or forecast of the opposing action';
  if (key === 'ragefist') return powers(p.hitsTaken === undefined ? [50,350] : [Math.min(350,50+50*p.hitsTaken)], p.hitsTaken === undefined ? 'hit history unknown: Rage Fist spans 50–350 BP' : undefined);
  if (key === 'lastrespects') return powers([50+50*(s.sides[side].totalFaints ?? s.sides[side].team.filter(x=>x.fainted).length)]);
  if (key === 'ficklebeam') return powers([80,160], 'Fickle Beam can double its power; envelope covers both outcomes');
  if (key === 'magnitude') return powers([10,30,50,70,90,110,150], 'Magnitude covers every possible power');
  if (key === 'present') return powers([0,40,80,120], 'Present can heal the target by 25% max HP instead of damaging it; zero is the healing branch, not neutral value');
  if (['payback','avalanche','revenge','assurance','pursuit','stompingtantrum','lashout','retaliate'].includes(key)) return powers([m.basePower,m.basePower*2], ambiguous);
  if (key === 'focuspunch') return powers([0,150], 'Focus Punch can be interrupted before it executes');
  if (key === 'rollout' || key === 'iceball') {
    const scale = Object.keys(p.volatiles).some(k=>id(k)==='defensecurl')?2:1;
    return powers([30*scale,480*scale], ambiguous);
  }
  if (key === 'furycutter') return powers([40,160], ambiguous);
  if (key === 'spitup') { const stack=Object.keys(p.volatiles).map(k=>/^stockpile([1-3])$/.exec(id(k))).find(Boolean);return powers([stack ? Number(stack[1])*100 : 0]); }
  if (key === 'trumpcard') { const pp=p.movePP.trumpcard?.remaining;return powers(pp===undefined?[40,200]:[pp<=1?200:pp===2?80:pp===3?60:pp===4?50:40],pp===undefined?ambiguous:undefined); }
  if (key === 'beatup') {
    const team=s.sides[side], participants=team.team.filter(x=>x.id===p.id||!x.fainted&&!x.status);
    const known=participants.map(x=>5+Math.floor(dex.species.get(x.species).baseStats.atk/10));
    const missing=Math.max(0,(team.teamSize??6)-team.team.length);
    return [{hits:known.length,powers:known},...(missing?[{hits:known.length+missing,powers:[...known,...Array(missing).fill(24)],note:'unrevealed Beat Up teammates bounded by legal species base Attack; eligibility unknown'}]:[])];
  }
  if (m.multihit) {
    let counts: number[];
    if (key === 'populationbomb') counts=item==='loadeddice'?[4,10]:[1,10];
    else if (m.multiaccuracy) counts=ability==='skilllink'||item==='loadeddice'?[Number(m.multihit)]:[1,Number(m.multihit)];
    else if (Array.isArray(m.multihit)) counts=ability==='skilllink'?[m.multihit[1]!]:item==='loadeddice'?[4,5]:[m.multihit[0]!,m.multihit[1]!];
    else counts=[m.multihit];
    return counts.map(hits=>({hits,...(['tripleaxel','triplekick'].includes(key)?{powers:Array.from({length:hits},(_,i)=>(key==='tripleaxel'?20:10)*(i+1))}:{}),note:'sequential hits; envelope includes hit-count uncertainty, conditional on the first hit connecting'}));
  }
  return [{hits:1}];
}
