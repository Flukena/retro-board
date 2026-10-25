import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('image card rejects unsafe sources and preserves selection, fallback size and dense mode', async () => {
  await withChromeModule('/src/client/board/ImageCard.jsx', ({ ImageCard }) => {
    const props = { item: { x: 1, y: 2, src: 'javascript:alert(1)' }, selected: true };
    const html = renderToStaticMarkup(React.createElement(ImageCard, props));
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /width:200px;height:200px/);
    assert.match(html, /outline:2px solid #2563eb/);
    assert.match(html, /filter:var\(--image-card-filter\)/);
    const dense = renderToStaticMarkup(React.createElement(ImageCard, { ...props, dense: true }));
    assert.match(dense, /filter:none/);
    assert.doesNotMatch(dense, /animation:/);
  });
});

test('readonly public preview images use only canonical public routes and load eagerly during SSR', async () => {
  await withChromeModule('/src/client/board/ImageCard.jsx', ({ ImageCard }) => {
    const path = `/yjs-public/rooms/${'a'.repeat(32)}/images/01234567-abcd.png`;
    const item = { x: 1, y: 2, src: path };
    const preview = renderToStaticMarkup(React.createElement(ImageCard, { item, publicPreview: true }));
    assert.ok(preview.includes(`src="${path}"`));
    assert.match(preview, /loading="eager"/);
    const normal = renderToStaticMarkup(React.createElement(ImageCard, { item }));
    assert.doesNotMatch(normal, /<img/);
    for (const src of ['data:image/png;base64,aGVsbG8=', '/yjs/rooms/' + 'a'.repeat(32) + '/images/01234567-abcd.png']) {
      const invalid = renderToStaticMarkup(React.createElement(ImageCard, { item: { ...item, src }, publicPreview: true }));
      assert.doesNotMatch(invalid, /<img/);
    }
  });
});


test('image cache follows projected viewport area without promoting large images or previews', async () => {
  await withChromeModule('/src/client/board/ImageCard.jsx', ({ ImageCard }) => {
    const props = { item: { x: 0, y: 0, w: 940, h: 1670 }, zoom: 1, viewportSize: { w: 1440, h: 900 } };
    const render = overrides => renderToStaticMarkup(React.createElement(ImageCard, { ...props, ...overrides }));
    assert.doesNotMatch(render({}), /will-change:/);
    assert.match(render({ zoom: 0.1 }), /will-change:transform/);
    for (const flag of ['dense', 'remoteSelected', 'publicPreview']) {
      assert.doesNotMatch(render({ zoom: 0.1, [flag]: true }), /will-change:/);
    }
  });
});
