import test from 'node:test';
import assert from 'node:assert/strict';
import { CREATION_MODE, textPlacementAt, toggleCreationMode } from './creation-mode.js';

test('choosing a placement tool arms it, and choosing it again disarms it', () => {
  assert.equal(toggleCreationMode(null, CREATION_MODE.TEXT), CREATION_MODE.TEXT);
  assert.equal(toggleCreationMode(CREATION_MODE.TEXT, CREATION_MODE.TEXT), null);
  assert.equal(toggleCreationMode(CREATION_MODE.ZONE, CREATION_MODE.TEXT), CREATION_MODE.TEXT);
  assert.equal(toggleCreationMode(CREATION_MODE.TEXT, CREATION_MODE.ZONE), CREATION_MODE.ZONE);
});

test('a placed text box is centred on the point the user clicked or tapped', () => {
  const size = { w: 200, h: 40 };
  const at = textPlacementAt({ x: 500, y: 300 }, size);
  assert.deepEqual(at, { x: 400, y: 280 });
  assert.equal(at.x + size.w / 2, 500);
  assert.equal(at.y + size.h / 2, 300);
});
