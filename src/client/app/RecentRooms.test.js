import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('recent row labels removal in both languages and forwards its code and token', async () => {
  await withChromeModule('/src/client/app/RecentRooms.jsx', ({ RecentRow }, { getLang, setLang, t }) => {
    const originalLang = getLang();
    const recent = { code: 'abc', token: 'secret_1', name: 'Sprint', visitedAt: 0 };
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        const calls = [];
        const row = RecentRow({ recent, onRemove: (...args) => calls.push(args) });
        const html = renderToStaticMarkup(row);
        const label = t('landing.recents.remove');
        assert.ok(html.includes(`aria-label="${label}"`));
        assert.ok(html.includes(`title="${label}"`));
        assert.match(html, /rb-icon-btn/);
        assert.doesNotMatch(html, /landing\./);
        row.props.children.at(-1).props.onClick();
        assert.deepEqual(calls, [[recent.code, recent.token]]);
      }
    } finally {
      setLang(originalLang);
    }
  });
});

test('a poker recent is labelled as Planning Poker and reopens at its /p/ link', async () => {
  await withChromeModule('/src/client/app/RecentRooms.jsx', ({ RecentRow }, { t }) => {
    const originalWindow = globalThis.window;
    const poker = { code: 'abc', token: 'secret_1', name: '', visitedAt: 0, kind: 'poker' };
    const board = { ...poker, kind: 'board' };
    try {
      globalThis.window = { location: { href: '' } };
      const pokerRow = RecentRow({ recent: poker, onRemove: () => {} });
      assert.ok(renderToStaticMarkup(pokerRow).includes(t('poker.title')));
      assert.ok(!renderToStaticMarkup(RecentRow({ recent: board, onRemove: () => {} })).includes(t('poker.title')));
      pokerRow.props.children[0].props.onClick();
      assert.match(globalThis.window.location.href, /^\/p\/abc/);
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

test('the recent rooms card is a region named by its own heading, so two pages can each have one', async () => {
  await withChromeModule('/src/client/app/RecentRooms.jsx', ({ default: RecentRooms }, { t }) => {
    const recents = [{ code: 'abc', token: 'secret_1', name: 'Sprint', visitedAt: 0, kind: 'board' }];
    const html = renderToStaticMarkup(React.createElement(RecentRooms, { id: 'poker-recents', recents, onRemove: () => {} }));
    assert.match(html, /id="poker-recents"/);
    assert.match(html, /aria-labelledby="poker-recents-title"/);
    assert.match(html, new RegExp(`<h2 id="poker-recents-title"[^>]*>${t('landing.recents.head')}</h2>`));
    assert.ok(html.includes('Sprint'));
  });
});
