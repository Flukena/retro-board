import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileBoardSnapshot } from './board-reconciliation.js';
import { DEFAULT_BOARD } from './board-state.js';
import { RECENT_LOCAL_ITEM_WINDOW_MS } from './pending-local-items.js';

const NOW_MS = 10_000;
const context = overrides => ({ draggedIds: new Set(), recentMoves: new Map(), isUndoRedo: false,
  deletedItemIds: new Set(), userId: 'self', nowMs: NOW_MS, moveNowMs: NOW_MS, ...overrides });
const note = overrides => ({ id: 'note', type: 'sticky', x: 1, y: 2, w: 120, h: 100, text: 'remote', ...overrides });

test('active dragging keeps only local geometry while accepting remote text and metadata', () => {
  const local = note({ x: 200, y: 300, w: 240 });
  const result = reconcileBoardSnapshot({ items: [local] }, { items: [note()], allRevealed: true }, context({ draggedIds: new Set(['note']) }));
  assert.deepEqual(result.board.items, [note({ x: 200, y: 300, w: 240 })]);
  assert.equal(result.board.allRevealed, true);
});

test('recent move protection expires without mutating input state', () => {
  const moves = new Map([['note', { x: 90, y: 80, until: NOW_MS }]]);
  const remote = { items: [note()] };
  const result = reconcileBoardSnapshot({ items: [note({ x: 500 })] }, remote, context({ recentMoves: moves }));
  assert.deepEqual(result.board.items, remote.items);
  assert.equal(result.recentMoves.size, 0);
  assert.equal(moves.size, 1);
});

test('pending local creates survive stale snapshots but explicit deletion and undo remain authoritative', () => {
  const local = note({ authorId: 'self', createdAt: NOW_MS });
  const previous = { items: [local] };
  assert.deepEqual(reconcileBoardSnapshot(previous, { items: [] }, context()).board.items, [local]);
  assert.deepEqual(reconcileBoardSnapshot(previous, { items: [] }, context({ deletedItemIds: new Set(['note']) })).board.items, []);
  assert.deepEqual(reconcileBoardSnapshot(previous, { items: [] }, context({ isUndoRedo: true })).board.items, []);
});

test('snapshot creation protection and move expiry keep their separate capture times', () => {
  const CLOCK_ADVANCE_MS = 2;
  const MOVE_EXPIRY_OFFSET_MS = 1;
  const local = note({ authorId: 'self', createdAt: NOW_MS - RECENT_LOCAL_ITEM_WINDOW_MS + MOVE_EXPIRY_OFFSET_MS });
  const result = reconcileBoardSnapshot({ items: [local] }, { items: [] }, context({
    moveNowMs: NOW_MS + CLOCK_ADVANCE_MS,
    recentMoves: new Map([['note', { x: 9, y: 8, until: NOW_MS + MOVE_EXPIRY_OFFSET_MS }]]),
  }));
  assert.equal(result.recentMoves.size, 0, 'Move grace expires at reconciliation time');
  assert.deepEqual(result.board.items, [local], 'Pending creates use the original snapshot capture time');
});

test('unchanged canonical snapshots preserve board and item identities instead of rebuilding the render cache', () => {
  const previous = { ...DEFAULT_BOARD, items: [note()] };
  const remote = { ...previous, items: [{ ...previous.items[0] }] };
  const result = reconcileBoardSnapshot(previous, remote, context());
  assert.equal(result.board, previous);
  assert.equal(result.board.items, previous.items);
  assert.equal(result.board.items[0], previous.items[0]);
});
test('one changed item or metadata field preserves unchanged neighbors while peer edits and reorder remain authoritative', () => {
  const first = note(), second = note({ id: 'second' });
  const previous = { ...DEFAULT_BOARD, items: [first, second] };
  const result = reconcileBoardSnapshot(previous, { ...previous, items: [{ ...first, text: 'peer' }, { ...second }] }, context());
  assert.equal(result.board.items[0].text, 'peer'); assert.notEqual(result.board.items[0], first);
  assert.equal(result.board.items[1], second);
  const reordered = reconcileBoardSnapshot(previous, { ...previous, allRevealed: true, items: [{ ...second }, { ...first }] }, context());
  assert.deepEqual(reordered.board.items, [second, first]);
  assert.equal(reordered.board.items[0], second); assert.equal(reordered.board.allRevealed, true);
});
