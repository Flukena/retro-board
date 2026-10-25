import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { LEGAL_PAGE, LEGAL_PATH, legalSections } from './legal-content.js';

test('legal pages render every translated section, the effective date and a link to the other page', async () => {
  await withChromeModule('/src/client/legal/LegalPage.jsx', ({ default: LegalPage }, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      for (const page of Object.values(LEGAL_PAGE)) {
        const html = renderToStaticMarkup(React.createElement(LegalPage, { page }));
        assert.match(html, /<h1 id="legal-title"/);
        assert.ok(html.includes(t(`legal.${page}.title`)));
        assert.match(html, /\d{4}-\d{2}-\d{2}/);
        for (const section of legalSections(page)) assert.ok(html.includes(t(section.titleKey)), section.titleKey);
        assert.doesNotMatch(html, /legal\.[a-z]+\./);
        const other = page === LEGAL_PAGE.PRIVACY ? LEGAL_PAGE.TERMS : LEGAL_PAGE.PRIVACY;
        assert.ok(html.includes(`href="${LEGAL_PATH[other]}"`));
        assert.match(html, /href="\/"/);
        assert.ok(html.includes(`>${t(`settings.lang.${lang}`)}</button>`), 'language pill shows the current language');
      }
    }
  });
});

test('landing footer links to both legal pages and the sitemap lists them', async () => {
  await withChromeModule('/src/client/app/Landing.jsx', ({ default: Landing }, { setLang }) => {
    setLang('en');
    const html = renderToStaticMarkup(React.createElement(Landing));
    for (const path of Object.values(LEGAL_PATH)) assert.ok(html.includes(`href="${path}"`), path);
  });
  const sitemap = readFileSync(new URL('../../../public/sitemap.xml', import.meta.url), 'utf8');
  for (const path of Object.values(LEGAL_PATH)) assert.ok(sitemap.includes(`<loc>https://retroroom.party${path}</loc>`), path);
});
