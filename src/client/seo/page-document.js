// Turns the built index.html into one page's HTML: its own head (title,
// description, canonical, robots) and, for content pages, the pre-rendered body.

const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

export const ROBOTS_NOINDEX = 'noindex';
const ROOT_ELEMENT = '<div id="root"></div>';
const TITLE_ELEMENT = /<title>[^<]*<\/title>/;
const HTML_OPEN = /<html lang="[^"]*">/;

const tokenBlock = (tokens) => Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';');

/** CSS variables for both themes, so pre-rendered content is styled before scripts run. */
export function themeTokenCss({ light, dark }) {
  const darkOnly = Object.fromEntries(Object.entries(dark).filter(([name, value]) => light[name] !== value));
  return `:root{${tokenBlock(light)}}@media (prefers-color-scheme: dark){:root{${tokenBlock(darkOnly)}}}`;
}

function headTags({ title, description, canonical, robots }) {
  const tags = [`<title>${escapeHtml(title)}</title>`];
  if (description) tags.push(`<meta name="description" content="${escapeHtml(description)}" />`);
  if (robots) tags.push(`<meta name="robots" content="${escapeHtml(robots)}" />`);
  if (canonical) {
    tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}" />`,
      '<meta property="og:type" content="website" />',
      `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
      `<meta property="og:title" content="${escapeHtml(title)}" />`);
    if (description) tags.push(`<meta property="og:description" content="${escapeHtml(description)}" />`);
  }
  return tags.join('\n    ');
}

const replaceOnce = (html, pattern, replacement, label) => {
  const matches = typeof pattern === 'string' ? html.split(pattern).length - 1 : (html.match(new RegExp(pattern, 'g')) || []).length;
  if (matches !== 1) throw new Error(`index.html must contain exactly one ${label}`);
  return html.replace(pattern, () => replacement);
};

/** Build one page's HTML from the built index.html template. */
export function pageDocument(template, { lang, title, description = null, canonical = null, robots = null, body = '', css = '' }) {
  let html = replaceOnce(template, HTML_OPEN, `<html lang="${escapeHtml(lang)}">`, '<html lang>');
  html = replaceOnce(html, TITLE_ELEMENT, headTags({ title, description, canonical, robots })
    + (css ? `\n    <style>${css}</style>` : ''), '<title>');
  return replaceOnce(html, ROOT_ELEMENT, `<div id="root">${body}</div>`, 'root element');
}
