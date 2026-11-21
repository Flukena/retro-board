import test from 'node:test';
import assert from 'node:assert/strict';
import * as timing from './follow-timing.js';

test('follow-timing preserves the characterized interaction thresholds', () => {
  assert.deepEqual({ ...timing }, {'FOLLOW_VIEWPORT_COMMIT_MS': 96});
});
