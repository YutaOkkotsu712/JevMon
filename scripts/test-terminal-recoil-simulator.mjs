// Independent Gen 9 terminal-result oracle. Uses the optional external simulator, with no bot/API calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
if (!process.env.SIMULATOR_DIR) throw new Error('Set SIMULATOR_DIR to a directory containing @pkmn/sim');
const { Battle } = createRequire(resolve(process.env.SIMULATOR_DIR, 'package.json'))('@pkmn/sim');
const cases = [
  { name: 'Life Orb final KO', orb: true, winner: 'Attacker', hp: 0 },
  { name: 'Life Orb with opposing reserve', orb: true, reserve: true, winner: 'Defender', hp: 0 },
  { name: 'Life Orb into Protect', orb: true, protect: true, winner: undefined, hp: 1 },
  { name: 'Brave Bird final KO', move: 'Brave Bird', targetHP: 30, winner: 'Attacker', hp: 0 },
  { name: 'Rocky Helmet final KO', item: 'Rocky Helmet', winner: 'Attacker', hp: 0 },
  { name: 'Rough Skin final KO', ability: 'Rough Skin', winner: 'Attacker', hp: 0 },
  { name: 'Destiny Bond final KO', bond: true, winner: 'Attacker', hp: 0 },
  { name: 'Explosion final KO', move: 'Explosion', winner: 'Defender', hp: 0 },
  { name: 'Final KO before burn residual', burn: true, winner: 'Attacker', hp: 1 },
];
let checks = 0;
for (const c of cases) for (const reversed of [false, true]) {
  const attacker = { name: 'Attacker', team: [{ species: 'Iron Leaves', level: 80, ability: 'Quark Drive',
    item: c.orb ? 'Life Orb' : '', moves: [c.move ?? 'Leaf Blade'] }] };
  const defender = { name: 'Defender', team: [{ species: 'Vaporeon', level: 80,
    ability: c.ability ?? 'Water Absorb', item: c.item ?? '', moves: [c.protect ? 'Protect' : 'Splash'] }] };
  if (c.reserve) defender.team.push({ species: 'Mew', level: 80, ability: 'Synchronize', item: '', moves: ['Splash'] });
  const sim = new Battle({ formatid: 'gen9customgame', seed: [41, 27, 32, 18],
    p1: reversed ? defender : attacker, p2: reversed ? attacker : defender });
  try {
    if (sim.requestState === 'teampreview') sim.makeChoices(reversed && c.reserve ? 'team 12' : 'team 1', !reversed && c.reserve ? 'team 12' : 'team 1');
    const a = sim.sides[reversed ? 1 : 0].active[0], d = sim.sides[reversed ? 0 : 1].active[0];
    a.hp = 1; d.hp = c.targetHP ?? 1;
    if (c.bond) d.addVolatile('destinybond');
    if (c.burn) a.setStatus('brn');
    sim.makeChoices('move 1', 'move 1');
    assert.equal(sim.winner, c.winner, `${c.name}, reversed=${reversed}: ${sim.log.slice(-15)}`);
    assert.equal(a.hp, c.hp, c.name);
    assert.equal(d.hp, c.protect ? 1 : 0, c.name);
    checks++;
  } finally { sim.destroy(); }
}
console.log(JSON.stringify({ result: 'passed', simulatorChecks: checks, cases: cases.map(c => c.name) }));
