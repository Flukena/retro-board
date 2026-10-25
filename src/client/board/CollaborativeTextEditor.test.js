import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('collaborative editor preserves controlled input/textarea values and forwarded attributes', async () => {
  await withChromeModule('/src/client/board/CollaborativeTextEditor.jsx', ({ CollaborativeTextEditor }) => {
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

test('mobile text editing stays in its card with the original style and no modal surface', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    matchMedia: () => ({ matches: true }),
    visualViewport: { height: 310, offsetTop: 40 },
  } });
  try {
    await withChromeModule('/src/client/board/CollaborativeTextEditor.jsx', ({ CollaborativeTextEditor }) => {
      const html = renderToStaticMarkup(React.createElement(CollaborativeTextEditor, {
        value: 'Edit directly on this card', onValueChange: () => {},
        className: 'card-inline-editor', style: { fontSize: 29 },
      }));
      assert.match(html, /^<textarea/);
      assert.match(html, /card-inline-editor/);
      assert.match(html, /font-size:29px/);
      assert.doesNotMatch(html, /<section|rb-mobile-editor__sheet/);
    });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
});
