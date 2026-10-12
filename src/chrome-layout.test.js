import test from 'node:test';
import assert from 'node:assert/strict';
import { Z, toolbarAnchorY, TOPBAR_BOTTOM_PX, TOPBAR_INSET_PX, TOPBAR_H_PX, TOOLBAR_TOPBAR_CLEARANCE_PX } from './chrome-layout.js';

test('toolbar anchor clears the topbar and preserves anchors above the minimum', () => {
  const minimum = TOPBAR_BOTTOM_PX + TOOLBAR_TOPBAR_CLEARANCE_PX;
  for (const y of [-1000, 0, TOPBAR_BOTTOM_PX]) assert.ok(toolbarAnchorY(y) >= minimum);
  const above = minimum + 1;
  assert.equal(toolbarAnchorY(above), above);
  assert.equal(TOPBAR_BOTTOM_PX, TOPBAR_INSET_PX + TOPBAR_H_PX);
});

test('chrome layers preserve ordering and distinct integer levels', () => {
  const ascending = [Z.GRID, Z.CANVAS, Z.SELECTION_TOOLBAR, Z.CURSOR_LAYER, Z.DOCK, Z.TIMER_DOCK,
    Z.FOLLOW_BANNER, Z.TOPBAR, Z.POPOVER_BACKDROP, Z.POPOVER, Z.MODAL, Z.MODAL_RAISED, Z.TOAST];
  for (let index = 1; index < ascending.length; index += 1) assert.ok(ascending[index] > ascending[index - 1]);
  assert.ok(Z.TOOLBAR_POPOVER > Z.TOOLBAR_POPOVER_BACKDROP);
  assert.ok(Z.TOOLBAR_POPOVER_BACKDROP > Z.SELECTION_TOOLBAR);
  const values = Object.values(Z);
  assert.ok(values.every(Number.isInteger));
  assert.equal(new Set(values).size, values.length);
  assert.ok(Object.isFrozen(Z));
});
