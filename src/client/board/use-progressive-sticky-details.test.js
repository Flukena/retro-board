import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleStickyDetailBatch } from './use-progressive-sticky-details.js';
import { STICKY_DETAIL_BATCH_ITEM_LIMIT } from '../../domain/board-render-visibility.js';

const TARGET_ITEM_COUNT = 32;
function clock() {
  let nextId = 0; const pending = new Map();
  return { pending, requestAnimationFrame: callback => { pending.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: id => pending.delete(id), tick: () => {
      const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback();
    } };
}
test('native hydration pauses during input and allows one bounded batch before React acknowledges it', () => {
  const view = clock(), busy = { current: 'zoom' }, target = new Set(Array.from({ length: TARGET_ITEM_COUNT }, (_, index) => `card-${index}`)), commits = [];
  const cleanup = scheduleStickyDetailBatch(new Set(), target, [busy], value => commits.push(value), view);
  view.tick(); assert.deepEqual(commits, []);
  busy.current = null; view.tick(); assert.equal(commits.length, 1);
  assert.equal(commits[0].size, STICKY_DETAIL_BATCH_ITEM_LIMIT);
  assert.equal(view.pending.size, 0, 'Another batch waits for the preceding React commit'); cleanup();
});
test('cleanup cancels pending changes and settled legacy policy schedules no RAF', () => {
  const view = clock(), commits = [];
  const cleanup = scheduleStickyDetailBatch(new Set(), new Set(['card']), [], value => commits.push(value), view);
  cleanup(); view.tick(); assert.deepEqual(commits, []);
  scheduleStickyDetailBatch(null, null, [], value => commits.push(value), view);
  assert.equal(view.pending.size, 0); assert.deepEqual(commits, []);
});
