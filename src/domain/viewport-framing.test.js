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
