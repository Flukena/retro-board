import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEWPORT_ZOOM_MIN, VIEWPORT_ZOOM_MAX } from './viewport-limits.js';

test('viewport zoom scale ranges from five percent to three hundred percent', () => {
  assert.equal(VIEWPORT_ZOOM_MIN, 0.05);
  assert.equal(VIEWPORT_ZOOM_MAX, 3);
});
