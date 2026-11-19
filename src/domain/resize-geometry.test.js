import test from 'node:test';
import assert from 'node:assert/strict';
import { resizeGeometry } from './resize-geometry.js';
import { itemSizeBounds } from './item-size-limits.js';

const RESIZE_FLOAT_TOLERANCE = 1e-9;
const initial = Object.freeze({ x: 100, y: 200, w: 400, h: 200 });
const bounds = itemSizeBounds('image', initial);
for (const [corner, expected] of [
  ['nw', { x: 120, y: 210, w: 380, h: 190 }],
  ['ne', { x: 100, y: 210, w: 420, h: 190 }],
  ['sw', { x: 120, y: 200, w: 380, h: 210 }],
  ['se', { x: 100, y: 200, w: 420, h: 210 }],
]) test(`${corner} keeps opposite corner fixed`, () => {
  assert.deepEqual(resizeGeometry(initial, corner, 20, 10, false, bounds), expected);
});
for (const [corner, dx, dy, expected] of [
  ['nw', -40, -10, { x: 60, y: 180, w: 440, h: 220 }],
  ['ne', 10, -20, { x: 100, y: 180, w: 440, h: 220 }],
  ['sw', -40, 10, { x: 60, y: 200, w: 440, h: 220 }],
  ['se', 10, 20, { x: 100, y: 200, w: 440, h: 220 }],
]) test(`${corner} aspect lock follows proportionally dominant axis`, () => {
  const actual = resizeGeometry(initial, corner, dx, dy, true, bounds);
  for (const field of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(actual[field] - expected[field]) < RESIZE_FLOAT_TOLERANCE, field);
});
test('minimum dimensions clamp and preserve the opposite anchor', () => {
  assert.deepEqual(resizeGeometry(initial, 'nw', 1000, 1000, false, bounds), { x: 440, y: 360, w: 60, h: 40 });
});
test('aspect growth stops at image maximum on the longest side', () => {
  assert.deepEqual(resizeGeometry(initial, 'se', 4000, 0, true, bounds), { x: 100, y: 200, w: 2400, h: 1200 });
});
test('unlocked growth clamps each axis independently', () => {
  assert.deepEqual(resizeGeometry(initial, 'se', 4000, 0, false, bounds), { x: 100, y: 200, w: 2400, h: 200 });
});
test('zero movement and unknown handle retain geometry', () => {
  assert.deepEqual(resizeGeometry(initial, 'se', 0, 0, false, bounds), initial);
  assert.deepEqual(resizeGeometry(initial, 'unknown', 20, 10, false, bounds), initial);
});
