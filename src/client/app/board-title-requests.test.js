import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoardTitle, requestBoardRename, serveBoardTitle } from './board-title-requests.js';
import { BOARD_TITLE_MAX_LENGTH } from '../../domain/security-boundaries.js';

test('with no open board, nothing answers: no title and no rename', () => {
  const events = new EventTarget();
  assert.equal(readBoardTitle(events), null);
  assert.equal(requestBoardRename('Sprint 13', events), false);
});

test('the open board answers with its title and applies a rename through the ordinary, undoable meta patch', () => {
  const events = new EventTarget();
  const patches = [];
  const stop = serveBoardTitle(events, { title: 'Old', patchMeta: (...args) => { patches.push(args); return true; } });
  assert.equal(readBoardTitle(events), 'Old');
  assert.equal(requestBoardRename('  Sprint 13  ', events), true);
  // No options: not silent, so the board writes it with the undoable local origin.
  assert.deepEqual(patches, [[{ title: 'Sprint 13' }]]);
  stop();
  assert.equal(readBoardTitle(events), null, 'an unmounted board stops answering');
  assert.equal(requestBoardRename('Again', events), false);
  assert.equal(patches.length, 1);
});

test('a title outside the bounds never reaches the board, and a refused write is not a rename', () => {
  const events = new EventTarget();
  const patches = [];
  const stop = serveBoardTitle(events, { title: null, patchMeta: (patch) => { patches.push(patch); return false; } });
  assert.equal(requestBoardRename('   ', events), false);
  assert.equal(requestBoardRename('x'.repeat(BOARD_TITLE_MAX_LENGTH + 1), events), false);
  assert.deepEqual(patches, []);
  assert.equal(requestBoardRename('Fine', events), false);
  assert.deepEqual(patches, [{ title: 'Fine' }]);
  stop();
});
