// Refresh the pkmn/randbats statistics snapshot: the public feed behind Showdex and the
// Randbats Tooltip. Read-only, and it fails closed rather than writing a malformed snapshot.
import { writeFileSync } from 'node:fs';
const URL_ = 'https://pkmn.github.io/randbats/data/stats/gen9randombattle.json';
const response = await fetch(URL_, { redirect: 'error' });
if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
const data = await response.json();
const rates = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.values(value).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
const entries = Object.entries(data);
if (entries.length < 400) throw new Error(`Unexpected species count: ${entries.length}`);
for (const [name, entry] of entries) {
  const roles = Object.values(entry?.roles ?? {});
  if (!Number.isInteger(entry?.level) || !roles.length) throw new Error(`Malformed entry: ${name}`);
  for (const role of roles) {
    if (typeof role.weight !== 'number' || role.weight <= 0) throw new Error(`Malformed role weight: ${name}`);
    // A role with no item (the Acrobatics sets) omits `items` entirely.
    for (const key of ['abilities', 'teraTypes', 'moves']) {
      if (!rates(role[key])) throw new Error(`Malformed ${key} frequencies: ${name}`);
    }
    if (role.items !== undefined && !rates(role.items)) throw new Error(`Malformed items frequencies: ${name}`);
  }
}
writeFileSync(new URL('../src/data/gen9-randbats-stats.json', import.meta.url), JSON.stringify(data));
console.log(`Wrote ${entries.length} species from ${URL_}`);
