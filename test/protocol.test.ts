import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame } from '../src/showdown/protocol.js';
import { readConfig } from '../src/config/env.js';

test('parses room frames, empty lines and messages without data', () => {
  assert.deepEqual(parseFrame('>battle-test\n|turn|1\n\n|start\n'), [
    { room: 'battle-test', type: 'turn', data: '1' },
    { room: 'battle-test', type: 'start', data: '' },
  ]);
});
test('preserves pipes and resets room between frames', () => {
  parseFrame('>battle-test\n|turn|1');
  assert.deepEqual(parseFrame('|challstr|4|challenge'), [{ room: null, type: 'challstr', data: '4|challenge' }]);
  assert.equal(parseFrame('|c|Alice|hello|world')[0]?.data, 'Alice|hello|world');
});
test('tolerates empty and unstructured messages', () => {
  assert.deepEqual(parseFrame(''), []);
  assert.deepEqual(parseFrame('notice\n|'), [
    { room: null, type: 'text', data: 'notice' },
    { room: null, type: '', data: '' },
  ]);
});
test('validates configuration', () => {
  assert.equal(readConfig({}).format, 'gen9randombattle');
  assert.throws(() => readConfig({ SHOWDOWN_URL: 'https://example.com' }));
  assert.throws(() => readConfig({ SHOWDOWN_URL: 'wss://secret:password@example.com' }));
  assert.throws(() => readConfig({ DEBUG: 'yes' }));
});
