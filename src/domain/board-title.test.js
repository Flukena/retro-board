import test from 'node:test';
import assert from 'node:assert/strict';
import { boardTitleToSeed, isBoardTitle, normalizeBoardTitle } from './board-title.js';
import { BOARD_TITLE_MAX_LENGTH } from './security-boundaries.js';

test('board titles are trimmed, non-empty and bounded', () => {
  assert.equal(isBoardTitle('Sprint 42 Retro'), true);
  for (const bad of ['', '  ', ' padded ', 'x'.repeat(BOARD_TITLE_MAX_LENGTH + 1), 42, null, {}]) {
    assert.equal(isBoardTitle(bad), false, JSON.stringify(bad));
  }
  assert.equal(normalizeBoardTitle('  ทีม A  '), 'ทีม A');
  assert.equal(normalizeBoardTitle('   '), null);
  assert.equal(normalizeBoardTitle(undefined), null);
  assert.equal(normalizeBoardTitle('y'.repeat(BOARD_TITLE_MAX_LENGTH + 5)).length, BOARD_TITLE_MAX_LENGTH);
});

test('a pending title seeds only a room that has never been named', () => {
  assert.equal(boardTitleToSeed({ storedTitle: undefined, pendingTitle: ' Retro ' }), 'Retro');
  assert.equal(boardTitleToSeed({ storedTitle: 'Existing', pendingTitle: 'Retro' }), null);
  assert.equal(boardTitleToSeed({ storedTitle: null, pendingTitle: 'Retro' }), null);
  assert.equal(boardTitleToSeed({ storedTitle: undefined, pendingTitle: '' }), null);
});
