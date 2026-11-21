import test from 'node:test';
import assert from 'node:assert/strict';
import * as timing from './cursor-timing.js';

test('cursor-timing preserves the characterized interaction thresholds', () => {
  assert.deepEqual({ ...timing }, {'CURSOR_BROADCAST_MS': 24});
});
