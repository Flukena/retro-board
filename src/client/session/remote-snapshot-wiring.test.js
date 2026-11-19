import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../../../RetroBoard.jsx', import.meta.url), 'utf8');
const UNDO_CLEAR = 'if (isUndoRedo) recentlyMovedRef.current.clear();';
const UPDATER_START = 'setBoard((previous) => {';

function assertUndoClearOrder(source) {
  const callback = source.indexOf('const applyRemoteBoard = useCallback(');
  const clear = source.indexOf(UNDO_CLEAR, callback);
  const focus = source.indexOf('const focusedItemId', callback);
  const updater = source.indexOf(UPDATER_START, callback);
  assert.ok(callback >= 0 && clear > callback && focus > clear && updater > focus,
    'undo/redo clears the recent-move ref before focus handling and outside the React updater');
}

test('undo/redo retains its imperative clear at the original reconcile call site', () => {
  assertUndoClearOrder(SOURCE);
});

test('undo-clear ordering guard rejects moving the clear into the updater', () => {
  const moved = SOURCE.replace(UNDO_CLEAR, '').replace(UPDATER_START, `${UPDATER_START}\n${UNDO_CLEAR}`);
  assert.throws(() => assertUndoClearOrder(moved), assert.AssertionError);
});

const FORGET_MOVES = 'recentMoves.forget(result.forgetMoveIds);';
const RETURN_BOARD = 'return result.board;';

function assertUpdaterForgetOrder(source) {
  const callback = source.indexOf('const applyRemoteBoard = useCallback(');
  const updater = source.indexOf(UPDATER_START, callback);
  const reduce = source.indexOf('const result = applyRemoteSnapshot(', updater);
  const forget = source.indexOf(FORGET_MOVES, updater);
  const returned = source.indexOf(RETURN_BOARD, updater);
  assert.ok(updater > callback && reduce > updater && forget > reduce && returned > forget,
    'the same React updater reconciles, forgets move IDs, then returns the board');
}

test('snapshot reconciliation forgets expired IDs inside the same updater before returning', () => {
  assertUpdaterForgetOrder(SOURCE);
});

test('updater-order guard rejects forgetting after the board is returned', () => {
  const moved = SOURCE.replace(FORGET_MOVES, '').replace(RETURN_BOARD, `${RETURN_BOARD}\n${FORGET_MOVES}`);
  assert.throws(() => assertUpdaterForgetOrder(moved), assert.AssertionError);
});
