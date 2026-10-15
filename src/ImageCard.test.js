import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('image card rejects unsafe sources and preserves selection, fallback size and dense mode', async () => {
  await withChromeModule('/src/ImageCard.jsx', ({ ImageCard }) => {
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
