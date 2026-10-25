import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mobileEditableField, mobileViewportStyle, mobileEditorPanDelta, editorContentOverflowPx } from './mobile-editing.js';

test('mobile editing selects text or zone title and excludes non-text items', () => {
  assert.equal(mobileEditableField({ type: 'sticky' }), 'text');
  assert.equal(mobileEditableField({ type: 'text' }), 'text');
  assert.equal(mobileEditableField({ type: 'zone' }), 'title');
  assert.equal(mobileEditableField({ type: 'image' }), null);
  assert.equal(mobileEditableField(null), null);
});

test('compact Done control follows the visible viewport above an open keyboard', () => {
  assert.deepEqual(mobileViewportStyle({ height: 310, offsetTop: 40 }, 844), {
    '--rb-mobile-keyboard-bottom-px': '494px',
  });
  assert.deepEqual(mobileViewportStyle(null), {});
});

test('mobile edit control clears the reserved tool rail independently of the bottom inset', () => {
  const css = readFileSync(new URL('./mobile-editing.css', import.meta.url), 'utf8');
  const mobileRule = css.slice(css.indexOf('@media'));
  assert.match(mobileRule, /left:\s*var\(--rb-mobile-canvas-left-px\)/);
});

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
