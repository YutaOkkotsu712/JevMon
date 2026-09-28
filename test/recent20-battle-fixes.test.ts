import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { battle, ours } from './helpers.js';
import { generateLegalActions, parseChoiceRequest } from '../src/battle/LegalActionGenerator.js';
import { dex } from '../src/pokemon/data.js';
import { engineName, searchWorlds } from '../src/search/search.js';
import { sampleWorld, toEngineState } from '../src/search/engineState.js';

const BIN = 'vendor/poke-engine/target/release/poke-engine';
function position(forme: string, meteor = false) {
  const minior = dex.species.get(forme).baseSpecies === 'Minior';
  const sawsbuck = dex.species.get(forme).baseSpecies === 'Sawsbuck';
  const row = minior
    ? ours(meteor ? 'Minior-Meteor' : 'Minior', 79, ['Power Gem', 'Acrobatics', 'Earthquake', 'Shell Smash'], 'Shields Down', 'White Herb', 'Ground')
    : sawsbuck ? ours('Sawsbuck', 88, ['Horn Leech', 'Double-Edge', 'High Horsepower', 'Swords Dance'], 'Serene Grace', 'Life Orb', 'Normal')
    : ours('Gastrodon', 86, ['Earthquake', 'Ice Beam', 'Recover', 'Stealth Rock'], 'Storm Drain', 'Leftovers', 'Poison');
  row.details = `${forme}, L${minior ? 79 : sawsbuck ? 88 : 86}`;
  const b = battle([ours('Passimian', 83, ['Close Combat', 'Knock Off'], 'Defiant', 'Leftovers', 'Poison'), row], 'Slither Wing', 77);
  b.state.sides.p2.teamSize = 1;
  const request = parseChoiceRequest(JSON.stringify(b.payload(2, b.me().exactHP!.max)))!;
  return { b, actions: generateLegalActions(request) };
}

for (const base of ['Minior', 'Gastrodon', 'Sawsbuck']) for (const forme of [base, ...(dex.species.get(base).cosmeticFormes ?? [])]) {
  test(`${forme}: cosmetic switch votes match the engine's species`, () => {
    const { b, actions } = position(forme);
    const action = actions.find(a => a.command === 'switch 2')!;
    const encoded = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', () => 0.5)).state;
    assert.equal(engineName(action, b.state), base.toLowerCase());
    assert.equal(encoded.split('/')[0]!.split('=')[1]!.split(',')[0]!.toLowerCase(), engineName(action, b.state));
    assert.equal(action.command, 'switch 2');
  });
}

test('2688527067: Meteor stats under the Minior colour name must still trigger Shields Down', { skip: !existsSync(BIN) }, () => {
  const { b, actions } = position('Minior-Indigo', true);
  const before = JSON.stringify(b.state);
  assert.equal(engineName(actions.find(a => a.command === 'switch 2')!, b.state), 'miniormeteor');
  const bench = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', () => 0.5)).state;
  assert.equal(bench.split('/')[0]!.split('=')[1]!.split(',')[0], 'MINIORMETEOR');
  assert.equal(JSON.stringify(b.state), before);
  b.feed(`|switch|p1a: Minior-Meteor|Minior-Indigo, L79|224/224\n|request|${JSON.stringify(b.payload(3, 224, 1))}`);
  const encoded = toEngineState(b.state, 'p1', sampleWorld(b.state, 'p1', () => 0.5)).state;
  const output = execFileSync(BIN, ['generate-instructions', '--state', encoded, '-o', 'shellsmash', '-t', 'closecombat'], { encoding: 'utf8' });
  assert.match(output, /FormeChange SideOne/);
  assert.match(output, /ChangeSpeed SideOne: 95/, 'after the shell breaks, base Speed rises from 140 to 235');
});

for (const forme of ['Minior-Indigo', 'Gastrodon-East', 'Sawsbuck-Winter']) for (const solver of ['mcts', 'replacement', 'endgame']) {
  test(`${forme} retains search scores through ${solver}`, { skip: !existsSync(BIN) }, async () => {
    const { b, actions: initial } = position(forme, forme.startsWith('Minior'));
    let actions = initial;
    if (solver === 'replacement') {
      const payload = b.payload(3, 0);
      payload.side.pokemon[0]!.condition = '0 fnt';
      const raw = JSON.stringify({ rqid: 3, side: payload.side, forceSwitch: [true] });
      b.feed(`|faint|p1a: Passimian\n|request|${raw}`);
      actions = generateLegalActions(parseChoiceRequest(raw)!);
    }
    const result = (await searchWorlds(b.state, actions, { bin: BIN, worlds: 1, msPerWorld: 50, random: () => 0.5,
      ...(solver === 'endgame' ? { endgame: { maxPokemon: 3, worlds: 1, msPerWorld: 50 } } : {}) }))!;
    const value = result.values[actions.find(a => a.command === 'switch 2')!.id]!;
    assert.ok(Number.isFinite(value.meanScore), 'a search score must not disappear under a cosmetic name');
    if (solver === 'replacement') assert.equal(value.visitShare, 1);
    assert.ok(Math.abs(Object.values(result.values).reduce((n, v) => n + v.visitShare, 0) - 1) < 0.01);
  });
}

test('2688610660: a pivot that KOs its target still gets scored replacement choices', { skip: !existsSync(BIN) }, async () => {
  const b = battle([
    ours('Alomomola', 87, ['Flip Turn', 'Wish', 'Protect', 'Scald'], 'Regenerator', 'Leftovers', 'Steel'),
    ours('Chansey', 85, ['Seismic Toss', 'Soft-Boiled'], 'Natural Cure', 'Eviolite', 'Steel'),
    ours('Ambipom', 84, ['Double-Edge', 'Fake Out'], 'Technician', 'Silk Scarf', 'Normal'),
  ], 'Reshiram', 76);
  b.state.sides.p2.teamSize = 2; // One opposing bench slot is still unseen.
  b.feed('|move|p1a: Alomomola|Flip Turn|p2a: Foe\n|faint|p2a: Foe');
  const raw = JSON.stringify({ rqid: 3, side: b.payload(3, b.me().exactHP!.max).side, forceSwitch: [true] });
  b.feed(`|request|${raw}`);
  const actions = generateLegalActions(parseChoiceRequest(raw)!);
  const result = (await searchWorlds(b.state, actions, { bin: BIN, worlds: 1, msPerWorld: 50, random: () => 0.5 }))!;
  assert.ok(actions.length === 2 && actions.every(a => a.kind === 'switch'));
  assert.ok(actions.every(a => Number.isFinite(result.values[a.id]?.meanScore)), 'the engine must evaluate our pivot replacements before their replacement');
  assert.ok(Math.abs(Object.values(result.values).reduce((n, v) => n + v.visitShare, 0) - 1) < 0.01);
});
