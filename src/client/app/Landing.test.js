import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

const renderLanding = (Landing) => renderToStaticMarkup(React.createElement(Landing));

test('first-time visitors see no empty recent-rooms card and no scroll cue', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ default: Landing }, { setLang }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderLanding(Landing);
      assert.doesNotMatch(html, /id="landing-recents"/);
      assert.doesNotMatch(html, /href="#landing-recents"/);
    }
  });
});

test('the hero offers one primary Create, format chips that start a room, and trust chips', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ default: Landing }, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderLanding(Landing);
      const hero = html.slice(html.indexOf('rb-landing__hero-layout'), html.indexOf('rb-landing__public-bar'));
      assert.equal((hero.match(/rb-btn--primary/g) || []).length, 1, `${lang}: Create is the only primary action`);
      for (const name of ['Retro Loop', 'Start Stop Continue', 'Mad Sad Glad', '4Ls']) {
        assert.ok(hero.includes(`aria-label="${t('tpl.start', { name })}"`), `${lang}: ${name} chip`);
      }
      for (const key of ['landing.trust.free', 'landing.trust.signup', 'landing.trust.realtime']) assert.ok(hero.includes(t(key)));
      assert.ok(hero.includes(t('landing.join.or')));
    }
  });
});

test('the masthead sits inside the scrolling hero instead of floating over it', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ default: Landing }, { setLang, t }) => {
    setLang('en');
    const html = renderLanding(Landing);
    assert.match(html, /<section class="rb-landing__hero"[^>]*>[\s\S]*<header class="rb-landing__masthead">/);
    assert.ok(html.includes(`>${t('app.title')}<`));
  });
  const css = readFileSync(new URL('./landing.css', import.meta.url), 'utf8');
  const rule = css.slice(css.indexOf('.rb-landing__masthead {'), css.indexOf('}', css.indexOf('.rb-landing__masthead {')));
  assert.doesNotMatch(rule, /position:\s*(absolute|fixed)/);
});

test('the brand is RetroRoom in both languages', async () => {
  const { setLang, t } = await import('../ui/i18n.js');
  for (const lang of ['th', 'en']) {
    setLang(lang);
    assert.equal(t('app.title'), 'RetroRoom');
  }
  assert.doesNotMatch(readFileSync(new URL('../ui/i18n.js', import.meta.url), 'utf8'), /Retro Board/);
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
  await withChromeModule('/src/client/app/Landing.jsx', ({ JoinRow }) => {
    let joins = 0;
    const card = JoinRow({ joinCode: ' room-code ', onCodeChange: () => {}, onJoin: () => { joins += 1; } });
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

test('the Planning Poker lead card sits in a plain column, not inside a framed feature tile', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ default: Landing }, { setLang }) => {
    setLang('en');
    const html = renderLanding(Landing);
    assert.match(html, /<div class="rb-landing__poker"><section class="rb-poker-feature"/);
    const tileWrapsPoker = /<div class="rb-landing__feature">\s*<section class="rb-poker-feature"/;
    assert.doesNotMatch(html, tileWrapsPoker);
  });
});
