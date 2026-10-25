import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mobileEditorPanDelta, editorContentOverflowPx, mobileEditorFocusViewport,
  MOBILE_EDITOR_MIN_READABLE_WIDTH_PX,
} from './mobile-editing.js';
import { VIEWPORT_ZOOM_MAX } from '../../domain/viewport-limits.js';

test('inline editor pan keeps the card above the keyboard and outside reserved controls', () => {
  const viewport = { left: 0, top: 0, right: 390, bottom: 400 };
  const insets = { left: 72, top: 72, bottom: 64 };
  assert.deepEqual(mobileEditorPanDelta({ left: 90, right: 330, top: 100, bottom: 260 }, viewport, insets), { x: 0, y: 0 });
  assert.deepEqual(mobileEditorPanDelta({ left: 20, right: 260, top: 300, bottom: 460 }, viewport, insets), { x: 64, y: -136 });
  assert.deepEqual(mobileEditorPanDelta({ left: 90, right: 330, top: 20, bottom: 180 }, viewport, insets), { x: 0, y: 64 });
});

test('oversized inline editor anchors its start once rather than oscillating between edges', () => {
  const viewport = { left: 0, top: 0, right: 390, bottom: 400 };
  const insets = { top: 72, bottom: 64 };
  assert.deepEqual(mobileEditorPanDelta({ left: 90, right: 330, top: 20, bottom: 520 }, viewport, insets), { x: 0, y: 64 });
  assert.deepEqual(mobileEditorPanDelta({ left: 90, right: 330, top: 84, bottom: 584 }, viewport, insets), { x: 0, y: 0 });
});

test('keyboard height limits never grow canonical card geometry but natural text overflow still does', () => {
  const editor = { clientHeight: 100, scrollHeight: 300, dataset: {} };
  assert.equal(editorContentOverflowPx(editor), 200);
  editor.dataset.mobileHeightBounded = 'true';
  assert.equal(editorContentOverflowPx(editor), 0);
});

test('viewport width limits never grow canonical card geometry from temporary text wrapping', () => {
  const editor = { clientHeight: 100, scrollHeight: 300, dataset: { mobileWidthBounded: 'true' } };
  assert.equal(editorContentOverflowPx(editor), 0);
  delete editor.dataset.mobileWidthBounded;
  assert.equal(editorContentOverflowPx(editor), 200);
});

test('mobile input bounds include native textarea padding and borders for every card type', () => {
  const css = readFileSync(new URL('./mobile-editing.css', import.meta.url), 'utf8');
  assert.match(css, /\.rb-mobile-editor__input\s*\{[^}]*box-sizing:\s*border-box\s*;/);
});

test('editing a card too small to read zooms in around it and keeps it inside the free area', () => {
  const visible = { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 };
  const insets = { left: 72, top: 72, bottom: 64 };
  const viewport = { x: 10, y: 20, zoom: 0.12 };
  const editor = { left: 150, right: 174, top: 400, bottom: 421 };
  const next = mobileEditorFocusViewport({ editor, visible, insets, viewport, origin: { left: 0, top: 0 } });
  const scale = next.zoom / viewport.zoom;
  const screenX = (x) => (x - viewport.x) * scale + next.x;
  const screenY = (y) => (y - viewport.y) * scale + next.y;
  const width = screenX(editor.right) - screenX(editor.left);
  assert.ok(width >= MOBILE_EDITOR_MIN_READABLE_WIDTH_PX, `width ${width}`);
  assert.ok(screenX(editor.left) >= insets.left && screenX(editor.right) <= visible.right);
  assert.ok(screenY(editor.top) >= insets.top && screenY(editor.bottom) <= visible.bottom - insets.bottom);
  const readable = { left: 100, right: 100 + MOBILE_EDITOR_MIN_READABLE_WIDTH_PX, top: 200, bottom: 380 };
  assert.equal(mobileEditorFocusViewport({ editor: readable, visible, insets, viewport, origin: { left: 0, top: 0 } }), null);
  const nearMax = { ...viewport, zoom: VIEWPORT_ZOOM_MAX };
  assert.equal(mobileEditorFocusViewport({ editor, visible, insets, viewport: nearMax, origin: { left: 0, top: 0 } }), null);
});

test('a card that grew past the free width after zooming is zoomed back out to fit', () => {
  const visible = { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 };
  const insets = { left: 84, top: 68, bottom: 52 };
  const viewport = { x: 0, y: 0, zoom: 2.56 };
  const editor = { left: 62, right: 369, top: 284, bottom: 560 };
  assert.equal(mobileEditorFocusViewport({ editor, visible, insets, viewport, origin: { left: 0, top: 0 } }), null);
  const next = mobileEditorFocusViewport({ editor, visible, insets, viewport, origin: { left: 0, top: 0 }, fitWide: true });
  const scale = next.zoom / viewport.zoom;
  assert.ok(scale < 1);
  const left = (editor.left - viewport.x) * scale + next.x;
  const right = (editor.right - viewport.x) * scale + next.x;
  assert.ok(left >= insets.left && right <= visible.right, `${left}..${right}`);
});
