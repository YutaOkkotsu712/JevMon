// Deterministic, simulator-backed Substitute HP tracking; no network/API calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { BattleTracker } from '../dist/src/battle/BattleTracker.js';
import { parseFrame } from '../dist/src/showdown/protocol.js';
if (!process.env.SIMULATOR_DIR) throw new Error('Set SIMULATOR_DIR');
const require = createRequire(resolve(process.env.SIMULATOR_DIR, 'package.json'));
const { Battle, extractChannelMessages } = require('@pkmn/sim');
const room = 'battle-gen9randombattle-subtest', tracker = new BattleTracker(room, 'Test Bot');
const feed = text => { for (const m of parseFrame(`>${room}\n${text}`)) tracker.handle(m); };
const spreads = { level: 84, nature: 'Serious', evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 } };
const battle = new Battle({ formatid: 'gen9customgame', seed: [41, 27, 32, 18],
  p1: { name: 'Test Bot', team: [{ ...spreads, species: 'Blastoise', ability: 'Torrent', moves: ['Water Gun','Surf','Psychic Noise'] }] },
  p2: { name: 'Opponent', team: [{ ...spreads, species: 'Blissey', ability: 'Natural Cure', moves: ['Substitute','Splash'] }] },
  send(type, data) {
    const text = Array.isArray(data) ? data.join('\n') : data;
    if (type === 'update') feed(extractChannelMessages(text, [1])[1].join('\n'));
    else if (type === 'sideupdate' && text.startsWith('p1\n')) feed(text.slice(3));
  } });
battle.sendUpdates();
if (battle.requestState === 'teampreview') { battle.makeChoices('team 1','team 1'); battle.sendUpdates(); }
battle.makeChoices('move 1','move 1'); battle.sendUpdates();
const knownFoe = () => tracker.state.sides.p2.team.find(p => p.id === tracker.state.sides.p2.activeId);
let checks = 0;
for (let turn = 0; turn < 4; turn++) {
  const actual = battle.sides[1].active[0].volatiles.substitute?.hp;
  const observed = knownFoe()?.substitute?.hp;
  assert.ok(actual > 0, 'the test opponent must retain its Substitute');
  assert.ok(observed && observed[0] <= actual && observed[1] >= actual, `actual ${actual} must be inside inferred ${observed}`);
  checks++;
  battle.makeChoices('move 1','move 2'); battle.sendUpdates();
}
// Sound bypasses: holder loses HP, existing Substitute's true HP does not change.
const before = battle.sides[1].active[0].volatiles.substitute.hp;
battle.makeChoices('move 3','move 2'); battle.sendUpdates();
assert.equal(battle.sides[1].active[0].volatiles.substitute.hp, before);
assert.ok(knownFoe().substitute.hp[0] <= before && knownFoe().substitute.hp[1] >= before);
console.log(JSON.stringify({ result: 'passed', substituteHPIntervalChecks: checks, soundBypass: true }));
battle.destroy();
