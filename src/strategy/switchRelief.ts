import type { BattleState, PokemonState, SideId } from '../battle/BattleState.js';
import { id } from '../pokemon/data.js';
import { residuals } from './residual.js';

// Gen 9 ordinary switches. Baton Pass transfers some effects and is deliberately not priced here.
const harmful: Record<string, string> = {
  leechseed: 'stops Leech Seed drain and its transfer to the opposing slot',
  saltcure: 'stops Salt Cure damage', curse: 'removes the Ghost-type Curse residual',
  nightmare: 'ends Nightmare damage while asleep; sleep itself remains',
  confusion: 'removes confusion and its conditional one-third self-hit risk',
  attract: 'removes infatuation and its conditional one-half immobilisation risk',
  yawn: 'removes pending Yawn sleep before it triggers',
  perishsong: 'removes the Perish Song countdown',
  encore: 'ends Encore move restriction', disable: 'restores the disabled move',
  taunt: 'ends Taunt', torment: 'ends Torment', healblock: 'ends Heal Block',
  embargo: 'ends Embargo',
  throatchop: 'restores sound moves', syrupbomb: 'ends recurring Syrup Bomb Speed drops',
  partiallytrapped: 'ends binding damage only if a legal escape is available',
  trapped: 'ends trapping only if a legal escape is available',
  octolock: 'ends Octolock trapping and recurring defensive drops if escape is legal',
  telekinesis: 'removes Telekinesis; also loses its Ground immunity',
};
const costs: Record<string, string> = {
  substitute: 'loses Substitute', aquaring: 'loses Aqua Ring recovery', ingrain: 'loses Ingrain recovery',
  focusenergy: 'loses Focus Energy', laserfocus: 'loses Laser Focus',
  magnetrise: 'loses Magnet Rise Ground immunity', stockpile: 'loses Stockpile',
  defensecurl: 'loses Defense Curl rollout bonus', charge: 'loses Charge',
  noretreat: 'clears No Retreat state only if leaving is legal; stat boosts are lost',
  slowstart: 'restarts Slow Start on return',
  protosynthesis: 'loses this activation; weather or an available Booster Energy is needed to activate again',
  quarkdrive: 'loses this activation; terrain or an available Booster Energy is needed to activate again',
  minimize: 'loses Minimize state', powertrick: 'resets Power Trick',
  smackeddown: 'removes Smack Down grounding', smackdown: 'removes Smack Down grounding',
  gastroacid: 'ends Gastro Acid ability suppression',
  typechange: 'resets temporary type changes; Terastallization persists',
  typeadd: 'removes added types', foresight: 'removes Foresight', miracleeye: 'removes Miracle Eye',
  tarshot: 'removes Tar Shot Fire vulnerability',
};
const chipNames = new Set(['leechseed', 'saltcure', 'curse', 'nightmare', 'partialtrapping']);

export function switchRelief(s: BattleState, p: PokemonState, side: SideId) {
  if (p.fainted) return null;
  const entries = Object.entries(p.volatiles);
  const clears = entries.flatMap(([name]) => {
    const key = id(name), reason = harmful[key] ?? (/^perish[0-3]$/.test(key) ? harmful.perishsong : undefined);
    return reason ? [{ effect: name, benefit: reason }] : [];
  });
  const changes = entries.flatMap(([name]) => costs[id(name)] ? [{ effect: name, consequence: costs[id(name)]! }] : []);
  if (p.substitute && !entries.some(([name]) => id(name) === 'substitute')) changes.push({ effect: 'Substitute', consequence: costs.substitute! });
  const unpriced = entries.filter(([name]) => !harmful[id(name)] && !costs[id(name)] && !/^perish[0-3]$/.test(id(name))).map(([name]) => name);
  const drops = Object.fromEntries(Object.entries(p.boosts).filter(([, n]) => n < 0));
  const boosts = Object.fromEntries(Object.entries(p.boosts).filter(([, n]) => n > 0));
  const ability = p.abilitySuppressed ? '' : id(p.ability ?? '');
  const naturalCure = ability === 'naturalcure' && !!p.status;
  const regen = ability === 'regenerator' && p.hpPercent !== null ? Math.min(100 - p.hpPercent, 100 / 3) : 0;
  const toxicRelief = p.status === 'tox' && p.toxicTurns > 0 && !['magicguard', 'poisonheal'].includes(ability);
  const choice = ['choiceband', 'choicespecs', 'choicescarf'].includes(id(p.item ?? '')) && p.lastMoveUsed;
  if (!entries.length && !p.substitute && !Object.keys(drops).length && !Object.keys(boosts).length && !p.status && !regen && !choice) return null;
  const residual = residuals(s, p, side);
  // This reuses ability-aware damage sources (e.g. Magic Guard), and never calls the number healing.
  const removedChip = -(residual?.sources.filter(x => chipNames.has(id(x.source))).reduce((sum, x) => sum + Math.min(0, x.percent), 0) ?? 0);
  const foeSide = s.sides[side === 'p1' ? 'p2' : 'p1'];
  const bindingItemUnknown = entries.some(([name]) => id(name) === 'partiallytrapped') &&
    foeSide.team.find(x => x.id === foeSide.activeId)?.item == null;
  const perish = entries.map(([name]) => /^perish([0-3])$/.exec(id(name))).filter(x => x !== null).map(x => Number(x[1]));
  return {
    scope: 'ordinary switch, conditional on successfully leaving; incoming damage and hazards are separate',
    ...(clears.length ? { clears } : {}),
    ...(removedChip > 0 ? { avoidsResidualPercentOfOutgoingMaxHPPerTurn: Math.round(removedChip * 10) / 10,
      ...(residual?.sourcesDescribeTheMostLikelySetOnly ? { residualEstimateUsesMostLikelySet: true } : {}) } : {}),
    ...(bindingItemUnknown ? { bindingDamageUncertainty: 'Binding Band is unknown: binding alone can cost 12.5–16.7% per turn before prevention; the residual estimate uses 12.5%.' } : {}),
    ...(perish.length ? { perishCount: Math.min(...perish) } : {}),
    ...(Object.keys(drops).length ? { removesStatDrops: drops } : {}),
    ...(Object.keys(boosts).length ? { losesStatBoosts: boosts } : {}),
    ...(changes.length ? { otherChanges: changes } : {}),
    ...(unpriced.length ? { effectsNotPriced: unpriced } : {}),
    ...(naturalCure ? { curesStatus: p.status } : {}),
    ...(!naturalCure && p.status ? { statusPersists: p.status } : {}),
    ...(p.status === 'tox' && !naturalCure ? { toxicCounterRestartsOnReturn: true, poisonIsNotCured: true } : {}),
    ...(regen > 0 ? { regeneratorHealsPercentOfMaxHP: Math.round(regen * 10) / 10 } : {}),
    ...(choice ? { clearsChoiceLock: p.lastMoveUsed } : {}),
    ...(p.sameMoveStreak >= 3 && removedChip > 0 ? { repeatedMoveWhileDraining: { move: p.lastMoveUsed, consecutiveUses: p.sameMoveStreak,
      warning: 'Repeated damage is not necessarily progress: compare their recovery and Substitute with our drain, and evaluate a legal switch.' } } : {}),
    hasRelief: clears.length > 0 || Object.keys(drops).length > 0 || naturalCure || regen > 0 || !!choice || toxicRelief,
  };
}
