// How well the unseen-slot sampler predicted real opponents: at each reveal of a new opposing Pokémon in the battle logs,
// the probability it gave that Pokémon with the generator's team rules (teamPrior.ts), against species odds alone with
// only the species clause. A real Pokémon the rules refuse is a bug in them and is printed.
//   npm run build && node scripts/check-team-prior-live.mjs
import { readdirSync, readFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const { fitsTeam, revealedProfile, speciesPrior } = await import(root + 'dist/src/search/teamPrior.js');
const { dex } = await import(root + 'dist/src/pokemon/data.js');
const base = k => dex.species.get(k).baseSpecies || k;
let n = 0, sumRules = 0, sumBase = 0, better = 0, worse = 0, refused = 0;
for (const f of readdirSync(root + 'logs').filter(f => f.startsWith('battle-') && f.endsWith('.jsonl'))) {
  const rows = readFileSync(root + 'logs/' + f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const my = rows.find(r => r.state?.mySide)?.state.mySide; if (!my) continue;
  const foe = my === 'p1' ? 'p2' : 'p1';
  const seen = [];
  for (const r of rows) {
    if (r.event !== 'line') continue;
    const m = new RegExp(`^\\|(switch|drag|replace)\\|${foe}a: [^|]*\\|([^|]+)`).exec(r.line);
    if (!m) continue;
    const details = m[2], species = details.split(',')[0];
    const profile = revealedProfile(species, details);
    if (seen.some(p => p.key === profile.key)) continue;
    if (seen.length) {
      const keys = [...speciesPrior.keys()].filter(k => !seen.some(p => base(p.key) === base(k)));
      const all = keys.reduce((a, k) => a + speciesPrior.get(k), 0);
      const fit = keys.filter(k => fitsTeam(k, seen));
      const fitMass = fit.reduce((a, k) => a + speciesPrior.get(k), 0);
      const prior = speciesPrior.get(profile.key) ?? 0;
      if (prior > 0) {
        const pBase = prior / all, pRules = fit.includes(profile.key) ? prior / fitMass : 0;
        if (!pRules) { refused++; console.log(`REFUSED ${profile.key} beside ${seen.map(p => p.key).join(', ')} (${f.split('-')[2]})`); }
        else { n++; sumRules += Math.log(pRules); sumBase += Math.log(pBase); if (pRules > pBase * 1.001) better++; else if (pRules < pBase * 0.999) worse++; }
      }
    }
    seen.push(profile);
  }
}
console.log(`${n} reveals after the first: mean log-likelihood with rules ${(sumRules / n).toFixed(3)}, species odds alone ${(sumBase / n).toFixed(3)}; ` +
  `the real Pokémon got ${(100 * (Math.exp((sumRules - sumBase) / n) - 1)).toFixed(1)}% more probability on average (geometric); higher in ${better}, lower in ${worse}; refused ${refused}`);
