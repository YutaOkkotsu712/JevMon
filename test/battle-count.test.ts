import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BATTLE_COUNT_FILE, readBattlesPlayed, recordBattlesPlayed } from '../src/logging/battleCount.js';

test('the battle count survives a restart, and an unreadable one fails closed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jevmon-count-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readBattlesPlayed(dir), 0, 'no file yet means nothing has been played');
  assert.ok(recordBattlesPlayed(dir, 3));
  assert.equal(readBattlesPlayed(dir), 3, 'a fresh process reads what the last one recorded');
  assert.equal(statSync(join(dir, BATTLE_COUNT_FILE)).mode & 0o777, 0o600);
  // A limit that cannot be read must not become a fresh allowance of paid battles.
  for (const junk of ['', 'lots', '-1', '2.5']) {
    writeFileSync(join(dir, BATTLE_COUNT_FILE), junk);
    assert.equal(readBattlesPlayed(dir), null, `"${junk}" is not a count`);
  }
  assert.equal(recordBattlesPlayed(join(dir, BATTLE_COUNT_FILE, 'nested'), 1), false, 'a write failure is reported, not thrown');
});
