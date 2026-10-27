import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDiscardsDraft } from './drawing-close.js';

test('closing Draw normally keeps the strokes, including after a recoverable notice', () => {
  for (const error of [null, undefined, 'draw.limitReached', 'draw.empty']) {
    assert.equal(closeDiscardsDraft({ error, failed: false, closing: false }), false, String(error));
  }
});

test('closing again after a failed save or a failed image load drops the draft so the user is not stuck', () => {
  for (const error of ['draw.conflict', 'draw.encodeFailed', 'draw.saveFailed']) {
    assert.equal(closeDiscardsDraft({ error, failed: false }), true, error);
  }
  assert.equal(closeDiscardsDraft({ error: null, failed: true }), true);
});

test('closing while the closing save is still uploading stops it and drops the draft', () => {
  assert.equal(closeDiscardsDraft({ error: null, failed: false, closing: true }), true);
});
