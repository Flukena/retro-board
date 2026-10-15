import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('collaborative editor preserves controlled input/textarea values and forwarded attributes', async () => {
  await withChromeModule('/src/CollaborativeTextEditor.jsx', ({ CollaborativeTextEditor }) => {
    const props = { value: 'a<&b', onValueChange: () => {}, maxLength: 120, 'aria-label': 'Editor' };
    const input = renderToStaticMarkup(React.createElement(CollaborativeTextEditor, { ...props, kind: 'input' }));
    const textarea = renderToStaticMarkup(React.createElement(CollaborativeTextEditor, props));
    assert.match(input, /<input[^>]*value="a&lt;&amp;b"/);
    assert.match(textarea, /<textarea[^>]*>a&lt;&amp;b<\/textarea>/);
    for (const html of [input, textarea]) {
      assert.match(html, /maxLength="120"/);
      assert.match(html, /aria-label="Editor"/);
    }
  });
});
