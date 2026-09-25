/**
 * Abilities that turn a status into an advantage for the Pokémon carrying it. Landing one of these statuses on such a
 * Pokémon spends our turn making theirs stronger: Will-O-Wisp is meant to halve an attacker, and into Guts it does the
 * opposite, since Guts gives 1.5× Attack under any status and ignores the burn's halving.
 */
const noun = (status: string) => (status === 'brn' ? 'the burn' : status === 'par' ? 'the paralysis' : 'the poison');
export const statusBoosters: Record<string, { statuses: string[]; why: (status: string) => string }> = {
  guts: { statuses: ['brn', 'par', 'psn', 'tox'],
    why: s => `Guts turns ${noun(s)} into 1.5× Attack${s === 'brn' ? ' and ignores the burn\'s halving' : ''}, so it hits harder` },
  marvelscale: { statuses: ['brn', 'par', 'psn', 'tox'], why: () => 'Marvel Scale gives it 1.5× Defense while it has a status' },
  quickfeet: { statuses: ['brn', 'par', 'psn', 'tox'],
    why: s => `Quick Feet gives it 1.5× Speed while it has a status${s === 'par' ? ', and the paralysis no longer slows it' : ''}` },
  toxicboost: { statuses: ['psn', 'tox'], why: () => 'Toxic Boost gives it 1.5× physical damage while poisoned' },
  flareboost: { statuses: ['brn'], why: () => 'Flare Boost gives it 1.5× special damage while burned' },
};
/** Poison Heal heals on poison and Magic Guard takes no poison damage: poisoning either is a gift or nothing. */
const wasted: Record<string, { statuses: string[]; why: (status: string) => string }> = {
  poisonheal: { statuses: ['psn', 'tox'], why: () => 'Poison Heal turns the poison into an eighth of max HP healed every turn' },
  magicguard: { statuses: ['psn', 'tox'], why: () => 'Magic Guard means the poison deals no damage at all' },
};
/** The boosting abilities that answer `status`. */
export const boostersFor = (status: string) => Object.keys(statusBoosters).filter(a => statusBoosters[a]!.statuses.includes(status));
/** Every ability that makes landing `status` a gift or a wasted turn, with why. */
export function giftsFor(status: string) {
  return Object.entries({ ...statusBoosters, ...wasted }).filter(([, g]) => g.statuses.includes(status))
    .map(([ability, g]) => ({ ability, why: g.why(status) }));
}
