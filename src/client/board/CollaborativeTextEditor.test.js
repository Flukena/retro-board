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

test('mobile edit action requires an editable selection and yields to the active editor', async () => {
  await withChromeModule('/src/client/board/MobileEditingControls.jsx', ({ MobileEditingControls }) => {
    const props = { item: { type: 'sticky' }, editingAllowed: true, onBeginFocus: () => {} };
    const render = (changes) => renderToStaticMarkup(React.createElement(MobileEditingControls, { ...props, ...changes }));
    assert.match(render({}), /<button[^>]*type="button"/);
    assert.equal(render({ editingAllowed: false }), '');
    assert.equal(render({ isEditing: true }), '');
    assert.equal(render({ item: { type: 'image' } }), '');
    assert.equal(render({ item: null }), '');
  });
});

test('mobile edit action opens the selected item field without mutating the item', async () => {
  await withChromeModule('/src/client/board/MobileEditingControls.jsx', ({ MobileEditingControls }) => {
    for (const [type, expectedField] of [['zone', 'title'], ['sticky', 'text'], ['text', 'text']]) {
      const item = Object.freeze({ id: `selected-${type}`, type });
      const calls = [];
      const control = MobileEditingControls({
        item,
        editingAllowed: true,
        onBeginFocus: (...args) => calls.push(args),
      });
      assert.deepEqual(calls, []);
      control.props.onClick();
      assert.deepEqual(calls, [[item, expectedField]]);
      assert.equal(calls[0][0], item);
    }
  });
});

test('active mobile editing exposes a compact Done button without a modal wrapper', async () => {
  await withChromeModule('/src/client/board/MobileEditingControls.jsx', ({ MobileEditingControls }) => {
    const html = renderToStaticMarkup(React.createElement(MobileEditingControls, {
      editingAllowed: true, isEditing: true, editorRef: { current: null },
    }));
    assert.match(html, /^<button[^>]*class="rb-mobile-editor__done"/);
    assert.doesNotMatch(html, /<section|<textarea|<div/);
  });
});
