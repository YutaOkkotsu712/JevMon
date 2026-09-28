import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { battle, ours } from './helpers.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { incomingThreats } from '../src/strategy/threat.js';
import { outhealed, statusIntoKnockout } from '../src/strategy/dominance.js';
import { afterEntry } from '../src/strategy/entry.js';
import { afterTeraShift } from '../src/strategy/teraShift.js';
import { sampleWorld, toEngineState } from '../src/search/engineState.js';
import { engineName, searchWorlds } from '../src/search/search.js';

const BIN = 'vendor/poke-engine/target/release/poke-engine';
const decide = (b: ReturnType<typeof battle>) => {
  const request = parseChoiceRequest(JSON.stringify(b.payload(9, b.me().exactHP!.current)))!;
  return { state: b.state, request, legalActions: generateLegalActions(request) };
};
function disabledHitmontop() {
  const b = battle([
    ours('Froslass', 87, ['Destiny Bond', 'Poltergeist', 'Triple Axel', 'Taunt'], 'Cursed Body', 'Wide Lens', 'Ice'),
    ours('Reuniclus', 88, ['Psychic', 'Recover'], 'Magic Guard', 'Leftovers', 'Steel'),
  ], 'Hitmontop', 88);
  b.feed('|turn|28\n|-terastallize|p2a: Foe|Ice\n|-ability|p2a: Foe|Technician\n|-item|p2a: Foe|Leftovers');
  for (const move of ['Rapid Spin', 'Close Combat', 'Bulk Up', 'Triple Axel']) b.feed(`|move|p2a: Foe|${move}|p1a: Froslass`);
  b.feed(`|-damage|p1a: Froslass|20/${b.me().exactHP!.max}\n|-boost|p2a: Foe|atk|3\n|-boost|p2a: Foe|spe|1`);
  b.feed('|-start|p2a: Foe|Disable|Triple Axel|[from] ability: Cursed Body|[of] p1a: Froslass\n|turn|29');
  b.state.sides.p2.teamSize = 1;
  return b;
}

test('2688327979: disabled Triple Axel cannot veto Destiny Bond or Taunt, even after Bulk Up', () => {
  const b = disabledHitmontop();
  b.feed('|move|p2a: Foe|Bulk Up|p2a: Foe\n|turn|30');
  assert.ok(!incomingThreats(b.state, b.me(), 'p1', Infinity)!.damagingMoves.some(m => m.move === 'Triple Axel'));
  assert.equal(statusIntoKnockout(decide(b)).size, 0);
  b.feed('|-end|p2a: Foe|Disable\n|turn|32');
  assert.ok(incomingThreats(b.state, b.me(), 'p1', Infinity)!.damagingMoves.some(m => m.move === 'Triple Axel'));
  assert.ok(statusIntoKnockout(decide(b)).size > 0, 'the original guard still works once Disable ends');
});

test('2688327979: real search does not offer the opponent its disabled move', { skip: !existsSync(BIN) }, () => {
  const b = disabledHitmontop();
  b.feed('|move|p2a: Foe|Bulk Up|p2a: Foe\n|turn|30');
  const before = JSON.stringify(b.state);
  const state = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', () => 0.5)).state;
  const output = execFileSync(BIN, ['monte-carlo-tree-search', '--state', state, '-t', '50'], { encoding: 'utf8' });
  const theirs = output.split('\n').find(l => l.startsWith('side two:'))!;
  assert.doesNotMatch(theirs, /tripleaxel/);
  assert.match(theirs, /bulkup/);
  assert.equal(JSON.stringify(b.state), before, 'search projection never mutates the tracker');
});

test('Disable timing, unknown targets and switch reset are preserved in engine input', () => {
  const b = disabledHitmontop();
  const durations = () => toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', () => 0.5)).state.split('/')[1]!.split('=')[9]!.split(';');
  assert.deepEqual(durations().slice(6), ['3', '3']);
  b.feed('|move|p2a: Foe|Bulk Up|p2a: Foe\n|turn|30');
  assert.deepEqual(durations().slice(6), ['2', '3'], 'the slot stays Triple Axel after a different last move');
  b.feed('|-end|p2a: Foe|Disable');
  assert.equal(durations().length, 6);
  b.feed('|move|p2a: Foe|Triple Axel|p1a: Froslass\n|-start|p2a: Foe|Disable|Triple Axel\n|turn|31');
  assert.deepEqual(durations().slice(6), ['4', '3'], 'a slower Disable gets four further blocked choices');
  b.foe().volatiles.Disable!.data = null;
  assert.equal(durations().length, 6, 'an unnamed disabled move is not guessed from lastMoveUsed');
  b.feed('|switch|p2a: Foe|Hitmontop, L88|70/100');
  assert.equal(durations().length, 6);
});

test('our disabled move expires separately from a simultaneous Choice lock', () => {
  const b = battle([ours('Gengar', 82, ['Shadow Ball', 'Sludge Wave'], 'Cursed Body', 'Choice Scarf', 'Ghost')], 'Hitmontop', 88);
  b.feed('|move|p1a: Gengar|Shadow Ball|p2a: Foe\n|-start|p1a: Gengar|Disable|Shadow Ball|[from] ability: Cursed Body\n|turn|2');
  const legal = { moves: new Set<string>(), canSwitch: true, canTera: false };
  const moves = () => toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', () => 0.5), legal).state.split('/')[0]!.split('=')[0]!.split(',').slice(22, 24);
  assert.deepEqual(moves(), ['SHADOWBALL;false;23', 'SLUDGEWAVE;true;16']);
  b.me().lastMoveUsed = 'Sludge Wave';
  assert.equal(moves()[0], 'SHADOWBALL;true;23', 'Disable ending must not release a different Choice lock');
});

test('Disable duration counts a spent sleeping action without changing Truant timing', () => {
  const b = disabledHitmontop();
  b.feed('|-end|p2a: Foe|Disable\n|turn|30\n|cant|p2a: Foe|slp');
  const acted = b.foe().lastActedTurn;
  b.feed('|-start|p2a: Foe|Disable|Triple Axel');
  assert.equal(b.foe().volatiles.Disable!.turns, 5);
  assert.equal(b.foe().lastActedTurn, acted, 'sleep must not count as Truant having allowed a move');
});

test('Cursed Body through Dancer respects whether the external move preceded the own action', () => {
  for (const acted of [false, true]) {
    const b = disabledHitmontop();
    b.feed('|-end|p2a: Foe|Disable\n|turn|30');
    if (acted) b.feed('|move|p2a: Foe|Bulk Up|p2a: Foe');
    b.feed('|move|p2a: Foe|Revelation Dance|p1a: Froslass|[from] ability: Dancer\n|-start|p2a: Foe|Disable|Revelation Dance|[from] ability: Cursed Body');
    assert.equal(b.foe().volatiles.Disable!.turns, acted ? 5 : 4);
  }
});

for (const phaze of ['Roar', 'Whirlwind']) test(`2688340271: outhealed leaves ${phaze} available`, () => {
  const b = battle([
    ours('Solgaleo', 74, ['Close Combat', 'Sunsteel Strike', 'Morning Sun', phaze], 'Full Metal Body', 'Rocky Helmet', 'Water'),
    ours('Rayquaza', 72, ['Dragon Ascent', 'Dragon Dance', 'Extreme Speed', 'Earthquake'], 'Air Lock', 'Life Orb', 'Flying'),
  ], 'Dipplin', 88);
  b.feed('|-item|p2a: Foe|Eviolite');
  for (const t of [2, 3]) b.feed(`|-damage|p2a: Foe|50/100\n|move|p2a: Foe|Recover|p2a: Foe\n|-heal|p2a: Foe|100/100\n|turn|${t}`);
  const input = decide(b), skipped = outhealed(input);
  assert.ok(skipped.has(input.legalActions.find(a => a.label === 'Sunsteel Strike')!.id), 'ordinary stalled attacks still receive the same correction');
  assert.ok(!skipped.has(input.legalActions.find(a => a.label === phaze)!.id));
  assert.ok(!skipped.has(input.legalActions.find(a => a.label === 'Morning Sun')!.id));
});

function terapagosBench() {
  const roster = [ours('Magnezone', 84, ['Flash Cannon', 'Volt Switch'], 'Magnet Pull', 'Choice Scarf', 'Fighting'),
    ours('Terapagos', 77, ['Rest', 'Calm Mind', 'Tera Starstorm', 'Earth Power'], 'Tera Shift', 'Chesto Berry', 'Stellar')];
  roster[1]!.stats.atk = 105; // The logged special set has 0 Attack IVs and EVs.
  const b = battle(roster, 'Decidueye-Hisui', 87);
  b.feed('|move|p2a: Foe|Triple Arrows|p1a: Magnezone');
  return { b, p: b.state.sides.p1.team[1]! };
}

test('2688333996: Terapagos enters as Terastal with Tera Shell and the correct stats', () => {
  const { b, p } = terapagosBench(), before = JSON.stringify(b.state);
  const entered = afterEntry(b.state, p, 'p1');
  assert.equal(entered.species, 'Terapagos-Terastal');
  assert.equal(entered.ability, 'Tera Shell');
  assert.deepEqual(entered.exactHP, { current: 273, max: 273 });
  assert.deepEqual(entered.stats, { atk: 151, def: 214, spa: 206, spd: 214, spe: 175 });
  const arrows = incomingThreats(b.state, p, 'p1', Infinity)!.damagingMoves.find(m => m.move === 'Triple Arrows')!;
  assert.deepEqual(arrows.percentOfMaxHP, [17.5, 20.9]);
  assert.equal(JSON.stringify(b.state), before);
});

test('Tera Shift precedes hazards, retains missing HP, and never refills a chipped Shell', () => {
  const { b, p } = terapagosBench();
  p.exactHP!.current -= 40; p.hpPercent = p.exactHP!.current / p.exactHP!.max * 100;
  b.state.sides.p1.hazards['Stealth Rock'] = 1;
  const entered = afterEntry(b.state, p, 'p1');
  assert.deepEqual(entered.exactHP, { current: 199, max: 273 }, '40 missing HP stays missing, then Rock takes floor(273/8)');
  const damage = incomingThreats(b.state, p, 'p1', Infinity)!.damagingMoves.find(m => m.move === 'Triple Arrows')!;
  assert.ok(damage.percentOfMaxHP[0] > 60, 'hazard/chip damage breaks Tera Shell');
  p.item = 'Heavy-Duty Boots';
  assert.equal(afterEntry(b.state, p, 'p1').exactHP!.current, 233);
});

test('Tera Shift is limited to the initial form and does not spend Tera or mutate other Pokémon', () => {
  const { b, p } = terapagosBench();
  assert.equal(afterTeraShift(b.me()), b.me());
  assert.equal(afterTeraShift(p).terastallized, false);
  for (const patch of [{ species: 'Terapagos-Terastal' }, { species: 'Terapagos-Stellar' }, { fainted: true },
    { transformedInto: 'Terapagos' }, { ability: 'Tera Shell' }, { terastallized: true }]) {
    const other = { ...structuredClone(p), ...patch };
    assert.equal(afterTeraShift(other), other);
  }
  p.abilitySuppressed = true;
  assert.equal(afterTeraShift(p).species, 'Terapagos-Terastal', 'Tera Shift itself cannot be suppressed');
});

test('Terapagos engine projection and switch result use the same form', { skip: !existsSync(BIN) }, async () => {
  const { b, p } = terapagosBench(); b.state.sides.p2.teamSize = 1;
  const input = decide(b), action = input.legalActions.find(a => a.command === 'switch 2')!;
  const state = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', () => 0.5)).state;
  const fields = state.split('/')[0]!.split('=')[1]!.split(',');
  assert.equal(fields[0], 'TERAPAGOSTERASTAL');
  assert.equal(fields[8], 'TERASHELL');
  assert.equal(fields[7], '273');
  assert.equal(engineName(action, b.state), 'terapagosterastal');
  const result = (await searchWorlds(b.state, input.legalActions, { bin: BIN, worlds: 1, msPerWorld: 50, random: () => 0.5 }))!;
  assert.ok(Number.isFinite(result.values[action.id]?.meanScore));
  assert.equal(p.species, 'Terapagos', 'the retained roster waits for the server form-change message');
  const output = execFileSync(BIN, ['generate-instructions', '--state', state, '-o', 'terapagosterastal', '-t', 'triplearrows'], { encoding: 'utf8' });
  const hits = [...output.matchAll(/Damage SideOne: (\d+)/g)].map(m => +m[1]!);
  assert.ok(hits.length > 0 && hits.every(hp => hp < 90), `the switch really receives Tera Shell in the engine: ${hits}`);
});
