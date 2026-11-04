import { LEGAL_PAGE, LEGAL_PATH } from '../legal/legal-content.js';
import { LANGUAGE_OPTIONS } from '../ui/i18n.js';
import { STARTER_FORMAT, templatePath } from '../templates/starter-formats.js';

// Public pages that search engines may index. The sitemap lists exactly these,
// and the build pre-renders each into its own HTML file with its own head.
export const SITE_ORIGIN = 'https://retroroom.party';

export const SEO_PAGE_KIND = Object.freeze({ LANDING: 'landing', TEMPLATE: 'template', LEGAL: 'legal', TOOL: 'tool', GUIDE: 'guide' });

// Guide page for the Planning Poker tool; rooms themselves live under /p/.
export const PLANNING_POKER_PATH = '/planning-poker';
// Reader guide to Agile and Scrum.
export const AGILE_GUIDE_PATH = '/agile-scrum';

const page = (path, key, kind, extra = {}) => Object.freeze({
  path, kind, titleKey: `seo.${key}.title`, descriptionKey: `seo.${key}.description`, ...extra,
});

export const SEO_PAGES = Object.freeze([
  page('/', 'home', SEO_PAGE_KIND.LANDING),
  page(PLANNING_POKER_PATH, 'poker', SEO_PAGE_KIND.TOOL),
  page(AGILE_GUIDE_PATH, 'agile', SEO_PAGE_KIND.GUIDE),
  page(templatePath(STARTER_FORMAT.RETRO_LOOP), 'loop', SEO_PAGE_KIND.TEMPLATE, { slug: STARTER_FORMAT.RETRO_LOOP }),
  page(templatePath(STARTER_FORMAT.START_STOP_CONTINUE), 'ssc', SEO_PAGE_KIND.TEMPLATE, { slug: STARTER_FORMAT.START_STOP_CONTINUE }),
  page(templatePath(STARTER_FORMAT.MAD_SAD_GLAD), 'msg', SEO_PAGE_KIND.TEMPLATE, { slug: STARTER_FORMAT.MAD_SAD_GLAD }),
  page(templatePath(STARTER_FORMAT.FOUR_LS), '4ls', SEO_PAGE_KIND.TEMPLATE, { slug: STARTER_FORMAT.FOUR_LS }),
  page(LEGAL_PATH[LEGAL_PAGE.PRIVACY], 'privacy', SEO_PAGE_KIND.LEGAL, { legalPage: LEGAL_PAGE.PRIVACY }),
  page(LEGAL_PATH[LEGAL_PAGE.TERMS], 'terms', SEO_PAGE_KIND.LEGAL, { legalPage: LEGAL_PAGE.TERMS }),
]);

// Shown for unknown paths; never indexed.
export const NOT_FOUND_TITLE_KEY = 'seo.notFound.title';

export const canonicalUrl = (path) => `${SITE_ORIGIN}${path}`;

// Each indexable page exists once per app language. English stays at the root and
// is also the x-default for other languages; every other language lives under
// /<code> (/th, /ja, /de, ...).
export const SEO_LANG = Object.freeze({ EN: 'en', TH: 'th' });
export const SEO_LANGS = Object.freeze(LANGUAGE_OPTIONS.map(({ code }) => code));
export const DEFAULT_SEO_LANG = SEO_LANG.EN;
const langPathPrefix = (lang) => (lang === DEFAULT_SEO_LANG ? '' : `/${lang}`);
const ROOT_PATH = '/';
const HREFLANG_DEFAULT = 'x-default';

/** The page path in a language: '/' → '/th', '/privacy' → '/th/privacy'. */
export const localizedPath = (path, lang) => {
  const prefix = langPathPrefix(lang);
  if (!prefix) return path;
  return path === ROOT_PATH ? prefix : `${prefix}${path}`;
};

/** Splits a URL path into its language prefix (null when unprefixed) and the page path. */
export function splitLangPath(pathname) {
  for (const lang of SEO_LANGS) {
    const prefix = langPathPrefix(lang);
    if (!prefix) continue;
    if (pathname === prefix || pathname === `${prefix}/`) return { lang, path: ROOT_PATH };
    if (pathname.startsWith(`${prefix}/`)) return { lang, path: pathname.slice(prefix.length) };
  }
  return { lang: null, path: pathname };
}

/** hreflang links shared by every language version of one page. */
export const pageAlternates = (path) => [
  ...SEO_LANGS.map((lang) => ({ hreflang: lang, href: canonicalUrl(localizedPath(path, lang)) })),
  { hreflang: HREFLANG_DEFAULT, href: canonicalUrl(localizedPath(path, DEFAULT_SEO_LANG)) },
];

// Link-preview card for chat apps and social sites; 1200×630 is the Open Graph
// large-image size. The file lives in public/.
export const SOCIAL_IMAGE = Object.freeze({
  path: '/og-image.png', type: 'image/png', widthPx: 1200, heightPx: 630,
});

export const seoPageForPath = (urlPath) => {
  const { path } = splitLangPath(urlPath);
  const trimmed = path.length > 1 ? path.replace(/\/$/, '') : path;
  return SEO_PAGES.find((entry) => entry.path === trimmed) ?? null;
};

export function sitemapXml() {
  const urls = SEO_PAGES.flatMap((entry) => SEO_LANGS.map((lang) => localizedPath(entry.path, lang)))
    .map((path) => `  <url>\n    <loc>${canonicalUrl(path)}</loc>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
