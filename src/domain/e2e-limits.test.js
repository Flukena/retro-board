import test from 'node:test';
import assert from 'node:assert/strict';
import {
  E2E_SNAPSHOT_RESERVATION_OVERHEAD_BYTES, RELAY_DEFAULT_MAX_DOCUMENT_BYTES, e2eMaxSnapshotCiphertextBytes,
} from './e2e-limits.js';

test('the largest snapshot plus its reservation overhead fills exactly one room', () => {
  const largest = e2eMaxSnapshotCiphertextBytes(RELAY_DEFAULT_MAX_DOCUMENT_BYTES);
  assert.equal(largest + E2E_SNAPSHOT_RESERVATION_OVERHEAD_BYTES, RELAY_DEFAULT_MAX_DOCUMENT_BYTES);
  assert.ok(largest > 0);
});
