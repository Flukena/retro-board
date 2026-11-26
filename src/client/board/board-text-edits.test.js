import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_TEXT_MAX_LENGTH, ZONE_TITLE_MAX_LENGTH } from '../../domain/security-boundaries.js';
import { applyOptimisticItemPatch, boundBoardTextPatch } from './board-text-edits.js';

test('text and title patches keep their existing input limits and geometry', () => {
  const resize = { h: 200 };
  assert.deepEqual(boundBoardTextPatch({ ...resize, text: 'a'.repeat(BOARD_TEXT_MAX_LENGTH + 1) }),
    { ...resize, text: 'a'.repeat(BOARD_TEXT_MAX_LENGTH) });
  assert.deepEqual(boundBoardTextPatch({ title: 'b'.repeat(ZONE_TITLE_MAX_LENGTH + 1) }),
    { title: 'b'.repeat(ZONE_TITLE_MAX_LENGTH) });
});

test('optimistic sticky updates mirror creation and removal of attribution in the room', () => {
  const card = { type: 'sticky', text: 'Initial text', authorId: 'ada', authorName: 'Ada' };
  const editor = { userId: 'bo', name: 'Bo' };
  const afterPeerEdit = applyOptimisticItemPatch(card, { text: 'New text' }, editor);
  assert.deepEqual(afterPeerEdit, { ...card, text: 'New text', lastEditor: editor });
  const afterOwnerEdit = applyOptimisticItemPatch(afterPeerEdit, { text: 'Initial text' }, { userId: 'ada', name: 'Ada' });
  assert.deepEqual(afterOwnerEdit, card);
});
