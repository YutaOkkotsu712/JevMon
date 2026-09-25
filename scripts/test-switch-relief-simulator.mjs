// Uses official Showdown mechanics to check the tracker and ordinary-switch relief; no API calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { BattleTracker } from '../dist/src/battle/BattleTracker.js';
import { parseFrame } from '../dist/src/showdown/protocol.js';
import { switchRelief } from '../dist/src/strategy/switchRelief.js';
if (!process.env.SIMULATOR_DIR) throw new Error('Set SIMULATOR_DIR');
const require = createRequire(resolve(process.env.SIMULATOR_DIR, 'package.json'));
const { Battle, extractChannelMessages } = require('@pkmn/sim');
const room = 'battle-gen9randombattle-relieftest';
let checked = 0;
for (const effect of ['leechseed','saltcure','confusion','attract','yawn','curse','nightmare','perishsong','taunt','disable','torment','healblock']) {
  const tracker = new BattleTracker(room, 'Test Bot');
  const feed = text => { for (const m of parseFrame(`>${room}\n${text}`)) tracker.handle(m); };
  const sim = new Battle({ formatid: 'gen9customgame', seed: [41, 27, 32, 18],
    p1: { name: 'Test Bot', team: [
      { species: 'Bisharp', gender: 'M', ability: 'Defiant', moves: ['Splash','Tackle'] },
      { species: 'Empoleon', ability: 'Torrent', moves: ['Splash'] }] },
    p2: { name: 'Opponent', team: [{ species: 'Venusaur', gender: 'F', ability: 'Overgrow', moves: ['Splash'] }] },
    send(type, data) {
      const text = Array.isArray(data) ? data.join('\n') : data;
      if (type === 'update') feed(extractChannelMessages(text, [1])[1].join('\n'));
      else if (type === 'sideupdate' && text.startsWith('p1\n')) feed(text.slice(3));
    } });
  sim.sendUpdates();
  if (sim.requestState === 'teampreview') { sim.makeChoices('team 12','team 1'); sim.sendUpdates(); }
  sim.makeChoices('move 1','move 1'); sim.sendUpdates();
  const outgoing = sim.sides[0].active[0], source = sim.sides[1].active[0];
  outgoing.lastMove = sim.dex.moves.get('splash');
  outgoing.setStatus('slp', source);
  assert.ok(outgoing.addVolatile(effect, source, sim.dex.moves.get(effect)), `${effect} applied`);
  // Perish Song announces its counter during the residual event, not at application.
  if (effect === 'perishsong') {
    outgoing.volatiles[effect].duration = 3;
    sim.singleEvent('Residual', sim.dex.conditions.get(effect), outgoing.volatiles[effect], outgoing);
  }
  sim.sendUpdates();
  const p = tracker.state.sides.p1.team.find(p => p.id === tracker.state.sides.p1.activeId);
  const r = switchRelief(tracker.state, p, 'p1');
  assert.ok(r?.clears?.length, `${effect} is explained in the payload`);
  assert.equal(r.statusPersists, 'slp');
  sim.makeChoices('switch 2','move 1'); sim.sendUpdates();
  assert.equal(sim.sides[0].active[0].species.name, 'Empoleon');
  assert.equal(outgoing.volatiles[effect], undefined, `${effect} clears in the simulator`);
  assert.deepEqual(p.volatiles, {}, `${effect} clears in the tracker`);
  assert.equal(outgoing.status, 'slp', 'switch does not wake the outgoing Pokémon');
  sim.destroy(); checked++;
}
console.log(JSON.stringify({ result: 'passed', ordinarySwitchEffectsChecked: checked, persistentSleepPreserved: true }));
