import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectionToolbarAnchor, groupSelectionToolbarAnchor, fontSizeForItem,
  clampFontSize, canDecreaseFontSize, canIncreaseFontSize,
} from './selection-toolbar-model.js';
import { toolbarAnchorY, SELECTION_TOOLBAR_GAP_PX } from './chrome-layout.js';

test('selection anchors preserve world-to-screen centres and zone body clearance', () => {
  const viewport = { x: 20, y: 30, zoom: 2 };
  const base = { x: 100, y: 300 };
  for (const [type, width, offset] of [
    ['zone', 240, 0], ['sticky', 200, 0], ['image', 200, 0], ['text', null, 0],
  ]) {
    const item = { ...base, type, ...(type === 'zone' ? { w: width } : {}) };
    const expectedX = base.x * viewport.zoom + viewport.x + (width ? width * viewport.zoom / 2 : 60);
    const expectedY = base.y * viewport.zoom + viewport.y - offset - SELECTION_TOOLBAR_GAP_PX;
    assert.deepEqual(selectionToolbarAnchor(item, viewport, 0), { x: expectedX, y: expectedY });
  }
  assert.equal(selectionToolbarAnchor({ ...base, type: 'image', w: 300 }, viewport).x, 520);
  assert.deepEqual(groupSelectionToolbarAnchor({ ...base, w: 300 }, viewport), {
    x: (100 + 300 / 2) * 2 + 20, y: 300 * 2 + 30 - SELECTION_TOOLBAR_GAP_PX,
  });
});

test('single and group anchors clear the complete top stack', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const stackHeightPx = 150;
  for (const type of ['zone', 'sticky', 'image', 'text']) {
    assert.equal(selectionToolbarAnchor({ type, x: 0, y: 0, w: 200 }, viewport, stackHeightPx).y,
      toolbarAnchorY(-SELECTION_TOOLBAR_GAP_PX, stackHeightPx));
  }
  assert.equal(groupSelectionToolbarAnchor({ x: 0, y: 0, w: 200 }, viewport, stackHeightPx).y,
    toolbarAnchorY(-SELECTION_TOOLBAR_GAP_PX, stackHeightPx));
});

test('font sizes retain type defaults, bounded steps and permissions', () => {
  for (const [type, size] of [['text', 40], ['zone', 16], ['sticky', 20]]) {
    assert.equal(fontSizeForItem({ type }), size);
    assert.equal(fontSizeForItem({ type, fontSize: 22 }), 22);
  }
  for (const [input, expected] of [[8, 10], [10, 10], [42, 42], [96, 96], [98, 96]]) {
    assert.equal(clampFontSize(input), expected);
  }
  assert.equal(canDecreaseFontSize(10, true), false);
  assert.equal(canDecreaseFontSize(12, true), true);
  assert.equal(canIncreaseFontSize(96, true), false);
  assert.equal(canIncreaseFontSize(94, true), true);
  assert.equal(canDecreaseFontSize(40, false), false);
  assert.equal(canIncreaseFontSize(40, false), false);
});

test('zone toolbar stays above the body for every title size', () => {
  const viewport = { x: 20, y: 30, zoom: 2 };
  const base = { type: 'zone', x: 100, y: 500, w: 240 };

  for (const fontSize of [16, 24, 48, 96]) {
    const item = { ...base, fontSize };
    const anchor = selectionToolbarAnchor(item, viewport, 0);
    assert.equal(anchor.y, item.y * viewport.zoom + viewport.y
      - SELECTION_TOOLBAR_GAP_PX);

  }
});
