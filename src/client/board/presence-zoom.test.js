import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceWorldScale } from './presence-zoom.js';

test('on screen, names grow linearly from overview to normal and stay normal above 100%', () => {
  const cases = [[0.05, 0.6], [0.525, 0.8], [1, 1], [2, 1], [3, 1]];
  for (const [zoom, expected] of cases) {
    assert.ok(Math.abs(zoom * presenceWorldScale(zoom) - expected) < 1e-9, `screen scale at ${zoom}`);
  }
});
