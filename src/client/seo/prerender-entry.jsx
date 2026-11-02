import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setLang, t } from '../ui/i18n.js';
import { TOKENS } from '../ui/theme.js';
import Landing from '../app/Landing.jsx';
import LegalPage from '../legal/LegalPage.jsx';
import TemplatePage from '../templates/TemplatePage.jsx';
import NotFoundPage from '../app/NotFoundPage.jsx';
import PokerGuidePage from '../poker/PokerGuidePage.jsx';
import {
  DEFAULT_SEO_LANG, NOT_FOUND_TITLE_KEY, SEO_LANGS, SEO_PAGES, SEO_PAGE_KIND, SOCIAL_IMAGE,
  canonicalUrl, localizedPath, pageAlternates,
} from './seo-pages.js';
import { ROBOTS_NOINDEX, themeTokenCss } from './page-document.js';

// Build-time entry (vite build --ssr): renders every public page once per
// language (English at the root, Thai under /th). The not-found page and the
// board shell are English only and never indexed.

const VIEWS = Object.freeze({
  [SEO_PAGE_KIND.LANDING]: () => <Landing />,
  [SEO_PAGE_KIND.TEMPLATE]: (page) => <TemplatePage slug={page.slug} />,
  [SEO_PAGE_KIND.LEGAL]: (page) => <LegalPage page={page.legalPage} />,
  [SEO_PAGE_KIND.TOOL]: () => <PokerGuidePage />,
});

const outputFile = (path) => (path === '/' ? 'index.html' : `${path.slice(1)}/index.html`);

// t() reads the current language at call time, so set it before rendering.
function languagePages(lang, shared) {
  setLang(lang);
  return SEO_PAGES.map((page) => {
    const path = localizedPath(page.path, lang);
    return {
      file: outputFile(path),
      options: { lang, title: t(page.titleKey), description: t(page.descriptionKey), canonical: canonicalUrl(path),
        alternates: pageAlternates(page.path), body: renderToStaticMarkup(VIEWS[page.kind](page)), ...shared },
    };
  });
}

/** Every pre-rendered file: output path plus the page options for pageDocument. */
export function prerenderedPages() {
  const css = themeTokenCss({ light: TOKENS.light, dark: TOKENS.dark });
  const image = { ...SOCIAL_IMAGE, url: canonicalUrl(SOCIAL_IMAGE.path) };
  const pages = SEO_LANGS.flatMap((lang) => languagePages(lang, { image, css }));
  setLang(DEFAULT_SEO_LANG);
  return [
    ...pages,
    { file: '404.html', options: { lang: DEFAULT_SEO_LANG, title: t(NOT_FOUND_TITLE_KEY), robots: ROBOTS_NOINDEX,
      body: renderToStaticMarkup(<NotFoundPage />), css } },
    // Shell for boards and the Public Wall: no content of its own, never indexed.
    { file: 'app.html', options: { lang: DEFAULT_SEO_LANG, title: t('app.title'), robots: ROBOTS_NOINDEX } },
  ];
}
