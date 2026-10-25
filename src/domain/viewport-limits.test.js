import test from 'node:test';
import assert from 'node:assert/strict';
import * as viewportLimits from './viewport-limits.js';
import { VIEWPORT_ZOOM_MIN, VIEWPORT_ZOOM_MAX } from './viewport-limits.js';

test('viewport zoom scale ranges from five percent to three hundred percent', () => {
  assert.equal(VIEWPORT_ZOOM_MIN, 0.05);
  assert.equal(VIEWPORT_ZOOM_MAX, 3);
});

test('card overview begins strictly below twenty percent zoom', () => {
  assert.equal(viewportLimits.CARD_OVERVIEW_ZOOM_MAX, 0.2);
  for (const [zoom, expected] of [[0.05, true], [0.12, true], [0.199, true], [0.2, false], [0.4, false], [1, false]]) {
    assert.equal(viewportLimits.cardOverviewAtZoom(zoom), expected, `zoom ${zoom}`);
  }
});

test('settled render state preserves the viewport and derives overview from its zoom alone', () => {
  for (const [zoom, compact] of [[0.12, true], [0.2, false], [1, false]]) {
    const viewport = { x: 12, y: -24, zoom };
    const policy = viewportLimits.settledCardRenderState(viewport);
    assert.equal(policy.viewport, viewport);
    assert.equal(policy.compact, compact);
  }
});
