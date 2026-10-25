import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMobileEditorViewport, mobileEditorHeightLimitPx, mobileEditorInsets } from './mobile-editor-viewport.js';
import { MOBILE_EDITOR_VISIBILITY_EVENT } from './mobile-editing.js';

const VISIBLE_VIEWPORT = { left: 0, top: 24, right: 390, bottom: 364, width: 390, height: 340 };
const HEIGHT_LIMIT_PROPERTY = '--rb-inline-editor-max-height-px';

function fixture(heightPx = 160, zoom = 1, widthPx = 240) {
  const view = new EventTarget();
  const properties = new Map();
  const position = { left: 20, top: 300 };
  const editor = {
    dataset: {}, matches: () => true,
    style: { setProperty: (key, value) => properties.set(key, value), removeProperty: (key) => properties.delete(key) },
    getBoundingClientRect: () => {
      const height = Math.min(heightPx, parseFloat(properties.get(HEIGHT_LIMIT_PROPERTY) ?? Infinity) * zoom);
      const width = Math.min(widthPx, parseFloat(properties.get('--rb-inline-editor-max-width-px') ?? Infinity) * zoom);
      return { ...position, width, height, right: position.left + width, bottom: position.top + height };
    },
  };
  const controls = {
    '.rb-topbar': { width: 374, height: 62, bottom: 70 },
    '.rb-tool-dock': { width: 76, height: 280, right: 84 },
  };
  const root = {
    ownerDocument: { defaultView: view, activeElement: editor }, contains: (node) => node === editor,
    querySelector: (selector) => ({ getBoundingClientRect: () => controls[selector] }),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  let viewport = { x: 0, y: 0, zoom };
  const commits = [];
  const dispose = attachMobileEditorViewport(root, {
    getViewport: () => viewport,
    commitViewport: (next) => {
      position.left += next.x - viewport.x;
      position.top += next.y - viewport.y;
      viewport = next;
      commits.push(next);
    },
  });
  const dispatch = (type) => {
    const event = new Event(type);
    Object.defineProperties(event, { target: { value: editor }, detail: { value: { viewportRect: VISIBLE_VIEWPORT } } });
    view.dispatchEvent(event);
  };
  return { root, editor, properties, commits, dispose, dispatch };
}

test('keyboard reveal measures the actual header and left rail and reserves nothing at the bottom', () => {
  const f = fixture();
  assert.deepEqual(mobileEditorInsets(f.root, VISIBLE_VIEWPORT), { left: 84, top: 46, bottom: 0 });
  assert.equal(mobileEditorHeightLimitPx(VISIBLE_VIEWPORT, { top: 46, bottom: 52 }, 2), 109);
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  assert.deepEqual(f.commits, [{ x: 76, y: -108, zoom: 1 }]);
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  assert.equal(f.commits.length, 1, 'Already visible input must not move the board again');
  f.dispose();
});

test('a tall inline editor is bounded in world pixels and released on blur without item writes', () => {
  const f = fixture(600, 2);
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  assert.equal(f.properties.get(HEIGHT_LIMIT_PROPERTY), '135px');
  assert.equal(f.editor.dataset.mobileHeightBounded, 'true');
  const rect = f.editor.getBoundingClientRect();
  assert.ok(rect.top >= 82 && rect.bottom <= 352, 'Input must fit above the keyboard');
  f.dispatch('focusout');
  assert.equal(f.properties.has(HEIGHT_LIMIT_PROPERTY), false);
  assert.equal(f.editor.dataset.mobileHeightBounded, undefined);
  f.dispose();
});

test('unfocused editors do not pan and teardown removes listeners and temporary bounds', () => {
  const f = fixture(600);
  f.root.ownerDocument.activeElement = null;
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  assert.equal(f.commits.length, 0);
  f.root.ownerDocument.activeElement = f.editor;
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  assert.equal(f.editor.dataset.mobileHeightBounded, 'true');
  f.dispose();
  assert.equal(f.properties.size, 0);
  assert.equal(f.editor.dataset.mobileHeightBounded, undefined);
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  assert.equal(f.properties.size, 0);
});

test('zoomed inline text wraps within the visible canvas width without changing card geometry', () => {
  const f = fixture(160, 2, 600);
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  assert.equal(f.properties.get('--rb-inline-editor-max-width-px'), '141px');
  assert.equal(f.editor.dataset.mobileWidthBounded, 'true');
  const rect = f.editor.getBoundingClientRect();
  assert.ok(rect.left >= 96 && rect.right <= 378);
  f.dispose();
  assert.equal(f.properties.size, 0);
  assert.equal(f.editor.dataset.mobileWidthBounded, undefined);
});

test('editing a card too small to read zooms in once instead of panning a tiny editor', () => {
  const f = fixture(20, 0.12, 24);
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  assert.equal(f.commits.length, 1);
  assert.ok(f.commits[0].zoom > 0.12, `zoom ${f.commits[0].zoom}`);
  assert.equal(f.properties.size, 0, 'Size limits wait for the next reveal at the new zoom');
  f.dispose();
});

test('focus zoom sizes the whole sticky, not the narrow empty input inside it', () => {
  const f = fixture(20, 0.12, 4);
  const card = { getBoundingClientRect: () => ({ left: 20, top: 300, right: 44, bottom: 321, width: 24, height: 21 }) };
  f.editor.closest = (selector) => (selector === '[data-sticky-id]' ? card : null);
  f.dispatch(MOBILE_EDITOR_VISIBILITY_EVENT);
  const scale = f.commits[0].zoom / 0.12;
  assert.ok(24 * scale <= VISIBLE_VIEWPORT.width - 84, `card width ${24 * scale}`);
  f.dispose();
});
