import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, pageDocument, themeTokenCss } from './page-document.js';

const TEMPLATE = '<!doctype html>\n<html lang="th">\n  <head>\n    <title>Retro Board</title>\n  </head>\n  <body><div id="root"></div></body>\n</html>';

test('a page gets its own language, title, description, canonical and body', () => {
  const html = pageDocument(TEMPLATE, { lang: 'en', title: 'A & B', description: 'Say "hi"', canonical: 'https://retroroom.party/x', body: '<h1>X</h1>' });
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>A &amp; B<\/title>/);
  assert.match(html, /<meta name="description" content="Say &quot;hi&quot;" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/retroroom.party\/x" \/>/);
  assert.match(html, /<div id="root"><h1>X<\/h1><\/div>/);
  assert.doesNotMatch(html, /noindex/);
});

test('a noindex page carries the robots meta and no canonical', () => {
  const html = pageDocument(TEMPLATE, { lang: 'en', title: 'Shell', robots: 'noindex' });
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.doesNotMatch(html, /canonical/);
});

test('a template without the expected root element is rejected instead of silently left unrendered', () => {
  assert.throws(() => pageDocument(TEMPLATE.replace('<div id="root"></div>', ''), { lang: 'en', title: 'X' }), /root element/);
});

test('inline tokens define light values and override only what dark changes', () => {
  const css = themeTokenCss({ light: { '--bg': 'white', '--gap': '4px' }, dark: { '--bg': 'black', '--gap': '4px' } });
  assert.equal(css, ':root{--bg:white;--gap:4px}@media (prefers-color-scheme: dark){:root{--bg:black}}');
  assert.equal(escapeHtml(`<a href='x'>`), '&lt;a href=&#39;x&#39;&gt;');
});

test('an indexable page with an image gets the Open Graph image and a large Twitter/X card', () => {
  const image = { url: 'https://retroroom.party/card.png', type: 'image/png', widthPx: 1200, heightPx: 630 };
  const html = pageDocument(TEMPLATE, { lang: 'en', title: 'X', canonical: 'https://retroroom.party/x', image });
  assert.match(html, /<meta property="og:image" content="https:\/\/retroroom.party\/card.png" \/>/);
  assert.match(html, /<meta property="og:image:type" content="image\/png" \/>/);
  assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
  assert.match(html, /<meta property="og:image:height" content="630" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
});

test('a noindex page gets no preview image even when one is passed', () => {
  const image = { url: 'https://retroroom.party/card.png', type: 'image/png', widthPx: 1200, heightPx: 630 };
  const html = pageDocument(TEMPLATE, { lang: 'en', title: 'Shell', robots: 'noindex', image });
  assert.doesNotMatch(html, /og:image|twitter:card/);
});

test('an indexable page lists its language alternates; a noindex page lists none', () => {
  const alternates = [{ hreflang: 'en', href: 'https://retroroom.party/x' }, { hreflang: 'th', href: 'https://retroroom.party/th/x' }];
  const html = pageDocument(TEMPLATE, { lang: 'th', title: 'X', canonical: 'https://retroroom.party/th/x', alternates });
  assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/retroroom.party\/x" \/>/);
  assert.match(html, /<link rel="alternate" hreflang="th" href="https:\/\/retroroom.party\/th\/x" \/>/);
  const shell = pageDocument(TEMPLATE, { lang: 'en', title: 'Shell', robots: 'noindex', alternates });
  assert.doesNotMatch(shell, /hreflang/);
});

test('structured data is embedded as JSON-LD that cannot close its script element early', () => {
  const html = pageDocument(TEMPLATE, { lang: 'en', title: 'X', structuredData: { headline: '</script><b>x' } });
  const block = html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/);
  assert.ok(block, 'one JSON-LD block');
  assert.deepEqual(JSON.parse(block[1]), { headline: '</script><b>x' });
  assert.doesNotMatch(pageDocument(TEMPLATE, { lang: 'en', title: 'X' }), /ld\+json/);
});
