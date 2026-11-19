import React, { createContext, useContext } from 'react';
import { LANGUAGE_OPTIONS, t, useLang } from '../ui/i18n.js';
import { localizedPath, seoPageForPath, splitLangPath } from './seo-pages.js';
import '../ui/language-picker.css';

/** The unprefixed path of the page being rendered; set by the build's prerender, where there is no URL. */
export const PagePathContext = createContext(null);

function currentPagePath(prerenderedPath) {
  if (prerenderedPath) return prerenderedPath;
  if (typeof window === 'undefined') return null;
  return seoPageForPath(splitLangPath(window.location.pathname).path)?.path ?? null;
}

// One real link per app language to this same page, so crawlers and visitors can
// reach every language version from the page body. Renders nothing on pages that
// have no language versions (not found, boards).
export default function LanguageLinks() {
  const [lang] = useLang();
  const path = currentPagePath(useContext(PagePathContext));
  if (!path) return null;
  return (
    <nav className="rb-lang-links" aria-label={t('settings.langLinks')}>
      {LANGUAGE_OPTIONS.map(({ code, name }) => (
        <a key={code} href={localizedPath(path, code)} hrefLang={code} lang={code} aria-current={code === lang ? 'page' : undefined}>{name}</a>
      ))}
    </nav>
  );
}
