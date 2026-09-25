import { Dex } from '@pkmn/dex';
export const dex = Dex.forGen(9);
export const id = (value: string | null | undefined) => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Cosmetic formes — Vivillon's wing patterns, Alcremie's flavours, Sawsbuck's seasons — are the same Pokémon
 * with a different sprite: identical types, stats and abilities. Neither the random-battle dataset nor the
 * calculator carries them, so a Vivillon-Sun matched no set and threw on every damage call, which left an
 * entire opponent with no estimate for a whole battle. Anything with genuinely different stats, Minior-Meteor
 * among them, is not in `cosmeticFormes` and is left exactly as it is.
 */
export function canonicalSpecies(name: string): string {
  const species = dex.species.get(name);
  if (!species.exists) return name;
  if (!species.baseSpecies || species.baseSpecies === species.name) return species.name;
  const base = dex.species.get(species.baseSpecies);
  return base.exists && base.cosmeticFormes?.includes(species.name) ? base.name : species.name;
}

/**
 * The random-battle datasets key a species however the generator names it, which is not always what the
 * protocol sends: the Gen 9 pools list only `Keldeo-Resolute`, so a battle naming plain `Keldeo` matched
 * nothing and left that opponent with no sets and therefore no damage estimate at all for the whole game.
 * Resolve by exact id, then by cosmetic base, then by any key sharing this species' base form.
 */
const baseFormeIndex = new WeakMap<object, Map<string, string>>();
export function datasetSpeciesId(species: string, keys: Set<string>): string {
  const direct = id(canonicalSpecies(species));
  if (keys.has(direct)) return direct;
  const exact = id(species);
  if (keys.has(exact)) return exact;
  // A battle-only forme is generated as the forme it changes from, so its sets are that forme's. Without this,
  // Mimikyu-Busted, Eiscue-Noice and Palafin-Hero lost every set, and every estimate, the moment they changed.
  const from = dex.species.get(species).battleOnly;
  for (const name of Array.isArray(from) ? from : from ? [from] : []) if (keys.has(id(name))) return id(name);
  let index = baseFormeIndex.get(keys);
  if (!index) {
    index = new Map();
    for (const key of keys) {
      const base = id(dex.species.get(key).baseSpecies || key);
      // First key wins, so a species with several formes resolves deterministically.
      if (!index.has(base)) index.set(base, key);
    }
    baseFormeIndex.set(keys, index);
  }
  // A forme the pools do not list goes to its base species' sets. The index is keyed by base, so it has to be asked
  // with this forme's base: asking with the forme's own id found nothing, and Maushold-Four, Tatsugiri-Droopy,
  // Toxtricity-Low-Key, the Pikachu caps and 17 more formes lost every set, and every estimate, for the whole game.
  const base = id(dex.species.get(species).baseSpecies);
  return index.get(direct) ?? index.get(exact) ?? (base ? index.get(base) : undefined) ?? direct;
}
