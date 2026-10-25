import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveExportBoardCode } from './export-filename.js';

test('export uses the room code in the current URL instead of a stale room prop', () => {
  assert.equal(resolveExportBoardCode('OldRoom1', '/b/wDfFRqg5'), 'wDfFRqg5');
  assert.equal(resolveExportBoardCode('OldRoom1', '/b/wDfFRqg5/'), 'wDfFRqg5');
});

test('export falls back safely when the current URL is not a board route', () => {
  assert.equal(resolveExportBoardCode('Fallback1', '/'), 'Fallback1');
  assert.equal(resolveExportBoardCode(null, '/'), 'board');
});
