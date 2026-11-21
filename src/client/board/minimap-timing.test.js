import test from 'node:test';
import assert from 'node:assert/strict';
import * as timing from './minimap-timing.js';

test('minimap-timing preserves the characterized interaction thresholds', () => {
  assert.deepEqual({ ...timing }, {'MINIMAP_IDLE_MS': 1100});
});
