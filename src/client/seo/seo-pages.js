import { LEGAL_PAGE, LEGAL_PATH } from '../legal/legal-content.js';
import { STARTER_FORMAT, templatePath } from '../templates/starter-formats.js';

// Public pages that search engines may index. The sitemap lists exactly these,
// and the build pre-renders each into its own HTML file with its own head.
export const SITE_ORIGIN = 'https://retroroom.party';

export const SEO_PAGE_KIND = Object.freeze({ LANDING: 'landing', TEMPLATE: 'template', LEGAL: 'legal' });

const page = (path, key, kind, extra = {}) => Object.freeze({
  path, kind, titleKey: `seo.${key}.title`, descriptionKey: `seo.${key}.description`, ...extra,
});

export const SEO_PAGES = Object.freeze([
  page('/', 'home', SEO_PAGE_KIND.LANDING),
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

export const seoPageForPath = (path) => {
  const trimmed = path.length > 1 ? path.replace(/\/$/, '') : path;
  return SEO_PAGES.find((entry) => entry.path === trimmed) ?? null;
};

export function sitemapXml() {
  const urls = SEO_PAGES.map((entry) => `  <url>\n    <loc>${canonicalUrl(entry.path)}</loc>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
