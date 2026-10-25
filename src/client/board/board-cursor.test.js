import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasCursor } from './board-cursor.js';

test('canvas cursor keeps pan, space and creation mode precedence', () => {
  for (const mode of [null, 'zone', 'select', 'text', 'image', 'draw']) {
    assert.equal(canvasCursor('pan', true, mode), 'grabbing');
    assert.equal(canvasCursor('pan', false, mode), 'grabbing');
    assert.equal(canvasCursor(undefined, true, mode), 'grab');
  }
  assert.equal(canvasCursor(undefined, false, 'zone'), 'crosshair');
  assert.equal(canvasCursor(undefined, false, 'select'), 'crosshair');
  assert.equal(canvasCursor(undefined, false, 'draw'), 'crosshair');
  assert.equal(canvasCursor(undefined, false, 'text'), 'text', 'Text placement shows where the text will go');
  for (const mode of [null, 'image']) assert.equal(canvasCursor(undefined, false, mode), 'default');
});
