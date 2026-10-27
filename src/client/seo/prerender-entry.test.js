import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { pageDocument } from './page-document.js';
import { SEO_PAGES, canonicalUrl } from './seo-pages.js';

const TEMPLATE = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const hrefs = (html) => new Set([...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]));

const renderAll = (check) => withChromeModule('/src/client/seo/prerender-entry.jsx', ({ prerenderedPages }) => {
  const pages = new Map(prerenderedPages().map(({ file, options }) => [file, pageDocument(TEMPLATE, options)]));
  return check(pages);
});

test('every public page ships its own head and its content in the HTML itself', async () => {
  await renderAll((pages) => {
    for (const page of SEO_PAGES) {
      const html = pages.get(page.path === '/' ? 'index.html' : `${page.path.slice(1)}/index.html`);
      assert.ok(html, page.path);
      assert.match(html, /<html lang="en">/);
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${page.path}: one h1`);
      assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl(page.path)}" />`));
      assert.match(html, /<meta name="description" content="[^"]{50,}" \/>/);
      assert.doesNotMatch(html, /noindex/);
      assert.doesNotMatch(html, /<div id="root"><\/div>/, `${page.path}: content is pre-rendered`);
    }
    const titles = SEO_PAGES.map((page) => pages.get(page.path === '/' ? 'index.html' : `${page.path.slice(1)}/index.html`).match(/<title>([^<]+)<\/title>/)[1]);
    assert.equal(new Set(titles).size, titles.length);
  });
});

test('the home page explains the board, links every template guide and answers common questions', async () => {
  await renderAll((pages) => {
    const home = pages.get('index.html');
    assert.match(home, /<title>Free Online Retrospective Board — RetroRoom<\/title>/);
    assert.match(home, /<h1[^>]*>Free online retrospective board\./);
    for (const path of ['/templates/start-stop-continue', '/templates/mad-sad-glad', '/templates/4ls-retrospective', '/privacy', '/terms']) {
      assert.ok(hrefs(home).has(path), path);
    }
    assert.match(home, /Frequently asked questions/);
    assert.match(home, /not end-to-end encrypted/, 'the FAQ is honest about encryption');
  });
});

test('each template guide links home, the other guides and offers a start button', async () => {
  await renderAll((pages) => {
    const guides = SEO_PAGES.filter((page) => page.slug);
    for (const guide of guides) {
      const html = pages.get(`${guide.path.slice(1)}/index.html`);
      const links = hrefs(html);
      assert.ok(links.has('/'), guide.path);
      for (const other of guides.filter((entry) => entry !== guide)) assert.ok(links.has(other.path), `${guide.path} → ${other.path}`);
      assert.match(html, /<button[^>]*>.*Start a [^<]*<\/svg>?|<button[^>]*>[\s\S]*?Start a /);
      assert.match(html, /How to facilitate it/);
      assert.match(html, /Example prompts/);
    }
  });
});

test('the not-found page and the board shell are never indexed', async () => {
  await renderAll((pages) => {
    for (const file of ['404.html', 'app.html']) {
      assert.match(pages.get(file), /<meta name="robots" content="noindex" \/>/, file);
      assert.doesNotMatch(pages.get(file), /rel="canonical"/, file);
    }
    assert.match(pages.get('404.html'), /Page not found/);
    assert.match(pages.get('app.html'), /<div id="root"><\/div>/, 'boards render on the client only');
  });
});
