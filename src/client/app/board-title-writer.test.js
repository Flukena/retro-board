import test from 'node:test';
import assert from 'node:assert/strict';
import { boardTitleWriter, boardTitleWriterFor } from './board-title-writer.js';
import { BOARD_TITLE_MAX_LENGTH } from '../../domain/security-boundaries.js';

test('a rename writes the trimmed title through the ordinary, undoable meta patch', () => {
  const patches = [];
  const writer = boardTitleWriterFor({ title: 'Old', patchMeta: (...args) => { patches.push(args); return true; } });
  assert.equal(writer.title, 'Old');
  assert.equal(writer.rename('  Sprint 13  '), true);
  // No options: not silent, so the board writes it with the undoable local origin.
  assert.deepEqual(patches, [[{ title: 'Sprint 13' }]]);
});

test('a title outside the bounds or a refused write is not a rename', () => {
  const patches = [];
  const writer = boardTitleWriterFor({ title: null, patchMeta: (patch) => { patches.push(patch); return false; } });
  assert.equal(writer.rename('   '), false);
  assert.equal(writer.rename('x'.repeat(BOARD_TITLE_MAX_LENGTH + 1)), false);
  assert.deepEqual(patches, [], 'out-of-bounds titles never reach the board');
  assert.equal(writer.rename('Fine'), false, 'a write the board refused');
});

test('the published writer is the newest one, and an older unpublish never clears it', () => {
  let changes = 0;
  const unsubscribe = boardTitleWriter.subscribe(() => { changes += 1; });
  const first = boardTitleWriterFor({ title: 'A', patchMeta: () => true });
  const second = boardTitleWriterFor({ title: 'B', patchMeta: () => true });
  const unpublishFirst = boardTitleWriter.publish(first);
  const unpublishSecond = boardTitleWriter.publish(second);
  unpublishFirst();
  assert.equal(boardTitleWriter.getSnapshot(), second);
  unpublishSecond();
  assert.equal(boardTitleWriter.getSnapshot(), null);
  assert.equal(changes, 3);
  unsubscribe();
});
