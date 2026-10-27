import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomViewportAt, fitViewportToItems } from './viewport-framing.js';
import { wheelZoomFactor, ZOOM_STEP_FACTOR } from './viewport-zoom.js';

const SCREEN_ANCHOR_PX = { x: 640, y: 360 };
const NEAR_MINIMUM_VIEWPORT = { x: 0, y: 0, zoom: 0.06 };

test('wheel, pinch and zoom-out steps reach five percent and retain their world anchor', () => {
  for (const factor of [wheelZoomFactor(100), wheelZoomFactor(100, true), 1 / ZOOM_STEP_FACTOR]) {
    const next = zoomViewportAt(NEAR_MINIMUM_VIEWPORT, NEAR_MINIMUM_VIEWPORT.zoom * factor, SCREEN_ANCHOR_PX);
    assert.equal(next.zoom, 0.05);
    for (const axis of ['x', 'y']) {
      const before = (SCREEN_ANCHOR_PX[axis] - NEAR_MINIMUM_VIEWPORT[axis]) / NEAR_MINIMUM_VIEWPORT.zoom;
      const after = (SCREEN_ANCHOR_PX[axis] - next[axis]) / next.zoom;
      assert.ok(Math.abs(before - after) < 1e-9);
    }
  }
  assert.equal(zoomViewportAt(NEAR_MINIMUM_VIEWPORT, 0, SCREEN_ANCHOR_PX).zoom, 0.05);
  assert.equal(zoomViewportAt(NEAR_MINIMUM_VIEWPORT, 4, SCREEN_ANCHOR_PX).zoom, 3);
});

test('fit-to-content reaches five percent and centers a board larger than the screen', () => {
  const items = [{ type: 'zone', x: 0, y: 0, w: 30000, h: 20000 }];
  assert.deepEqual(fitViewportToItems(items, 1200, 800), { x: -150, y: -100, zoom: 0.05 });
  assert.deepEqual(fitViewportToItems([], 1200, 800), { x: 600, y: 400, zoom: 1 });
});

test('fit keeps the same screen margin at any zoom, so content clears the top bar', () => {
  const MARGIN_PX = 80;
  const width = 1440;
  const height = 900;
  // 4Ls template: height-bound at about 38 percent zoom.
  const items = [{ type: 'zone', x: 0, y: 0, w: 2460, h: 2220 }];
  const { x, y, zoom } = fitViewportToItems(items, width, height);
  assert.ok(Math.abs(y - MARGIN_PX) < 1e-9, `top margin ${y}`);
  assert.ok(Math.abs(height - (y + 2220 * zoom) - MARGIN_PX) < 1e-9);
  assert.ok(x >= MARGIN_PX && width - (x + 2460 * zoom) >= MARGIN_PX);
});

test('on a narrow phone the margin shrinks to a tenth of the width instead of a fixed 80 px', () => {
  const { x, zoom } = fitViewportToItems([{ type: 'zone', x: 0, y: 0, w: 2460, h: 2220 }], 390, 844);
  assert.ok(Math.abs(x - 39) < 1e-9, `left margin ${x}`);
  assert.ok(Math.abs(zoom - (390 - 78) / 2460) < 1e-9);
});
