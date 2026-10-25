import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleBoardItems, OVERVIEW_PRELOAD_ITEM_LIMIT, detailedStickyIds, usesCompactStickyPaint, nextStickyDetailBatch, STICKY_DETAIL_BATCH_ITEM_LIMIT } from './board-render-visibility.js';

const viewport = { x: 0, y: 0, zoom: 0.1 }, size = { w: 390, h: 844 };
const near = { id: 'near', type: 'sticky', x: 0, y: 0, w: 280, h: 240 };
const far = { ...near, id: 'far', x: 50000, y: 50000 };

test('overview preloads a bounded board without mutating its canonical items', () => {
  const items = [near, far];
  assert.equal(visibleBoardItems(items, viewport, size, true), items);
  assert.deepEqual(visibleBoardItems(items, viewport, size), [near]);
  assert.equal(items[1], far);
});

test('boards beyond the preload budget retain culling and partially visible items remain mounted', () => {
  const items = Array.from({ length: OVERVIEW_PRELOAD_ITEM_LIMIT + 1 }, (_, i) => ({ ...far, id: String(i) }));
  const partial = { ...near, x: -3300 };
  items.push(partial);
  assert.deepEqual(visibleBoardItems(items, viewport, size, true), [partial]);
});

test('overview preloading leaves offscreen image decoding culled', () => {
  const image = { ...far, id: 'image', type: 'image' };
  assert.deepEqual(visibleBoardItems([near, far, image], viewport, size, true), [near, far]);
});


test('dense boards retain cheap distant cards while only nearby sticky details are activated', () => {
  const image = { ...near, type: 'image', id: 'image' };
  const detailViewport = { x: 0, y: 0, zoom: 1 };
  const items = Object.freeze([Object.freeze(near), Object.freeze(far), Object.freeze(image)]);
  assert.deepEqual(detailedStickyIds(items, detailViewport, size, false, true), new Set(['near']));
  assert.deepEqual(visibleBoardItems(items, detailViewport, size, true), items);
  const details = detailedStickyIds(items, detailViewport, size, false, true);
  assert.equal(usesCompactStickyPaint('near', false, details), false);
  assert.equal(usesCompactStickyPaint('far', false, details), true);
  assert.equal(usesCompactStickyPaint('near', true, details), false, 'A native card remains until its removal batch commits');
  assert.deepEqual(detailedStickyIds(items, viewport, size, true, true), new Set());
});

test('detail coverage follows fractional world transforms and preserves partially visible cards', () => {
  const partial = { ...near, id: 'partial', x: -near.w };
  const detailViewport = { x: 0.5, y: 0.25, zoom: 2 };
  assert.deepEqual(detailedStickyIds([partial, far], detailViewport, size, false, true), new Set(['partial']));
  assert.deepEqual(detailedStickyIds([near, far], { ...detailViewport, x: -far.x * detailViewport.zoom, y: -far.y * detailViewport.zoom }, size, false, true), new Set(['far']));
});

test('small or unbounded boards retain their existing detail and culling policy', () => {
  assert.equal(detailedStickyIds([near, far], viewport, size, false, false), null);
  const large = Array.from({ length: OVERVIEW_PRELOAD_ITEM_LIMIT + 1 }, (_, index) => ({ ...far, id: String(index) }));
  assert.equal(detailedStickyIds(large, viewport, size, false, true), null);
  assert.equal(usesCompactStickyPaint('near', false, null), false);
  assert.equal(usesCompactStickyPaint('near', true, null), true);
});

test('offscreen controls stay compact while every partially visible card receives native details', () => {
  const outside = { ...near, id: 'outside', x: size.w + 1 };
  const partial = { ...near, id: 'partial', x: size.w - 0.5 };
  const details = detailedStickyIds([outside, partial], { x: 0, y: 0, zoom: 1 }, size, false, true);
  assert.deepEqual(details, new Set(['partial']));
});


test('native detail batches remove stale controls first and converge without mutating either input', () => {
  const itemCount = 32;
  const current = new Set(Array.from({ length: itemCount }, (_, index) => `old-${index}`));
  const target = new Set(Array.from({ length: itemCount }, (_, index) => `new-${index}`));
  const first = nextStickyDetailBatch(current, target);
  assert.equal(first.size, current.size - STICKY_DETAIL_BATCH_ITEM_LIMIT);
  assert.ok([...first].every(id => current.has(id)));
  let value = current;
  for (let index = 0; index < current.size + target.size; index++) {
    const next = nextStickyDetailBatch(value, target);
    const changed = [...value].filter(id => !next.has(id)).length + [...next].filter(id => !value.has(id)).length;
    assert.ok(changed <= STICKY_DETAIL_BATCH_ITEM_LIMIT); value = next;
  }
  assert.deepEqual(value, target); assert.equal(nextStickyDetailBatch(value, target), value);
  assert.equal(current.size, itemCount); assert.equal(target.size, itemCount);
  assert.equal(nextStickyDetailBatch(value, null), null);
  assert.equal(nextStickyDetailBatch(null, target).size, STICKY_DETAIL_BATCH_ITEM_LIMIT);
});
