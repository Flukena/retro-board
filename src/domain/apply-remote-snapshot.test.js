import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRemoteSnapshot, shouldDropSnapshotFocus } from './apply-remote-snapshot.js';
import { DEFAULT_BOARD } from './board-state.js';

const NOW_MS = 16000;
const WINDOW_MS = 8000;
const note = overrides => ({ id: 'note', type: 'sticky', x: 1, y: 2, w: 200, h: 180, text: 'remote', ...overrides });
const board = items => ({ ...DEFAULT_BOARD, items });
const context = overrides => ({ isUndoRedo: false, deletedItemIds: new Set(), userId: 'self', nowMs: NOW_MS, moveNowMs: NOW_MS, draggedIds: new Set(), recentMoves: new Map(), ...overrides });
const recentMove = until => ({ x: 90, y: 80, w: 210, h: 190, until });

test('pure snapshot contract returns only board/forgetMoveIds and never mutates input maps or boards', () => {
  const previous = board([note()]);
  const remote = board([note({ text: 'peer edit' })]);
  const moves = new Map([['note', recentMove(NOW_MS + WINDOW_MS)]]);
  const before = structuredClone({ previous, remote, moves });
  const result = applyRemoteSnapshot(previous, remote, context({ recentMoves: moves }));
  assert.deepEqual(Object.keys(result).sort(), ['board', 'forgetMoveIds']);
  assert.deepEqual(result.board.items, [note({ text: 'peer edit', x: 90, y: 80, w: 210, h: 190 })]);
  assert.deepEqual(result.forgetMoveIds, []);
  assert.deepEqual({ previous, remote, moves }, before);
});

for (const elapsedMs of [WINDOW_MS - 1, WINDOW_MS, WINDOW_MS + 1]) {
  test(`recent geometry has the exact 8000ms boundary at elapsed ${elapsedMs}`, () => {
    const markMs = NOW_MS - elapsedMs;
    const result = applyRemoteSnapshot(board([note()]), board([note()]), context({ recentMoves: new Map([['note', recentMove(markMs + WINDOW_MS)]]) }));
    const protectedMove = elapsedMs < WINDOW_MS;
    assert.equal(result.board.items[0].x, protectedMove ? 90 : 1);
    assert.deepEqual(result.forgetMoveIds, protectedMove ? [] : ['note']);
  });
}

test('active drag keeps local geometry while accepting remote content', () => {
  const result = applyRemoteSnapshot(board([note({ x: 500, w: 300 })]), board([note({ text: 'peer' })]), context({ draggedIds: new Set(['note']) }));
  assert.deepEqual(result.board.items, [note({ x: 500, w: 300, text: 'peer' })]);
});

for (const { name, overrides, survives } of [
  { name: 'recent local create', overrides: {}, survives: true },
  { name: 'explicit peer deletion', overrides: { deletedItemIds: new Set(['note']) }, survives: false },
  { name: 'undo', overrides: { isUndoRedo: true }, survives: false },
  { name: 'different author', overrides: { userId: 'peer' }, survives: false },
  { name: 'create-window boundary', overrides: { nowMs: NOW_MS + WINDOW_MS }, survives: false },
]) {
  test(`focus-drop and missing-item rules preserve ${name} legacy behavior`, () => {
    const previous = board([note({ authorId: 'self', createdAt: NOW_MS })]);
    const remote = board([]);
    const ctx = context(overrides);
    assert.equal(shouldDropSnapshotFocus(previous, remote, 'note', ctx), !survives);
    assert.equal(applyRemoteSnapshot(previous, remote, ctx).board.items.length, survives ? 1 : 0);
    assert.equal(shouldDropSnapshotFocus(previous, remote, null, ctx), false);
    assert.equal(shouldDropSnapshotFocus(previous, previous, 'note', ctx), false);
  });
}

test('dropping focus does not invent deletions of unexpired move records for an absent item', () => {
  const previous = board([note()]);
  const remote = board([]);
  const ctx = context({ recentMoves: new Map([['note', recentMove(NOW_MS + 1)], ['expired', recentMove(NOW_MS)]]) });
  assert.equal(shouldDropSnapshotFocus(previous, remote, 'note', ctx), true);
  const result = applyRemoteSnapshot(previous, remote, ctx);
  assert.deepEqual(result.board.items, []);
  assert.deepEqual(result.forgetMoveIds, ['expired']);
});

test('undo/redo overrides recent-move protection even before its window expires', () => {
  const result = applyRemoteSnapshot(board([note({ x: 500 })]), board([note()]), context({ isUndoRedo: true, recentMoves: new Map([['note', recentMove(NOW_MS + WINDOW_MS)]]) }));
  assert.equal(result.board.items[0].x, 1);
  assert.deepEqual(result.forgetMoveIds, ['note']);
});

test('snapshot capture time and updater move-expiry time stay separate', () => {
  const local = note({ authorId: 'self', createdAt: NOW_MS - WINDOW_MS + 1 });
  const result = applyRemoteSnapshot(board([local]), board([]), context({ moveNowMs: NOW_MS + 2, recentMoves: new Map([['note', recentMove(NOW_MS + 1)]]) }));
  assert.deepEqual(result.board.items, [local]);
  assert.deepEqual(result.forgetMoveIds, ['note']);
});

test('INV-15 repeated updater calls produce identical boards and final recent-move sets', () => {
  const previous = board([note({ x: 500 })]);
  const remote = board([note({ text: 'peer' })]);
  const original = new Map([['note', recentMove(NOW_MS + 1)], ['expired', recentMove(NOW_MS)]]);
  const liveMoves = new Map(original);
  const update = () => {
    const result = applyRemoteSnapshot(previous, remote, context({ recentMoves: liveMoves }));
    for (const id of result.forgetMoveIds) liveMoves.delete(id);
    return result.board;
  };
  const once = update();
  const movesAfterOnce = new Map(liveMoves);
  const twice = update();
  assert.deepEqual(twice, once);
  assert.deepEqual(liveMoves, movesAfterOnce);
  assert.deepEqual([...liveMoves.keys()], ['note']);
  assert.equal(once.items[0].x, 90);
  assert.equal(once.items[0].text, 'peer');
  assert.equal(original.size, 2);
});
