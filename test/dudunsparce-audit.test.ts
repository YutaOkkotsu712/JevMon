import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { battle, ours } from './helpers.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { setupRaceLost, statusIntoKnockout } from '../src/strategy/dominance.js';
import { incomingThreats } from '../src/strategy/threat.js';
import { sampleWorld, toEngineState } from '../src/search/engineState.js';

const BIN = 'vendor/poke-engine/target/release/poke-engine';
function decide(b: ReturnType<typeof battle>) {
  const request = parseChoiceRequest(JSON.stringify(b.payload(9, b.me().exactHP!.current)))!;
  return { state: b.state, request, legalActions: generateLegalActions(request) };
}

for (const [foe, level, attack] of [['Samurott-Hisui', 78, 'Sucker Punch'], ['Raging Bolt', 75, 'Thunderclap']] as const) {
  test(`${attack} cannot make Thunder Wave or Iron Defense a status-into-knockout mistake`, () => {
    const b = battle([
      ours('Registeel', 81, ['Body Press', 'Iron Head', 'Iron Defense', 'Thunder Wave'], 'Clear Body', 'Leftovers', 'Fighting'),
      ours('Hariyama', 87, ['Close Combat'], 'Guts', 'Flame Orb', 'Normal'),
    ], foe, level);
    b.feed(`|move|p2a: Foe|${attack}|p1a: Registeel\n|-damage|p1a: Registeel|20/262\n|-status|p1a: Registeel|par\n|turn|2`);
    const before = JSON.stringify(b.state);
    const threat = incomingThreats(b.state, b.me(), 'p1', Infinity)!;
    assert.equal(threat.damagingMoves.find(m => m.move === attack)?.conditionalKO, 'all-sampled-rolls', 'still a real danger to an attack');
    assert.equal(statusIntoKnockout(decide(b)).size, 0, 'it fails against our status moves');
    assert.equal(JSON.stringify(b.state), before);
    // A normal revealed attack remains a valid reason to flag the same status moves.
    const ordinary = attack === 'Sucker Punch' ? 'Ceaseless Edge' : 'Thunderbolt';
    b.feed(`|move|p2a: Foe|${ordinary}|p1a: Registeel\n|turn|3`);
    const guarded = statusIntoKnockout(decide(b));
    assert.ok(guarded.has('move-3') && guarded.has('move-4'));
    for (const row of guarded.values()) {
      assert.ok(row.reason.includes(ordinary));
      assert.ok(!row.reason.includes(attack));
    }
  });
}

test('2688825443: active No Retreat cannot supply an imaginary second Speed boost', () => {
  const b = battle([ours('Toxtricity', 82, ['Gunk Shot', 'Boomburst', 'Overdrive', 'Shift Gear'], 'Punk Rock', 'Throat Spray', 'Normal')], 'Falinks', 83);
  b.feed('|move|p2a: Foe|No Retreat|p2a: Foe\n|-boost|p2a: Foe|spe|1\n|-start|p2a: Foe|move: No Retreat\n|turn|2');
  const before = JSON.stringify(b.state);
  assert.equal(setupRaceLost(decide(b)).size, 0);
  assert.equal(JSON.stringify(b.state), before);
  // Only the active volatile prevents reuse. A prior use with no volatile (e.g. already trapped)
  // must not be treated as a permanent once-per-battle prohibition.
  b.feed('|-end|p2a: Foe|move: No Retreat');
  assert.ok(setupRaceLost(decide(b)).has('move-4'));
});

test('2688847541: Calm Mind, Steel Tera and Recover are represented correctly in real search', { skip: !existsSync(BIN) }, () => {
  const b = battle([
    ours('Dipplin', 88, ['Dragon Pulse', 'Sucker Punch', 'Recover', 'Giga Drain'], 'Sticky Hold', 'Eviolite', 'Steel'),
    ours('Feraligatr', 79, ['Liquidation', 'Dragon Dance'], 'Sheer Force', 'Life Orb', 'Water'),
  ], 'Dudunsparce', 83);
  b.state.sides.p2.teamSize = 1;
  b.feed('|-terastallize|p1a: Dipplin|Steel\n|-item|p2a: Foe|Leftovers');
  for (const move of ['Boomburst', 'Calm Mind', 'Roost', 'Earth Power']) b.feed(`|move|p2a: Foe|${move}|p1a: Dipplin`);
  b.feed('|-boost|p2a: Foe|spa|2\n|-boost|p2a: Foe|spd|2\n|turn|20');
  const before = JSON.stringify(b.state);
  const instructions = (their: string) => execFileSync(BIN, ['generate-instructions', '--state',
    toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', () => 0.5)).state, '-o', 'recover', '-t', their], { encoding: 'utf8' });
  const setup = instructions('calmmind');
  assert.match(setup, /Boost SideTwo SpecialAttack: 1/);
  assert.match(setup, /Boost SideTwo SpecialDefense: 1/);
  assert.doesNotMatch(setup, /Heal SideOne/);
  const attack = instructions('earthpower');
  assert.match(attack, /Damage SideOne/);
  assert.match(attack, /Heal SideOne/, 'a slower heal can still restore a surviving hit');
  assert.equal(JSON.stringify(b.state), before);
  b.feed('|-boost|p2a: Foe|spa|4\n|-boost|p2a: Foe|spd|4\n|turn|24');
  assert.equal(incomingThreats(b.state, b.me(), 'p1', Infinity)!.damagingMoves.find(m => m.move === 'Earth Power')!.conditionalKO, 'all-sampled-rolls');
  const ko = instructions('earthpower');
  assert.match(ko, /Damage SideOne: 284/);
  assert.doesNotMatch(ko, /Heal SideOne/);
});
