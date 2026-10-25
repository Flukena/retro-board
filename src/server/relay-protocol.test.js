import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayProtocol } from './relay-protocol.js';

const LIMITS = { maxStateVectorBytes: 8, maxUpdateBytes: 2, maxAwarenessMessageBytes: 128,
  maxAwarenessClientsPerRoom: 2, maxAwarenessStateBytes: 16 };
const protocol = new RelayProtocol(LIMITS);
const inspect = bytes => protocol.inspect(Uint8Array.from(bytes));

test('protocol validates complete sync framing and exact update byte limits', () => {
  assert.deepEqual(inspect([0, 0, 1, 0]), { kind: 'sync-step-1' });
  assert.deepEqual(inspect([0, 2, 2, 0, 0]), { kind: 'sync-update', updateBytes: 2 });
  assert.throws(() => inspect([0, 2, 3, 0, 0, 0]), /invalid sync update/);
  assert.throws(() => inspect([0, 0, 1, 0, 0]), /invalid sync state vector/);
  assert.throws(() => inspect([0, 2, 2, 0]));
});

test('awareness framing rejects truncation, duplicate IDs, invalid UTF-8 and scalar states before mutation', () => {
  assert.deepEqual(inspect([1, 6, 1, 37, 4, 2, 123, 125]), {
    kind: 'awareness', entries: [{ clientId: 37, clock: 4, stateIsNull: false, stateBytes: 2 }],
  });
  assert.throws(() => inspect([1, 6, 1, 37, 4, 2, 123]));
  assert.throws(() => inspect([1, 11, 2, 37, 4, 2, 123, 125, 37, 5, 2, 123, 125]), /invalid awareness entry/);
  assert.throws(() => inspect([1, 5, 1, 37, 4, 1, 255]));
  assert.throws(() => inspect([1, 5, 1, 37, 4, 1, 49]), /invalid awareness state/);
});
