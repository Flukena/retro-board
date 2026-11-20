import test from 'node:test';
import assert from 'node:assert/strict';
import { undoBlockReason } from './undo-guard.js';

for (const [midDrag, locked, expected] of [
  [false, false, null],
  [false, true, 'common.warnLockEdit'],
  [true, false, 'topbar.finishDragFirst'],
  [true, true, 'topbar.finishDragFirst'],
]) {
  test(`undo guard: midDrag=${midDrag}, locked=${locked}`, () => {
    assert.equal(undoBlockReason(midDrag, locked), expected);
  });
}
