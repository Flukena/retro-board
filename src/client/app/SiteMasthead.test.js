import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';

test('a product top bar links its brand home, lists its in-page links, keeps an extra action and the language/theme controls', async () => {
  await withChromeModule('/src/client/app/SiteMasthead.jsx', ({ default: SiteMasthead }, { setLang, t }) => {
    const Icon = () => React.createElement('svg', { 'data-brand': 'yes' });
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(SiteMasthead, {
        homeHref: '/planning-poker',
        BrandIcon: Icon,
        titleKey: 'poker.title',
        links: [{ href: '#how', labelKey: 'pokerPage.section.how' }],
        action: React.createElement('a', { href: '/', id: 'extra-action' }, 'retro'),
      }));
      assert.match(html, /<a class="rb-landing__identity" href="\/planning-poker">/);
      assert.match(html, /data-brand="yes"/);
      assert.ok(html.includes(`<a href="#how">${t('pokerPage.section.how')}</a>`));
      assert.match(html, /id="extra-action"/);
      assert.match(html, /<select class="rb-lang-picker__select"/);
      assert.ok(html.includes(`aria-label="${t('settings.theme')}`));
    }
  });
});
