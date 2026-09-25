import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { afterEntry } from './entry.js';
import { outgoingBest } from './threat.js';
import { dex, id } from '../pokemon/data.js';

export function revivalOptions(s: BattleState, side: SideId) {
  return s.sides[side].team.filter(p=>p.fainted).map(p=>{
    const revived=structuredClone(p);revived.fainted=false;revived.status=null;revived.boosts={};revived.volatiles={};
    delete revived.substitute;delete revived.entryProjected;
    if (revived.exactHP) { revived.exactHP.current=Math.floor(revived.exactHP.max/2);revived.hpPercent=100*revived.exactHP.current/revived.exactHP.max; }
    else revived.hpPercent=50;
    const entry=afterEntry(s,revived,side);
    return { slot:p.slot,species:p.species,restoredToPercent:revived.hpPercent,staysOnBench:true,
      afterFutureEntryHP:entry.hpPercent,fallsToEntryHazards:entry.fainted,
      availableMoves:p.knownMoves.filter(m=>(p.movePP[id(m)]?.remaining??1)>0),
      ...(p.exactHP ? { bestDamageAgainstCurrentOpponent:outgoingBest(s,revived,side,1) } : { exactMaxHPUnknown:true }),
      ppAndConsumedItemsAreNotRestored:true };
  });
}
/**
 * Tera is spent once per battle by whichever Pokémon uses it first, so spending it now takes it from teammates
 * whose sets are built around it. Spectrier's Tera Blast is only a Fighting move with its Tera; without it, it
 * is a Normal move, and Tera had gone on finishing a Girafarig by the time Spectrier needed it.
 */
export function teraDependents(s: BattleState, side: SideId) {
  const ours = s.sides[side];
  return ours.team.filter(p => !p.fainted && p.id !== ours.activeId && p.teraType).flatMap(p => {
    const moves = p.knownMoves.map(m => id(m)), species = id(p.species);
    const why = moves.includes('terablast') ? `its Tera Blast is ${p.teraType} only after Terastallising, and Normal otherwise`
      : species.startsWith('terapagos') ? 'Terastallising is what makes it Terapagos-Stellar'
      : species.startsWith('ogerpon') ? 'Embody Aspect raises a stat only when it Terastallises' : null;
    return why ? [{ species: p.species, teraType: p.teraType, why }] : [];
  });
}
export function pivotPlan(s: BattleState, me: PokemonState, side: SideId, moveName: string) {
  const move=dex.moves.get(moveName);
  if(!move.selfSwitch||['batonpass','shedtail','revivalblessing'].includes(move.id))return null;
  const bench=s.sides[side].team.filter(p=>!p.fainted&&p.id!==me.id);
  if(!bench.length)return {failsToPivot:true,reason:'no living teammate to bring in'};
  return {ifTheySwitch:'Their ordinary switch resolves before this move; if the pivot succeeds, choose our replacement after seeing what came in.',
    ifTheyStay:'A slow pivot can absorb their attack before bringing a teammate in; a fast pivot exposes the replacement to their remaining action.',
    mustExecuteAndSucceed:true,
    failureRisks:move.category==='Status'?'Check move failure, Substitute and blocking abilities before assuming a switch.':'A miss, Protect or immunity can prevent pivoting; contact damage can KO the user before it leaves.',
    replacements:bench.map(p=>({slot:p.slot,species:p.species,hpAfterHazards:afterEntry(s,p,side).hpPercent})),
    opponentSwitchLikelihood:'Not a probability estimate. Use the revealed bench matchups and current pressure; do not pivot merely because they could switch.' };
}
