// Turns the built index.html into one page's HTML: its own head (title,
// description, canonical, robots) and, for content pages, the pre-rendered body.

import { LEGAL_CONTACT_EMAIL } from '../legal/legal-content.js';

const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

export const ROBOTS_NOINDEX = 'noindex';
const TWITTER_CARD_LARGE_IMAGE = 'summary_large_image';
const ROOT_ELEMENT = '<div id="root"></div>';
const TITLE_ELEMENT = /<title>[^<]*<\/title>/;
const HTML_OPEN = /<html lang="[^"]*">/;

// JSON inside a <script> must not be able to close the element early.
const jsonForScript = (data) => JSON.stringify(data).replace(/</g, '\\u003c');
const structuredDataTag = (data) => `<script type="application/ld+json">${jsonForScript(data)}</script>`;

const tokenBlock = (tokens) => Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';');

/** CSS variables for both themes, so pre-rendered content is styled before scripts run. */
export function themeTokenCss({ light, dark }) {
  const darkOnly = Object.fromEntries(Object.entries(dark).filter(([name, value]) => light[name] !== value));
  return `:root{${tokenBlock(light)}}@media (prefers-color-scheme: dark){:root{${tokenBlock(darkOnly)}}}`;
}

// Open Graph image plus the Twitter/X card; X reads title and description from og:*.
const imageTags = ({ url, type, widthPx, heightPx }) => [
  `<meta property="og:image" content="${escapeHtml(url)}" />`,
  `<meta property="og:image:type" content="${escapeHtml(type)}" />`,
  `<meta property="og:image:width" content="${widthPx}" />`,
  `<meta property="og:image:height" content="${heightPx}" />`,
  `<meta name="twitter:card" content="${TWITTER_CARD_LARGE_IMAGE}" />`,
];

const alternateTags = (alternates) => alternates.map(({ hreflang, href }) =>
  `<link rel="alternate" hreflang="${escapeHtml(hreflang)}" href="${escapeHtml(href)}" />`);

function headTags({ title, description, canonical, robots, image, alternates }) {
  const tags = [`<title>${escapeHtml(title)}</title>`];
  if (description) tags.push(`<meta name="description" content="${escapeHtml(description)}" />`);
  if (robots) tags.push(`<meta name="robots" content="${escapeHtml(robots)}" />`);
  if (canonical) {
    tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}" />`, ...alternateTags(alternates),
      '<meta property="og:type" content="website" />',
      `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
      `<meta property="og:title" content="${escapeHtml(title)}" />`);
    if (description) tags.push(`<meta property="og:description" content="${escapeHtml(description)}" />`);
    if (image) tags.push(...imageTags(image));
  }
  return tags.join('\n    ');
}

const replaceOnce = (html, pattern, replacement, label) => {
  const matches = typeof pattern === 'string' ? html.split(pattern).length - 1 : (html.match(new RegExp(pattern, 'g')) || []).length;
  if (matches !== 1) throw new Error(`index.html must contain exactly one ${label}`);
  return html.replace(pattern, () => replacement);
};

// Cloudflare's Email Address Obfuscation skips text between these markers.
// Without them it rewrites the address into a link to /cdn-cgi/l/email-protection, which is a 404.
const EMAIL_OFF_OPEN = '<!--email_off-->';
const EMAIL_OFF_CLOSE = '<!--/email_off-->';
const HTML_TAG = /(<[^>]*>)/;

/**
 * Wraps each occurrence of `email` in body text in the email_off markers.
 * An address inside a tag (an href) cannot be wrapped from inside the attribute, so it fails the build.
 */
export function markEmailOff(body, email = LEGAL_CONTACT_EMAIL) {
  if (!body.includes(email)) return body;
  return body.split(HTML_TAG).map((part, index) => {
    const isTag = index % 2 === 1;
    if (isTag && part.includes(email)) throw new Error(`the contact email sits inside a tag: ${part.slice(0, 80)}`);
    return isTag ? part : part.split(email).join(`${EMAIL_OFF_OPEN}${email}${EMAIL_OFF_CLOSE}`);
  }).join('');
}

/** Build one page's HTML from the built index.html template. */
export function pageDocument(template, {
  lang, title, description = null, canonical = null, robots = null, image = null, alternates = [], body = '', css = '', structuredData = null,
}) {
  let html = replaceOnce(template, HTML_OPEN, `<html lang="${escapeHtml(lang)}">`, '<html lang>');
  html = replaceOnce(html, TITLE_ELEMENT, headTags({ title, description, canonical, robots, image, alternates })
    + (css ? `\n    <style>${css}</style>` : '')
    + (structuredData ? `\n    ${structuredDataTag(structuredData)}` : ''), '<title>');
  return replaceOnce(html, ROOT_ELEMENT, `<div id="root">${markEmailOff(body)}</div>`, 'root element');
}
