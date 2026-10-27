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
