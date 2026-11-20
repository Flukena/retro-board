import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteSnapshotController } from './remote-snapshot-controller.js';

const NOW_MS = 1000;
function harness() {
  const item = { id: 'card', type: 'sticky', x: 1, y: 2 };
  const boardRef = { current: { items: [item] } };
  const recentlyMovedRef = { current: new Map([['expired', { until: NOW_MS }]]) };
  let updater;
  const calls = [];
  const apply = createRemoteSnapshotController({ boardRef, recentlyMovedRef,
    userIdRef: { current: 'me' }, focusedTextIdRef: { current: 'card:body' }, dragItemsRef: { current: new Set() },
    clock: { now: () => NOW_MS },
    recentMoves: { forget: ids => { calls.push(['forget', ids]); ids.forEach(id => recentlyMovedRef.current.delete(id)); } },
    updateFocusedText: value => calls.push(['focus', value, recentlyMovedRef.current.size]),
    setBoard: update => { updater = update; calls.push(['schedule']); },
  });
  return { apply, calls, recentlyMovedRef, run: () => updater(boardRef.current) };
}

test('undo clears before focus handling and before the lazy updater is scheduled', () => {
  const h = harness(); h.apply({ items: [] }, true);
  assert.deepEqual(h.calls, [['focus', null, 0], ['schedule']]);
  assert.equal(h.recentlyMovedRef.current.size, 0);
});

test('ordinary snapshots retain moves until the same updater reconciles and forgets expired IDs', () => {
  const h = harness(); h.apply({ items: [] }, false);
  assert.deepEqual(h.calls, [['focus', null, 1], ['schedule']]);
  assert.equal(h.recentlyMovedRef.current.size, 1);
  assert.deepEqual(h.run().items, []);
  assert.deepEqual(h.calls.at(-1), ['forget', ['expired']]);
  assert.equal(h.recentlyMovedRef.current.size, 0);
  h.run();
  assert.deepEqual(h.calls.at(-1), ['forget', []]);
});

test('missing snapshots do not clear, focus or schedule', () => {
  const h = harness(); h.apply(null, true);
  assert.deepEqual(h.calls, []);
  assert.equal(h.recentlyMovedRef.current.size, 1);
});
