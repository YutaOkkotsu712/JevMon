// Independent Showdown checks for the 2026-09-28 guard audit; no ladder or model calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
if (!process.env.SIMULATOR_DIR) throw new Error('Set SIMULATOR_DIR to a directory containing @pkmn/sim');
const { Battle } = createRequire(resolve(process.env.SIMULATOR_DIR, 'package.json'))('@pkmn/sim');
const set = (species, moves, ability, item = '', level = 80) => ({ species, moves, ability, item, level,
  evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 } });
let checks = 0;
function check(ours, theirs, verify) {
  const sim = new Battle({ formatid: 'gen9customgame', seed: [41, 27, 32, 18],
    p1: { name: 'Us', team: [ours] }, p2: { name: 'Them', team: [theirs] } });
  try {
    if (sim.requestState === 'teampreview') sim.makeChoices('team 1', 'team 1');
    verify(sim, sim.p1.active[0], sim.p2.active[0]);
    checks++;
  } finally { sim.destroy(); }
}

for (const [species, attack, ability] of [
  ['Samurott-Hisui', 'Sucker Punch', 'Sharpness'], ['Raging Bolt', 'Thunderclap', 'Protosynthesis'],
]) for (const ourMove of ['Thunder Wave', 'Iron Defense', 'Body Press']) {
  check(set('Registeel', [ourMove], 'Clear Body', '', 81), set(species, [attack], ability), (sim, me) => {
    me.hp = 20; me.setStatus('par');
    sim.makeChoices('move 1', 'move 1');
    assert.equal(me.hp, ourMove === 'Body Press' ? 0 : 20, sim.log.join('\n'));
  });
}

for (const trapped of [false, true]) {
  check(set('Falinks', ['No Retreat'], 'Defiant'), set('Magikarp', ['Splash'], 'Swift Swim'), (sim, me) => {
    if (trapped) me.addVolatile('trapped');
    sim.makeChoices('move 1', 'move 1');
    sim.makeChoices('move 1', 'move 1');
    // Already trapped before the first use: no No Retreat volatile is added, so it can be reused.
    assert.equal(me.boosts.spe, trapped ? 2 : 1, sim.log.join('\n'));
  });
}

for (const [boost, theirMove, expectedHP] of [[2, 'Calm Mind', 284], [2, 'Earth Power', null], [6, 'Earth Power', 0]]) {
  check(set('Dipplin', ['Recover'], 'Sticky Hold', 'Eviolite', 88),
    set('Dudunsparce', [theirMove], 'Rattled', 'Leftovers', 83), (sim, me, foe) => {
      me.terastallized = 'Steel'; foe.boosts.spa = boost; foe.boosts.spd = boost;
      sim.makeChoices('move 1', 'move 1');
      if (expectedHP !== null) assert.equal(me.hp, expectedHP, sim.log.join('\n'));
      else assert.ok(me.hp > 0 && sim.log.some(l => l.startsWith('|-heal|p1a:')), sim.log.join('\n'));
      if (theirMove === 'Calm Mind') {
        assert.ok(sim.log.some(l => l.startsWith('|-fail|p1a:') && l.endsWith('|heal')), sim.log.join('\n'));
      }
    });
}
console.log(JSON.stringify({ checks, result: 'passed' }));
