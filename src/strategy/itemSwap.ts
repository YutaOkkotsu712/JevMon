import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { dex, id } from '../pokemon/data.js';
import { turnOrder } from './speed.js';

const choiceItems = new Set(['choiceband', 'choicespecs', 'choicescarf']);

/** What giving away our Choice item can accomplish this turn and on a repeated opposing switch. */
export function choiceTrickOutlook(s: BattleState, me: PokemonState, foe: PokemonState, side: SideId,
  moveName: string, observedSwitchTo?: string) {
  const move = dex.moves.get(moveName);
  if (!['trick', 'switcheroo'].includes(move.id) || !choiceItems.has(id(me.item))) return null;
  const order = turnOrder(s, me, move.name)?.order ?? 'uncertain';
  const setupOrRecovery = foe.revealedMoves.map(name => dex.moves.get(name))
    .filter(m => m.exists && m.category === 'Status' &&
      (m.flags.heal || !!m.boosts || !!m.self?.boosts))
    .map(m => m.name);
  const theirSide = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const arrival = theirSide.team.find(p => p.species === observedSwitchTo && !p.fainted && p.id !== theirSide.activeId);
  const theirs = foe.item === null ? 'unrevealed' : foe.item === '' ? 'no item' : dex.items.get(foe.item).name;
  const entering = arrival?.item === null ? 'unrevealed' : arrival?.item === '' ? 'no item' : arrival?.item ? dex.items.get(arrival.item).name : null;
  return {
    gives: dex.items.get(me.item!).name,
    takesIfTheyStay: theirs,
    ourChoiceLockEndsIfWeTakeNonChoiceItem: foe.item === null ? 'depends on their item' : !choiceItems.has(id(foe.item)),
    ifTheyStay: {
      swapBeforeTheirMove: order === 'ours-first' ? true : order === 'theirs-first' ? false : null,
      theirRevealedSetupOrRecovery: setupOrRecovery,
      effect: 'if the swap happens before they act, the Choice item locks the move they choose this turn until they switch',
      ...(foe.substitute ? { blockedByTheirSubstitute: true } : {}),
      ...(id(foe.ability) === 'stickyhold' ? { blockedByStickyHold: true } : {}),
    },
    ...(arrival ? { ifTheyRepeatObservedSwitch: { incoming: arrival.species, itsItem: entering,
      effect: 'the incoming Pokemon gets the Choice item; its held item is taken if removable' } } : {}),
  };
}
