import test from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_LOCAL_ITEM_WINDOW_MS, shouldPreserveRecentLocalItem } from './pending-local-items.js';

const NOW_MS = 20_000;
const LOCAL_USER_ID = 'local-user';
const RECENT_ITEM = { id: 'card', authorId: LOCAL_USER_ID, createdAt: NOW_MS - 1 };
const options = (overrides = {}) => ({
  isUndoRedo: false, deletedItemIds: new Set(), userId: LOCAL_USER_ID, nowMs: NOW_MS, ...overrides,
});

test('a recent locally authored item remains pending until its canonical create appears', () => {
  assert.equal(shouldPreserveRecentLocalItem(RECENT_ITEM, options()), true);
});

test('undo/redo and missing or remotely authored items are never preserved as local creates', () => {
  assert.equal(shouldPreserveRecentLocalItem(RECENT_ITEM, options({ isUndoRedo: true })), false);
  assert.equal(shouldPreserveRecentLocalItem(undefined, options()), false);
  assert.equal(shouldPreserveRecentLocalItem({ ...RECENT_ITEM, authorId: 'remote-user' }, options()), false);
});

test('the grace cutoff is exclusive and missing timestamps do not extend it', () => {
  const cutoffMs = NOW_MS - RECENT_LOCAL_ITEM_WINDOW_MS;
  assert.equal(shouldPreserveRecentLocalItem({ ...RECENT_ITEM, createdAt: cutoffMs + 1 }, options()), true);
  assert.equal(shouldPreserveRecentLocalItem({ ...RECENT_ITEM, createdAt: cutoffMs }, options()), false);
  assert.equal(shouldPreserveRecentLocalItem({ ...RECENT_ITEM, createdAt: cutoffMs - 1 }, options()), false);
  assert.equal(shouldPreserveRecentLocalItem({ id: 'untimed', authorId: LOCAL_USER_ID }, options()), false);
});

test('canonical deletion overrides recent local-create preservation for focused and other items', () => {
  const deletedItemIds = new Set([RECENT_ITEM.id]);
  assert.equal(shouldPreserveRecentLocalItem(RECENT_ITEM, options({ deletedItemIds })), false);
  assert.equal(shouldPreserveRecentLocalItem({ ...RECENT_ITEM, id: 'other-card' }, options({ deletedItemIds })), true);
});
