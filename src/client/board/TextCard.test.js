import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('text card preserves geometry, text, selection and editor in both languages', async () => {
  await withChromeModule('/src/client/board/TextCard.jsx', ({ TextCard }, { setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const props = { item: { id: 'text', x: 10, y: 20, text: 'Text ภาษาไทย' }, lang };
      const html = renderToStaticMarkup(React.createElement(TextCard, { ...props, selected: true }));
      assert.match(html, /width:400px;height:80px/);
      assert.match(html, /font-family:var\(--font-handwriting\)/);
      assert.match(html, /outline:2px dashed #2563eb/);
      assert.match(html, /Text ภาษาไทย/);
      const editing = renderToStaticMarkup(React.createElement(TextCard, { ...props, isEditing: true }));
      assert.match(editing, /<textarea/);
      assert.match(editing, /Text ภาษาไทย/);
    }
  });
});

test('a text item too large to animate safely mounts without the appear pop', async () => {
  await withChromeModule('/src/client/board/TextCard.jsx', ({ TextCard }) => {
    const item = { id: 'text', x: 0, y: 0, text: 'Heading' };
    assert.match(renderToStaticMarkup(React.createElement(TextCard, { item })), /animation:rb-appear/);
    const huge = renderToStaticMarkup(React.createElement(TextCard, { item: { ...item, w: 9_000, h: 3_000 } }));
    assert.doesNotMatch(huge, /animation:/);
  });
});
