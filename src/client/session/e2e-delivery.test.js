import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingDeliveries } from './e2e-delivery.js';

const LAST_REF = 2 ** 32 - 1;
const update = (byte) => Uint8Array.of(byte);

test('refs wrap from 2^32 - 1 to 1 and never use 0, the relay\'s no-entry marker', () => {
  const pending = new PendingDeliveries({ firstClientRef: LAST_REF });
  const refs = [pending.add(update(1)), pending.add(update(2))].map((entry) => entry.clientRef);
  assert.deepEqual(refs, [LAST_REF, 1]);
  assert.equal(new PendingDeliveries({ firstClientRef: 0 }).add(update(1)).clientRef, 1);
});

test('entries leave only by their own ACK or a covering snapshot, and keep creation order', () => {
  const pending = new PendingDeliveries();
  const [a, b, c] = [1, 2, 3].map((byte) => pending.add(update(byte)));
  assert.equal(pending.acknowledge(999), false);
  assert.equal(pending.acknowledge(b.clientRef), true);
  assert.equal(pending.acknowledge(b.clientRef), false);
  assert.deepEqual(pending.list(), [a, c]);
  pending.removeAll([a.clientRef]);
  assert.deepEqual(pending.refs(), [c.clientRef]);
  assert.equal(pending.hasOversized(), false);
  pending.add(update(4), { oversized: true });
  assert.equal(pending.hasOversized(), true);
  assert.equal(pending.size, 2);
});
