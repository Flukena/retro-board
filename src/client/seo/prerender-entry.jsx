import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLang, t } from '../ui/i18n.js';
import { TOKENS } from '../ui/theme.js';
import Landing from '../app/Landing.jsx';
import LegalPage from '../legal/LegalPage.jsx';
import TemplatePage from '../templates/TemplatePage.jsx';
import NotFoundPage from '../app/NotFoundPage.jsx';
import PokerGuidePage from '../poker/PokerGuidePage.jsx';
import AgileGuidePage from '../guide/AgileGuidePage.jsx';
import {
  DEFAULT_SEO_LANG, NOT_FOUND_TITLE_KEY, SEO_LANGS, SEO_PAGES, SEO_PAGE_KIND, SOCIAL_IMAGE,
  canonicalUrl, localizedPath, pageAlternates,
} from './seo-pages.js';
import { ROBOTS_NOINDEX, themeTokenCss } from './page-document.js';
import { AGILE_GUIDE_DATES, AGILE_GUIDE_TOPICS, articleStructuredData } from './structured-data.js';
import { AGILE_SOURCE_URL } from '../guide/agile-guide-content.js';

// Build-time entry (vite build --ssr): renders every public page once per app
// language (English at the root, the others under /<code>). The not-found page and the
// board shell are English only and never indexed.

const VIEWS = Object.freeze({
  [SEO_PAGE_KIND.LANDING]: () => <Landing />,
  [SEO_PAGE_KIND.TEMPLATE]: (page) => <TemplatePage slug={page.slug} />,
  [SEO_PAGE_KIND.LEGAL]: (page) => <LegalPage page={page.legalPage} />,
  [SEO_PAGE_KIND.TOOL]: () => <PokerGuidePage />,
  [SEO_PAGE_KIND.GUIDE]: () => <AgileGuidePage />,
});

// Pages that describe themselves to search engines as schema.org data.
const STRUCTURED_DATA = Object.freeze({
  [SEO_PAGE_KIND.GUIDE]: ({ lang, url, imageUrl }) => articleStructuredData({
    lang, url, imageUrl, siteUrl: canonicalUrl('/'), headline: t('agileGuide.heading'), description: t('seo.agile.description'),
    dates: AGILE_GUIDE_DATES, citations: Object.values(AGILE_SOURCE_URL), topics: AGILE_GUIDE_TOPICS,
  }),
});

const outputFile = (path) => (path === '/' ? 'index.html' : `${path.slice(1)}/index.html`);

// t() reads the current language at call time, so the language (and its
// on-demand dictionary) is loaded before rendering.
async function languagePages(lang, shared) {
  await setLang(lang);
  return SEO_PAGES.map((page) => {
    const path = localizedPath(page.path, lang);
    const url = canonicalUrl(path);
    const structuredData = STRUCTURED_DATA[page.kind]?.({ lang, url, imageUrl: shared.image.url }) ?? null;
    return {
      file: outputFile(path),
      options: { lang, title: t(page.titleKey), description: t(page.descriptionKey), canonical: url,
        alternates: pageAlternates(page.path), body: renderToStaticMarkup(VIEWS[page.kind](page)), structuredData, ...shared },
    };
  });
}

/** Every pre-rendered file: output path plus the page options for pageDocument. */
export async function prerenderedPages() {
  const css = themeTokenCss({ light: TOKENS.light, dark: TOKENS.dark });
  const image = { ...SOCIAL_IMAGE, url: canonicalUrl(SOCIAL_IMAGE.path) };
  const pages = [];
  // One language at a time: t() reads the single current language.
  for (const lang of SEO_LANGS) pages.push(...await languagePages(lang, { image, css }));
  await setLang(DEFAULT_SEO_LANG);
  return [
    ...pages,
    { file: '404.html', options: { lang: DEFAULT_SEO_LANG, title: t(NOT_FOUND_TITLE_KEY), robots: ROBOTS_NOINDEX,
      body: renderToStaticMarkup(<NotFoundPage />), css } },
    // Shell for boards and the Public Wall: no content of its own, never indexed.
    { file: 'app.html', options: { lang: DEFAULT_SEO_LANG, title: t('app.title'), robots: ROBOTS_NOINDEX } },
  ];
}
