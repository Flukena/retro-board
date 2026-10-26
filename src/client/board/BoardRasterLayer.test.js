import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('paint groups preserve card identity when entering selection, remote selection or editing', async () => {
  await withChromeModule('/src/client/board/BoardRasterLayer.jsx', ({ BoardRasterLayer }) => {
    const item = { id: 'a', type: 'sticky', x: 0, y: 0 };
    const child = React.createElement('span', { key: item.id, item }, 'Native card');
    const props = { items: [item], children: [child], compact: true, dense: true, selectedIds: new Set(), remoteSelectors: new Map(), focusedTextId: null, contexts: new Map(), winners: new Map() };
    const render = change => {
      let result;
      function Inspect() { result = BoardRasterLayer({ ...props, ...change }); return result; }
      renderToStaticMarkup(React.createElement(Inspect));
      return result;
    };
    const group = render({})[0];
    assert.equal(group.key, item.id);
    for (const change of [{ compact: false }, { dense: false }, { selectedIds: new Set(['a']) }, { remoteSelectors: new Map([['a', {}]]) }, { focusedTextId: 'a:text' }]) {
      const next = render(change)[0];
      assert.equal(next.type, group.type, 'Changing interaction must not remount the card subtree');
      assert.equal(next.key, item.id);
      assert.equal(next.props.children[0], child);
    }
  });
});

const CARD_COUNT = 64;
const COLUMN_COUNT = 8;
const COLUMN_STEP_WORLD_PX = 330;
const ROW_STEP_WORLD_PX = 280;
const cards = () => Array.from({ length: CARD_COUNT }, (_, index) => ({
  id: `note-${index}`, type: 'sticky', x: index % COLUMN_COUNT * COLUMN_STEP_WORLD_PX,
  y: Math.floor(index / COLUMN_COUNT) * ROW_STEP_WORLD_PX, w: 280, h: 240, text: `Note ${index}`,
}));
function FixtureCard({ item }) {
  return React.createElement('div', { 'data-card-id': item.id }, item.text);
}
function renderLayer(Component, items, overrides = {}) {
  const props = { items, dense: true, compact: false, selectedIds: new Set(), remoteSelectors: new Map(),
    focusedTextId: null, contexts: new Map(), winners: new Map(), allRevealed: false, userId: 'viewer',
    detailedIds: new Set([items[0].id]), ...overrides };
  return renderToStaticMarkup(React.createElement(Component, props,
    items.map(item => React.createElement(FixtureCard, { key: item.id, item }))));
}
test('detail and overview views retain the same bounded text atlas without losing native children', async () => {
  await withChromeModule('/src/client/board/BoardRasterLayer.jsx', ({ BoardRasterLayer }) => {
    const items = cards();
    for (const compact of [false, true]) {
      const html = renderLayer(BoardRasterLayer, items, { compact });
      assert.match(html, /<canvas[^>]*class="rb-overview-atlas"[^>]*aria-hidden="true"/);
      assert.equal((html.match(/data-card-id=/g) || []).length, CARD_COUNT);
      assert.ok(html.indexOf('data-card-id="note-0"') < html.indexOf('data-card-id="note-63"'));
    }
  });
});
test('native editing, remote selection and non-dense boards preserve their existing fallback', async () => {
  await withChromeModule('/src/client/board/BoardRasterLayer.jsx', ({ BoardRasterLayer }) => {
    for (const overrides of [{ dense: false }, { detailedIds: null, compact: false }, { detailedIds: undefined, compact: false }, { selectedIds: new Set(['note-0']) },
      { remoteSelectors: new Map([['note-0', {}]]) }, { focusedTextId: 'note-0:text' }]) {
      assert.doesNotMatch(renderLayer(BoardRasterLayer, cards(), overrides), /<canvas/);
    }
  });
});


test('large-board overview keeps its bounded atlas while native detail fallback never overlays cached text', async () => {
  await withChromeModule('/src/client/board/BoardRasterLayer.jsx', ({ BoardRasterLayer }) => {
    assert.match(renderLayer(BoardRasterLayer, cards(), { detailedIds: null, compact: true }), /<canvas/);
    assert.doesNotMatch(renderLayer(BoardRasterLayer, cards(), { detailedIds: null, compact: false }), /<canvas/);
  });
});

test('WebKit shows the overview atlas as an image so nothing in the zoomed world becomes a composited layer', async () => {
  await withChromeModule('/src/client/board/BoardRasterLayer.jsx', ({ BoardRasterLayer }) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'GestureEvent');
    globalThis.GestureEvent = class {};
    try {
      const html = renderLayer(BoardRasterLayer, cards(), { detailedIds: null, compact: true });
      assert.doesNotMatch(html, /<canvas/);
      assert.match(html, /<img[^>]*class="rb-overview-atlas"[^>]*aria-hidden="true"/);
      assert.equal((html.match(/data-card-id=/g) || []).length, CARD_COUNT);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'GestureEvent', previous);
      else delete globalThis.GestureEvent;
    }
  });
});
