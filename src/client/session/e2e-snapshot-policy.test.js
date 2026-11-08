import test from 'node:test';
import assert from 'node:assert/strict';
import { E2E_SNAPSHOT_MIN_INTERVAL_MS } from '../../domain/e2e-limits.js';
import { SNAPSHOT_AFTER_BYTES, SNAPSHOT_AFTER_UPDATES, SnapshotPolicy } from './e2e-snapshot-policy.js';

test('a snapshot is wanted after 500 entries or 1 MiB since the last one, on quota, or when forced', () => {
  assert.equal(SNAPSHOT_AFTER_UPDATES, 500);
  assert.equal(SNAPSHOT_AFTER_BYTES, 1024 * 1024);
  const byCount = new SnapshotPolicy();
  for (let i = 1; i < SNAPSHOT_AFTER_UPDATES; i += 1) byCount.noteLogEntry(1);
  assert.equal(byCount.wants(), false);
  byCount.noteLogEntry(1);
  assert.equal(byCount.wants(), true);
  byCount.logPruned();
  assert.equal(byCount.wants(), false);
  const byBytes = new SnapshotPolicy();
  byBytes.noteLogEntry(SNAPSHOT_AFTER_BYTES);
  assert.equal(byBytes.wants(), true);
  const byQuota = new SnapshotPolicy();
  byQuota.reachQuota();
  assert.equal(byQuota.wants(), true);
  assert.equal(new SnapshotPolicy().wants({ forced: true }), true);
});

test('one attempt per connection per interval; a new connection resets the allowance', () => {
  const policy = new SnapshotPolicy();
  assert.equal(policy.waitMs(0), 0);
  policy.attempted(1_000);
  assert.equal(policy.waitMs(1_000), E2E_SNAPSHOT_MIN_INTERVAL_MS);
  assert.equal(policy.waitMs(1_000 + E2E_SNAPSHOT_MIN_INTERVAL_MS), 0);
  policy.restart();
  assert.equal(policy.waitMs(1_001), 0);
});
