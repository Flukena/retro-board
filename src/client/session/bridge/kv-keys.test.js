import test from 'node:test';
import assert from 'node:assert/strict';
import { keyOf, userKey, userKeyPrefix, parseKvKey } from './kv-keys.js';

test('kv keys retain shared/user bytes and parse only the first two separators', () => {
  assert.equal(keyOf('s', 'boardState', ''), 's||boardState');
  assert.equal(userKey('client', 'name'), 'u|client|name');
  assert.equal(userKeyPrefix('client'), 'u|client|');
  assert.deepEqual(parseKvKey('u|client|key|suffix'), { scope: 'u', clientId: 'client', key: 'key|suffix' });
  assert.deepEqual(parseKvKey('s||'), { scope: 's', clientId: '', key: '' });
  for (const key of ['none', 'u|client']) assert.equal(parseKvKey(key), null);
});
