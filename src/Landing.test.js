import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from './chrome-test-helper.js';

test('landing uses primary create, disabled empty join and display-font hero in both languages', async () => {
  await withChromeModule('/src/Landing.jsx', ({ default: Landing }, { getLang, setLang, t }) => {
    const originalLang = getLang();
    try {
      for (const language of ['th', 'en']) {
        setLang(language);
        const html = renderToStaticMarkup(React.createElement(Landing));
        const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g);
        const create = buttons.find((button) => button.includes(t('landing.create.btn')));
        const join = buttons.find((button) => button.includes(t('landing.join.btn')));
        assert.match(create, /class="[^"]*rb-btn--primary/);
        assert.doesNotMatch(create, /disabled=""/);
        assert.match(join, /disabled=""/);
        assert.match(html, /class="rb-landing__title"/);
        assert.ok(html.includes(t('app.title')));
        assert.ok(html.includes(t('landing.create.head')));
        assert.ok(html.includes(t('landing.join.head')));
        assert.doesNotMatch(html, /landing\./);
        const themeTitle = `${t('settings.theme')}: ${t('settings.theme.auto')}`;
        assert.ok(buttons.some((button) => button.includes(`title="${themeTitle}"`)
          && button.includes(`aria-label="${themeTitle}"`) && button.includes('rb-btn--pill')));
      }
    } finally {
      setLang(originalLang);
    }
  });
});

test('recent row labels removal in both languages and forwards its code and token', async () => {
  await withChromeModule('/src/Landing.jsx', ({ RecentRow }, { getLang, setLang, t }) => {
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
