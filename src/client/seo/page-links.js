import { getLang } from '../ui/i18n.js';
import { SEO_PAGES, localizedPath } from './seo-pages.js';

const INDEXABLE_PATHS = new Set(SEO_PAGES.map((entry) => entry.path));

/**
 * Where an internal link to `path` should go for the current UI language.
 * Indexable pages (SEO_PAGES) get the language prefix ('/privacy' → '/th/privacy');
 * every other target (rooms, /public, assets, '#section' anchors) is returned as is.
 * The UI language, not the URL, decides: the language picker changes it in place.
 */
export const pageHref = (path, lang = getLang()) => (INDEXABLE_PATHS.has(path) ? localizedPath(path, lang) : path);
