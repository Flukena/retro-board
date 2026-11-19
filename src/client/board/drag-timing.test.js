import test from 'node:test';
import assert from 'node:assert/strict';
import * as timing from './drag-timing.js';

test('drag-timing preserves the characterized interaction thresholds', () => {
  assert.deepEqual({ ...timing }, {'DRAG_THRESHOLD': 4, 'DRAG_FLUSH_MS': 60, 'DRAG_TRAILING_MS': 80, 'RECENT_MOVE_WINDOW_MS': 8000});
});
