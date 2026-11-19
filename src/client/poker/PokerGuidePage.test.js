import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { localizedPath } from '../seo/seo-pages.js';

test('the Planning Poker home stands on its own: its brand, a way back to the retro board, one h1 and in-page links that land on its sections', async () => {
  await withChromeModule('/src/client/poker/PokerGuidePage.jsx', ({ default: PokerGuidePage }, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const html = renderToStaticMarkup(React.createElement(PokerGuidePage));
      assert.ok(html.includes(`<a class="rb-landing__identity" href="${localizedPath('/planning-poker', lang)}">`));
      assert.ok(html.includes(`<span class="rb-landing__wordmark">${t('poker.title')}</span>`));
      const retro = html.match(/<a class="[^"]*rb-poker-home__retro"[^>]*>/)?.[0];
      assert.ok(retro, 'retro board link is in the top bar');
      assert.ok(retro.includes(`href="${localizedPath('/', lang)}"`));
      assert.ok(retro.includes(`aria-label="${t('pokerPage.retroLink')}"`));
      assert.equal(html.match(/<h1\b/g)?.length, 1);
      assert.doesNotMatch(html, /class="rb-legal__home"/, 'no generic back-to-home bar');
      for (const [, target] of html.matchAll(/<a href="#([^"]+)">/g)) {
        assert.match(html, new RegExp(`id="${target}"`), `nav link #${target} has a section`);
      }
    }
  });
});
