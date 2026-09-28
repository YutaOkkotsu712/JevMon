import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { battle, ours } from './helpers.js';
import { damageRange } from '../src/strategy/damage.js';
import { scenario } from '../src/strategy/calcCore.js';
import { pokemonTypes } from '../src/pokemon/mechanics.js';
import { sampleWorld, toEngineState } from '../src/search/engineState.js';

const BIN = 'vendor/poke-engine/target/release/poke-engine';
const moves = ['Leaf Blade', 'Psyblade', 'Close Combat', 'Megahorn'];
function fixture() {
  const b = battle([ours('Iron Leaves', 80, moves, 'Quark Drive', 'Life Orb', 'Fighting')], 'Mew');
  b.foe().ability = 'Synchronize'; b.foe().item = '';
  const world = sampleWorld(b.state, 'p1', () => 0.5);
  return { b, world };
}

// Expected changes relative to the same attack before Tera. Both original types retain STAB, the new
// type gains it, a matching original type reaches 2x, and unrelated coverage gets no new bonus.
const cases = [
  { tera: 'Fighting', multipliers: [1, 1, 1.5, 1], incoming: 2 },
  { tera: 'Grass', multipliers: [4 / 3, 1, 1, 1], incoming: 1 },
];
function scaled(before: number[], after: number[], multiplier: number, label: string) {
  assert.ok(before.length > 0 && before.every(n => Number.isFinite(n) && n > 0), label);
  assert.equal(after.length, before.length, label);
  if (multiplier === 1) assert.deepEqual(after, before, label);
  else before.forEach((n, i) => assert.ok(Math.abs(after[i]! - n * multiplier) <= 3,
    `${label}: ${before} -> ${after}, expected ${multiplier}x within damage rounding`));
}

for (const { tera, multipliers, incoming } of cases) {
  test(`Tera ${tera}: Iron Leaves retains both original STABs in projected and actual damage`, () => {
    const { b, world } = fixture();
    const before = moves.map(m => damageRange(b.state, m)!.hp);
    const snapshot = JSON.stringify(b.state);
    const projected = moves.map(m => damageRange(b.state, m, tera)!.hp);
    assert.equal(JSON.stringify(b.state), snapshot, 'projecting Tera must not mutate the battle');
    const scald = () => {
      const r = scenario(b.state, b.foe(), b.me(), 'p2', 'Scald', world.sets.get(b.foe().id))!;
      return [r.min, r.max];
    };
    const scaldBefore = scald();
    b.feed(`|-terastallize|p1a: Iron Leaves|${tera}`);
    assert.deepEqual(pokemonTypes(b.me()), [tera], 'defensive typing changes independently of STAB');
    moves.forEach((m, i) => {
      const actual = damageRange(b.state, m)!.hp;
      assert.deepEqual(actual, projected[i], `${m}: projection matches the protocol-applied Tera`);
      scaled(before[i]!, actual, multipliers[i]!, m);
    });
    scaled(scaldBefore, scald(), incoming, 'incoming Scald uses the new defensive typing');
  });

  test(`Tera ${tera}: serialized Iron Leaves retains both original STABs in the real engine`, { skip: !existsSync(BIN) }, () => {
    const { b, world } = fixture();
    const damages = () => {
      const state = toEngineState(b.state, 'p1', world).state;
      return moves.map(m => {
        const output = execFileSync(BIN, ['calculate-damage', '--state', state, '-o', m.replaceAll(' ', '').toLowerCase(),
          '-t', 'scald', '-m'], { encoding: 'utf8' });
        const rows = [...output.matchAll(/^Damage Rolls: ([\d,]+)$/gm)].map(row => row[1]!.split(',').map(Number));
        assert.equal(rows.length, 2, output);
        return rows;
      });
    };
    const before = damages();
    b.feed(`|-terastallize|p1a: Iron Leaves|${tera}`);
    const after = damages();
    moves.forEach((m, i) => {
      scaled(before[i]![0]!, after[i]![0]!, multipliers[i]!, `${m}: normal and critical damage`);
      scaled(before[i]![1]!, after[i]![1]!, incoming, 'incoming Scald uses the new defensive typing');
    });
  });
}
