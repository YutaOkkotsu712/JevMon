import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { id } from '../pokemon/data.js';
import { incomingThreats } from './threat.js';
import { residuals } from './residual.js';
import { sleepTalkMoves } from './risk.js';

/**
 * What Rest actually costs, which "User sleeps 2 turns" misstates for most Rest users. A Chesto or Lum Berry wakes the
 * user at once, so Rest is a full heal for this turn and the berry; with Sleep Talk the two turns are spent acting at
 * random; without either they are lost outright. What the worst incoming hit leaves after those turns is what decides
 * whether resting is a way to stall a matchup or only a slower way to lose it.
 */
export function restPlan(s: BattleState, me: PokemonState, side: SideId) {
  const berry = id(me.item) === 'chestoberry' ? 'Chesto Berry' : id(me.item) === 'lumberry' ? 'Lum Berry' : null;
  const talk = sleepTalkMoves(me);
  const asleep = berry ? 0 : 2;
  const threat = incomingThreats(s, me, side, 1);
  const worst = threat?.worstCasePercentOfMaxHP ?? null;
  const balance = residuals(s, me, side)?.perTurnPercentOfMaxHP;
  const residual = Array.isArray(balance) ? balance[0]! : balance ?? 0;
  const after = worst === null || !asleep ? null : Math.max(0, Math.round((100 - asleep * worst + asleep * residual) * 10) / 10);
  return {
    restoresToFullHP: true,
    ...(me.status && me.status !== 'slp' ? { curesStatus: me.status } : {}),
    ...(berry ? { wakesAtOnce: berry, turnsLostToSleep: 0, note: `the ${berry} is eaten as Rest puts us to sleep, so Rest costs only this turn` }
      : talk ? { turnsAsleep: 2, actsThroughSleepTalk: talk.picks, note: 'asleep for two turns, each spent on a random pick from Sleep Talk' }
      : { turnsLostToSleep: 2, note: 'asleep for two turns without Sleep Talk: the opponent gets two free turns' }),
    ...(after === null ? {} : { worstHitPerTurnWhileAsleepPercent: worst, hpAfterTwoWorstTurnsAsleepPercent: after, survivesTheSleep: after > 0 }),
  };
}
