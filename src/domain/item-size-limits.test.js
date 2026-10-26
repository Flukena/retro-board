import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ITEM_MAX_SIDE_PX,
  clampAspectScale,
  clampCornerResize,
  groupScaleRange,
  itemSizeBounds,
} from './item-size-limits.js';
import { publicZoneCreationSize } from './public-zone-layout.js';

// The rect a corner drag produces before any limit, as the board computes it.
function draggedRect(initial, corner, dx, dy) {
  const left = corner === 'nw' || corner === 'sw';
  const top = corner === 'nw' || corner === 'ne';
  return {
    x: left ? initial.x + dx : initial.x,
    y: top ? initial.y + dy : initial.y,
    w: left ? initial.w - dx : initial.w + dx,
    h: top ? initial.h - dy : initial.h + dy,
  };
}

const OUTWARD = Object.freeze({ nw: [-1, -1], ne: [1, -1], sw: [-1, 1], se: [1, 1] });
const HUGE_DRAG_PX = 10_000;

test('a zone stretched far past the cap stops at the cap with the opposite corner fixed', () => {
  const initial = { x: 100, y: 50, w: 1200, h: 1080 };
  const bounds = itemSizeBounds('zone', initial);
  for (const [corner, [sx, sy]] of Object.entries(OUTWARD)) {
    const rect = clampCornerResize(initial, corner, draggedRect(initial, corner, sx * HUGE_DRAG_PX, sy * HUGE_DRAG_PX), bounds);
    assert.equal(rect.w, ITEM_MAX_SIDE_PX.zone, corner);
    assert.equal(rect.h, ITEM_MAX_SIDE_PX.zone, corner);
    const anchorX = sx < 0 ? initial.x + initial.w : initial.x;
    const anchorY = sy < 0 ? initial.y + initial.h : initial.y;
    assert.equal(sx < 0 ? rect.x + rect.w : rect.x, anchorX, `${corner} x anchor`);
    assert.equal(sy < 0 ? rect.y + rect.h : rect.y, anchorY, `${corner} y anchor`);
  }
});

test('every resizable type has a cap well below what crashed iPhone Safari', () => {
  const crashedImageSidePx = 9_520;
  for (const type of ['zone', 'image', 'sticky', 'text']) {
    const bounds = itemSizeBounds(type, { w: 10, h: 10 });
    assert.ok(bounds.maxW < crashedImageSidePx && bounds.maxH < crashedImageSidePx, type);
  }
});

test('an item already larger than the cap can shrink but not grow, and does not jump on grab', () => {
  const initial = { x: 0, y: 0, w: 10_031, h: 7_207 };
  const bounds = itemSizeBounds('zone', initial);
  const grown = clampCornerResize(initial, 'se', draggedRect(initial, 'se', 500, 500), bounds);
  assert.deepEqual(grown, initial);
  const untouched = clampCornerResize(initial, 'se', draggedRect(initial, 'se', 0, 0), bounds);
  assert.deepEqual(untouched, initial);
  const shrunk = clampCornerResize(initial, 'se', draggedRect(initial, 'se', -1_000, -1_000), bounds);
  assert.deepEqual(shrunk, { x: 0, y: 0, w: 9_031, h: 6_207 });
});

test('the existing minimum still holds and keeps the opposite corner fixed', () => {
  const initial = { x: 0, y: 0, w: 200, h: 180 };
  const bounds = itemSizeBounds('sticky', initial);
  const rect = clampCornerResize(initial, 'nw', draggedRect(initial, 'nw', 1_000, 1_000), bounds);
  assert.equal(rect.w, bounds.minW);
  assert.equal(rect.h, bounds.minH);
  assert.equal(rect.x + rect.w, initial.x + initial.w);
  assert.equal(rect.y + rect.h, initial.y + initial.h);
});

test('an aspect-locked image grows only until its longer side reaches the cap', () => {
  const initial = { w: 1_200, h: 900 };
  const scale = clampAspectScale(50, initial, itemSizeBounds('image', initial));
  assert.equal(initial.w * scale, ITEM_MAX_SIDE_PX.image);
  assert.equal((initial.w * scale) / (initial.h * scale), initial.w / initial.h);
  assert.equal(clampAspectScale(0.5, initial, itemSizeBounds('image', initial)), 0.5);
});

test('a group stops scaling when its first item reaches its cap', () => {
  const zoneSide = 2_400;
  const range = groupScaleRange([
    { type: 'zone', w: zoneSide, h: zoneSide },
    { type: 'sticky', w: 200, h: 180 },
  ]);
  assert.equal(range.maxX, 2);
  assert.equal(range.maxY, 2);
  assert.ok(range.minX < 1 && range.minY < 1);
});

test('a group with an item already over its cap can shrink but not grow', () => {
  const range = groupScaleRange([{ type: 'image', w: 9_520, h: 7_140 }]);
  assert.equal(range.maxX, 1);
  assert.equal(range.maxY, 1);
});

test('drawing a new zone larger than the cap creates a capped zone', () => {
  for (const mode of ['public', 'private']) {
    assert.deepEqual(publicZoneCreationSize(mode, 20_000, 20_000),
      { w: ITEM_MAX_SIDE_PX.zone, h: ITEM_MAX_SIDE_PX.zone }, mode);
  }
});
