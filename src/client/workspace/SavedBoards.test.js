import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('shared cards expose the invite and remove-star action without owner controls', async () => {
  const room = { code: 'shared', kind: 'board', title: 'Shared sprint', link: '/b/shared#invitation', locked: false };
  await withChromeModule('/src/client/workspace/SavedBoards.jsx', ({ SavedBoardCard }, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(SavedBoardCard, { room }));
      assert.ok(html.includes(`href="${room.link}"`));
      assert.ok(html.includes(t('savedBoards.removeNamed', { name: room.title })));
      assert.doesNotMatch(html, /aria-haspopup="menu"|role="menuitem"/);
    }
  });
});
