import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneMenuOffset, zoneInlineToolWidth } from './zone-menu-viewport.js';

const VIEWPORT = { left: 0, top: 0, width: 390, height: 844 };
test('zone popup shifts fully inside a narrow viewport without moving an already fitting menu', () => {
  assert.deepEqual(zoneMenuOffset({ left: 100, top: 100, width: 224, height: 400 }, VIEWPORT), { x: 0, y: 0 });
  assert.deepEqual(zoneMenuOffset({ left: 300, top: 500, width: 224, height: 400 }, VIEWPORT), { x: -146, y: -68 });
  assert.deepEqual(zoneMenuOffset({ left: -20, top: -10, width: 224, height: 400 }, VIEWPORT), { x: 32, y: 22 });
});
test('zone popup observes keyboard viewport offsets as well as height', () => {
  const viewport = { left: 20, top: 100, width: 360, height: 340 };
  const rect = { left: 10, top: 200, width: 224, height: 250 };
  const offset = zoneMenuOffset(rect, viewport);
  assert.equal(rect.left + offset.x, 32);
  assert.equal(rect.top + offset.y + rect.height, 428);
});


test('inline zone tools fit beside the left rail and retain board scaling', () => {
  const anchor = { right: 378, top: 100, bottom: 140 };
  const rail = { right: 84, top: 76, bottom: 420 };
  assert.equal(zoneInlineToolWidth(anchor, VIEWPORT, rail, 1), 282);
  assert.equal(zoneInlineToolWidth(anchor, VIEWPORT, rail, 0.5), 564);
  assert.equal(zoneInlineToolWidth(anchor, VIEWPORT, { ...rail, top: 200 }, 1), 366);
  assert.equal(zoneInlineToolWidth({ ...anchor, right: 1000 }, VIEWPORT, rail, 1), 282);
  assert.equal(zoneInlineToolWidth({ ...anchor, right: 50 }, VIEWPORT, rail, 1), 0);
});
