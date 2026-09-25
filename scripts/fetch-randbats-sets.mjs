// Build the candidate set pool from pkmn/randbats `data/full`: every complete (item, ability, moves, Tera)
// combination actually generated, with its occurrence count. That is a joint distribution, unlike the
// marginal frequencies in the stats file, and unlike locally resampling the generator it misses nothing.
//
// `data/full` records no EVs or IVs. Random battles use 85 EVs and 31 IVs except where a role overrides them,
// so each set is attributed to the roles whose pool could have produced it and takes their spread. When those
// roles disagree, every distinct spread is emitted and the set's probability is split by role weight, rather
// than guessing one.
import { readFileSync, writeFileSync } from 'node:fs';
import { Dex } from '@pkmn/dex';

const SETS = 'https://pkmn.github.io/randbats/data/full/gen9randombattle.json';
const nid = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
// The damage calculator matches items, abilities and Tera types by display name, so store those, not IDs.
const dex = Dex.forGen(9);
function name(kind, value) {
  if (!value) return '';
  const entry = dex[kind].get(value);
  if (!entry?.exists) throw new Error(`Unrecognised ${kind} in the set data: ${value}`);
  return entry.name;
}
const stats = JSON.parse(readFileSync(new URL('../src/data/gen9-randbats-stats.json', import.meta.url)));
const byId = new Map(Object.entries(stats).map(([name, entry]) => [nid(name), entry]));

const response = await fetch(SETS, { redirect: 'error' });
if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
const raw = await response.json();
if (Object.keys(raw).length < 400) throw new Error(`Unexpected species count: ${Object.keys(raw).length}`);

const defaults = { evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 } };
const spreadOf = (role) => ({
  evs: { ...defaults.evs, ...(role.evs ?? {}) },
  ivs: { ...defaults.ivs, ...(role.ivs ?? {}) },
});

/** Roles whose generated pool could have produced this exact set. */
function matchingRoles(entry, set) {
  return Object.values(entry.roles).filter(role =>
    set.moves.every(m => Object.keys(role.moves).some(v => nid(v) === m)) &&
    Object.keys(role.abilities).some(v => nid(v) === set.ability) &&
    Object.keys(role.teraTypes).some(v => nid(v) === set.tera) &&
    (set.item
      ? Object.keys(role.items ?? {}).some(v => nid(v) === set.item)
      : !Object.keys(role.items ?? {}).length));
}

const species = {};
let totalSets = 0, totalDraws = 0, unattributed = 0, splitByRole = 0, levelMismatch = 0;
for (const [id, combos] of Object.entries(raw)) {
  const entry = byId.get(id);
  if (!entry) throw new Error(`No statistics entry for ${id}`);
  const draws = Object.values(combos).reduce((n, v) => n + v, 0);
  if (!draws) throw new Error(`No recorded draws for ${id}`);
  totalDraws += draws;
  const out = [];
  for (const [key, count] of Object.entries(combos)) {
    const parts = key.split(',');
    if (parts.length < 5) throw new Error(`Malformed set key for ${id}: ${key}`);
    const level = Number(parts[0]);
    if (level !== entry.level) levelMismatch++;
    const set = { item: parts[1], ability: parts[2], moves: parts.slice(3, -1), tera: parts.at(-1) };
    if (!set.ability || !set.tera || !set.moves.length) throw new Error(`Malformed set key for ${id}: ${key}`);
    const roles = matchingRoles(entry, set);
    // Only the spreads actually differ; several roles sharing one spread need only one candidate.
    const groups = new Map();
    for (const role of roles) {
      const spread = spreadOf(role);
      const k = JSON.stringify(spread);
      groups.set(k, { spread, weight: (groups.get(k)?.weight ?? 0) + role.weight });
    }
    if (!groups.size) { unattributed++; groups.set('default', { spread: spreadOf({}), weight: 1 }); }
    if (groups.size > 1) splitByRole++;
    const total = [...groups.values()].reduce((n, g) => n + g.weight, 0);
    for (const { spread, weight } of groups.values()) {
      out.push({
        ability: name('abilities', set.ability), item: name('items', set.item),
        moves: [...set.moves].sort(), teraType: name('types', set.tera),
        evs: spread.evs, ivs: spread.ivs,
        probability: Math.round(count / draws * (weight / total) * 1e6) / 1e6,
      });
    }
  }
  const mass = out.reduce((n, c) => n + c.probability, 0);
  if (Math.abs(mass - 1) > 0.01) throw new Error(`${id} probabilities sum to ${mass}`);
  totalSets += out.length;
  species[id] = out.sort((a, b) => b.probability - a.probability);
}
if (levelMismatch) throw new Error(`${levelMismatch} set keys disagree with the statistics level`);

writeFileSync(new URL('../src/data/gen9-joint-sets.json', import.meta.url), JSON.stringify({
  source: SETS, snapshot: new Date().toISOString().slice(0, 10), recordedDraws: totalDraws, exhaustive: false, species,
}));
console.log(`Wrote ${totalSets} candidates across ${Object.keys(species).length} species from ${totalDraws} recorded draws`);
console.log(`  sets split across disagreeing role spreads: ${splitByRole}`);
console.log(`  sets no role could account for: ${unattributed}`);
