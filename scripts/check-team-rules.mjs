// Checks src/search/teamPrior.ts against Showdown's own Gen 9 generator: every member of every generated team must fit
// the rules beside the other five, and every generated forme must be one the sampler can draw. No battles, no network.
//   SIMULATOR_DIR=~/.cache/jevmon-sim node scripts/check-team-rules.mjs [teams]
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fitsTeam, revealedProfile, speciesPrior } from '../dist/src/search/teamPrior.js';
const require = createRequire(resolve(process.env.SIMULATOR_DIR || '.', 'package.json'));
const { TeamGenerators } = require('@pkmn/randoms');
const total = Number(process.argv[2] || 20000);
const generator = TeamGenerators.getTeamGenerator('gen9randombattle', [5, 23, 1999, 4242]);
let broken = 0, unknown = 0, pruned = 0, checked = 0;
const examples = [];
for (let t = 0; t < total; t++) {
  const team = generator.getTeam();
  // As a battle shows them: a Rusted Sword or Shield turns Zacian and Zamazenta Crowned before the first turn.
  const shown = p => ({ 'Rusted Sword': 'Zacian-Crowned', 'Rusted Shield': 'Zamazenta-Crowned' })[p.item] ?? p.species;
  const members = team.map(p => revealedProfile(shown(p), `${shown(p)}, L${p.level}`));
  members.forEach((m, i) => {
    if (!speciesPrior.has(m.key)) { unknown++; if (examples.length < 10) examples.push(`not drawable: ${team[i].species} as ${m.key}`); }
    if (!fitsTeam(m.key, members.filter((_, j) => j !== i))) { broken++; if (examples.length < 10) examples.push(`${m.key} refused beside ${members.filter((_, j) => j !== i).map(x => x.key).join(', ')}`); }
  });
  // How much the rules narrow the sixth slot once five are known.
  const five = members.slice(0, 5);
  const allowed = [...speciesPrior.keys()].filter(k => fitsTeam(k, five)).length;
  pruned += 1 - allowed / speciesPrior.size; checked++;
}
console.log(`${total} teams: ${broken} members refused by the rules, ${unknown} formes the sampler cannot draw`);
console.log(`with five known, the rules rule out ${(100 * pruned / checked).toFixed(1)}% of species for the sixth`);
for (const e of examples) console.log('  ' + e);
process.exitCode = broken || unknown ? 1 : 0;
