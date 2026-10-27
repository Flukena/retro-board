import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLang, t } from '../ui/i18n.js';
import { TOKENS } from '../ui/theme.js';
import Landing from '../app/Landing.jsx';
import LegalPage from '../legal/LegalPage.jsx';
import TemplatePage from '../templates/TemplatePage.jsx';
import NotFoundPage from '../app/NotFoundPage.jsx';
import { NOT_FOUND_TITLE_KEY, SEO_PAGES, SEO_PAGE_KIND, canonicalUrl } from './seo-pages.js';
import { ROBOTS_NOINDEX, themeTokenCss } from './page-document.js';

// Build-time entry (vite build --ssr): renders every public page in English,
// the language of the static HTML. The client re-renders in the reader's language.
export const PRERENDER_LANG = 'en';

const VIEWS = Object.freeze({
  [SEO_PAGE_KIND.LANDING]: () => <Landing />,
  [SEO_PAGE_KIND.TEMPLATE]: (page) => <TemplatePage slug={page.slug} />,
  [SEO_PAGE_KIND.LEGAL]: (page) => <LegalPage page={page.legalPage} />,
});

const outputFile = (path) => (path === '/' ? 'index.html' : `${path.slice(1)}/index.html`);

/** Every pre-rendered file: output path plus the page options for pageDocument. */
export function prerenderedPages() {
  setLang(PRERENDER_LANG);
  const css = themeTokenCss({ light: TOKENS.light, dark: TOKENS.dark });
  const pages = SEO_PAGES.map((page) => ({
    file: outputFile(page.path),
    options: { lang: PRERENDER_LANG, title: t(page.titleKey), description: t(page.descriptionKey),
      canonical: canonicalUrl(page.path), body: renderToStaticMarkup(VIEWS[page.kind](page)), css },
  }));
  return [
    ...pages,
    { file: '404.html', options: { lang: PRERENDER_LANG, title: t(NOT_FOUND_TITLE_KEY), robots: ROBOTS_NOINDEX,
      body: renderToStaticMarkup(<NotFoundPage />), css } },
    // Shell for boards and the Public Wall: no content of its own, never indexed.
    { file: 'app.html', options: { lang: PRERENDER_LANG, title: t('app.title'), robots: ROBOTS_NOINDEX } },
  ];
}
