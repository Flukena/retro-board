import test from 'node:test';
import assert from 'node:assert/strict';
import { undoBlockReason } from './undo-guard.js';

for (const [midDrag, locked, hasUndo, expected] of [
  [false, false, true, null],
  [false, true, true, 'common.warnLockEdit'],
  [true, false, true, 'topbar.finishDragFirst'],
  [true, true, true, 'topbar.finishDragFirst'],
  [false, false, false, 'topbar.nothingToUndo'],
  [false, true, false, 'common.warnLockEdit'],
  [true, false, false, 'topbar.finishDragFirst'],
  [true, true, false, 'topbar.finishDragFirst'],
]) {
  test(`undo guard: midDrag=${midDrag}, locked=${locked}, hasUndo=${hasUndo}`, () => {
    assert.equal(undoBlockReason(midDrag, locked, hasUndo), expected);
  });
}
