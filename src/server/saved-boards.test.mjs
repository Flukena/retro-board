import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SAVED_BOARDS, SAVED_BOARD_LIMIT, updateSavedHandles, validSavedBoardHandles } from './saved-boards.js';

const handleOf = index => String(index).padStart(32, '0');
test('expired bookmarks free slots and retrying an existing save succeeds even at capacity', () => {
  const handles = Array.from({ length: MAX_SAVED_BOARDS }, (_, i) => handleOf(i));
  const extra = handleOf(MAX_SAVED_BOARDS);
  const change = { handle: extra, saved: true, staleHandles: new Set() };
  assert.deepEqual(updateSavedHandles(handles, { ...change, handle: handles[0] }), handles);
  assert.throws(() => updateSavedHandles(handles, change), { code: SAVED_BOARD_LIMIT });
  assert.deepEqual(updateSavedHandles(handles, { ...change, staleHandles: new Set([handles[0]]) }), [...handles.slice(1), extra]);
  assert.ok(validSavedBoardHandles(handles));
  for (const invalid of [null, ['bad'], [extra, extra], [...handles, extra]]) assert.equal(validSavedBoardHandles(invalid), false);
});
