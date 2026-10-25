import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('landing exposes the recent-room destination and localized empty state before any rooms exist', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ default: Landing }, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(Landing));
      assert.match(html, /id="landing-recents"/);
      assert.match(html, /href="#landing-recents"/);
      assert.ok(html.includes(t('landing.recents.empty')));
      assert.ok(html.includes(t('landing.recents.scroll')));
      assert.doesNotMatch(html, /landing\.recents\./);
    }
  });
});

test('landing uses primary create, disabled empty join and display-font hero in both languages', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ default: Landing }, { getLang, setLang, t }) => {
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
  await withChromeModule('/src/client/app/Landing.jsx', ({ RecentRow }, { getLang, setLang, t }) => {
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


test('landing CSS matches design C surfaces, filled inputs and top column', () => {
  const css = readFileSync(new URL('./landing.css', import.meta.url), 'utf8');
  const contracts = {
    '.rb-landing__page': ['align-items: flex-start', 'padding: var(--landing-page-padding)'],
    '.rb-landing__content': ['max-width: var(--landing-max-width)', 'flex-direction: column', 'gap: var(--landing-gap)'],
    '.rb-landing__brand': ['background: var(--brand-tile-bg)', 'color: var(--brand-tile-fg)', 'width: var(--landing-logo-size)', 'border-radius: var(--radius-lg)'],
    '.rb-landing__page .rb-landing__card': ['border-radius: var(--radius-xl)', 'box-shadow: var(--shadow-card)', 'background: var(--bg-panel)'],
    '.rb-input.rb-landing__input': ['background: var(--bg-panel-2)', 'border: var(--landing-line-width) solid var(--border)', 'border-radius: var(--radius-md)', 'min-width: 0'],
    '.rb-landing__page .rb-landing__action:not(.rb-btn--primary):not(:disabled)': ['color: var(--text)'],
  };
  for (const [selector, declarations] of Object.entries(contracts)) {
    const start = css.indexOf(selector + ' {');
    assert.ok(start >= 0, selector);
    const rule = css.slice(start, css.indexOf('}', start));
    for (const declaration of declarations) assert.ok(rule.includes(declaration), selector + ': ' + declaration);
  }
});

test('Join is secondary, enabled for text, and forwards click and Enter', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ JoinCard }) => {
    let joins = 0;
    const card = JoinCard({ joinCode: ' room-code ', onCodeChange: () => {}, onJoin: () => { joins += 1; } });
    const html = renderToStaticMarkup(card);
    assert.doesNotMatch(html, /disabled=""|rb-btn--primary/);
    assert.match(html, /class="rb-btn rb-landing__action"/);
    const [input, button] = card.props.children.at(-1).props.children;
    button.props.onClick();
    input.props.onKeyDown({ key: 'Enter' });
    input.props.onKeyDown({ key: 'Escape' });
    assert.equal(joins, 2);
  });
});
