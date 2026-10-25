import test from 'node:test';
import assert from 'node:assert/strict';
import * as layout from './chrome-layout.js';
import {
  Z, toolbarAnchorY, TOPBAR_BOTTOM_PX, TOPBAR_INSET_PX, TOPBAR_H_PX, TOOLBAR_TOPBAR_CLEARANCE_PX,
  TOP_STACK_GAP_PX, MINIMAP_BOTTOM_PX, DOCK_H_PX, DOCK_INSET_PX, TOAST_BOTTOM_PX,
  FOLLOW_BANNER_H_PX, TIMER_DOCK_H_PX, TOP_STACK_ITEM_GAP_PX, topStackHeightPx,
  DOCK_TILE_H_PX, DOCK_PADDING_PX, CHROME_BORDER_PX,
} from './chrome-layout.js';

test('toolbar anchor clears the topbar and preserves anchors above the minimum', () => {
  const minimum = TOPBAR_BOTTOM_PX + TOOLBAR_TOPBAR_CLEARANCE_PX;
  for (const y of [-1000, 0, TOPBAR_BOTTOM_PX]) assert.ok(toolbarAnchorY(y) >= minimum);
  const above = minimum + 1;
  assert.equal(toolbarAnchorY(above), above);
  assert.equal(TOPBAR_BOTTOM_PX, TOPBAR_INSET_PX + TOPBAR_H_PX);
});

test('chrome layers preserve ordering and distinct integer levels', () => {
  const ascending = [Z.GRID, Z.CANVAS, Z.SELECTION_TOOLBAR, Z.CURSOR_LAYER, Z.DOCK,
    Z.TOP_CENTER_STACK, Z.TOPBAR, Z.POPOVER_BACKDROP, Z.POPOVER, Z.MODAL, Z.MODAL_RAISED, Z.TOAST];
  for (let index = 1; index < ascending.length; index += 1) assert.ok(ascending[index] > ascending[index - 1]);
  assert.ok(Z.TOOLBAR_POPOVER > Z.TOOLBAR_POPOVER_BACKDROP);
  assert.ok(Z.TOOLBAR_POPOVER_BACKDROP > Z.SELECTION_TOOLBAR);
  const values = Object.values(Z);
  assert.ok(values.every(Number.isInteger));
  assert.equal(new Set(values).size, values.length);
  assert.ok(Object.isFrozen(Z));
});

test('chrome offsets preserve minimap placement and clear the dock', () => {
  assert.ok(TOPBAR_BOTTOM_PX + TOP_STACK_GAP_PX > TOPBAR_BOTTOM_PX);
  assert.equal(MINIMAP_BOTTOM_PX, 60);
  assert.equal(DOCK_H_PX, DOCK_TILE_H_PX + 2 * (DOCK_PADDING_PX + CHROME_BORDER_PX));
  assert.ok(TOAST_BOTTOM_PX > DOCK_INSET_PX + DOCK_H_PX);
});

test('empty stack preserves the existing toolbar clamp', () => {
  const height = topStackHeightPx({ hasFollow: false, timerCount: 0 });
  assert.equal(height, 0);
  for (const rawY of [-1000, 0, TOPBAR_BOTTOM_PX, 1000]) {
    assert.equal(toolbarAnchorY(rawY, height), toolbarAnchorY(rawY));
  }
});

test('stack height sums fixed item heights and gaps, and toolbar clears its bottom', () => {
  for (const hasFollow of [false, true]) {
    for (const timerCount of [0, 1, 3]) {
      const itemCount = Number(hasFollow) + timerCount;
      const expected = Number(hasFollow) * FOLLOW_BANNER_H_PX + timerCount * TIMER_DOCK_H_PX
        + Math.max(0, itemCount - 1) * TOP_STACK_ITEM_GAP_PX;
      const height = topStackHeightPx({ hasFollow, timerCount });
      assert.equal(height, expected);
      const stackBottom = TOPBAR_BOTTOM_PX + (itemCount > 0 ? TOP_STACK_GAP_PX + expected : 0);
      const minimum = stackBottom + TOOLBAR_TOPBAR_CLEARANCE_PX;
      assert.ok(toolbarAnchorY(0, height) >= minimum);
      assert.equal(toolbarAnchorY(minimum + 1, height), minimum + 1);
    }
  }
});


test('minimap dimensions preserve the model surface and panel padding', () => {
  assert.equal(layout.MINIMAP_W_PX, 220);
  assert.equal(layout.MINIMAP_H_PX, 132);
  assert.equal(layout.MINIMAP_PANEL_PADDING_TOTAL_PX, 16);
});
