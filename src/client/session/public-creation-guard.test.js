import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicCreationGuard } from './public-creation-guard.js';

const START_MS = 100_000;
const WINDOW_MS = 60_000;
const sticky = { type: 'sticky' };
const image = { type: 'image' };

test('Public creation window counts each item and releases capacity at the exact rolling deadline', () => {
  const guard = new PublicCreationGuard();
  guard.record(Array(9).fill(sticky), START_MS);
  guard.record([sticky], START_MS + 5_000);
  assert.deepEqual(guard.check([sticky], START_MS + 30_000), { allowed: false, oversized: false, retryAfterSeconds: 30 });
  assert.deepEqual(guard.check([sticky], START_MS + WINDOW_MS), { allowed: true });
});

test('image creation shares the item budget but has its own rolling limit', () => {
  const guard = new PublicCreationGuard();
  guard.record([image], START_MS);
  assert.deepEqual(guard.check([image], START_MS + 5_000), { allowed: false, oversized: false, retryAfterSeconds: 55 });
  assert.deepEqual(guard.check([sticky], START_MS + 5_000), { allowed: true });
  assert.deepEqual(guard.check([image], START_MS + WINDOW_MS), { allowed: true });
});

test('an oversized batch is refused even when the window is empty', () => {
  const guard = new PublicCreationGuard();
  assert.deepEqual(guard.check(Array(11).fill(sticky), START_MS), { allowed: false, oversized: true, retryAfterSeconds: 1 });
  assert.deepEqual(guard.check([image, image], START_MS), { allowed: false, oversized: true, retryAfterSeconds: 1 });
});

test('server budget includes same-IP activity and acknowledges local creations without counting them twice', () => {
  const guard = new PublicCreationGuard();
  guard.applyBudget({ entries: [{ creations: 1, images: 0, remainingMs: WINDOW_MS }], acceptedIds: [] }, START_MS);
  assert.equal(guard.check(Array(9).fill(sticky), START_MS).allowed, true);
  assert.equal(guard.check(Array(10).fill(sticky), START_MS).allowed, false);
  guard.record([{ id: 'local', type: 'sticky' }], START_MS);
  guard.applyBudget({ entries: [{ creations: 2, images: 0, remainingMs: WINDOW_MS }], acceptedIds: ['local'] }, START_MS);
  assert.equal(guard.check(Array(8).fill(sticky), START_MS).allowed, true);
  assert.equal(guard.check(Array(9).fill(sticky), START_MS).allowed, false);
});

test('pending local items and the latest same-IP server budget both count until acknowledged', () => {
  const guard = new PublicCreationGuard();
  guard.record([{ id: 'pending', type: 'sticky' }], START_MS);
  assert.equal(guard.applyBudget({ entries: [{ creations: 9, images: 0, remainingMs: WINDOW_MS }], acceptedIds: [] }, START_MS), true);
  assert.equal(guard.check([sticky], START_MS).allowed, false);
  assert.equal(guard.applyBudget({ entries: [{ creations: 99, images: 0, remainingMs: WINDOW_MS }], acceptedIds: ['pending'] }, START_MS), false);
  assert.equal(guard.check([sticky], START_MS).allowed, false);
});
