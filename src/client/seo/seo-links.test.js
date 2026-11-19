import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { pageDocument } from './page-document.js';
import { SEO_LANGS, SEO_PAGES, localizedPath } from './seo-pages.js';

const TEMPLATE = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const NON_PAGE_PREFIXES = Object.freeze(['/public', '/b/', '/p/', '/assets/']);

const bodyOf = (html) => html.slice(html.indexOf('<body'));
const internalHrefs = (html) => [...bodyOf(html).matchAll(/<a [^>]*?href="([^"]+)"/g)]
  .map((match) => match[1].replace(/[?#].*$/, ''))
  .filter((href) => href.startsWith('/') && !href.startsWith('//'));
const fileOf = (path) => (path === '/' ? 'index.html' : `${path.slice(1)}/index.html`);
const renderAll = (check) => withChromeModule('/src/client/seo/prerender-entry.jsx', async ({ prerenderedPages }) => {
  const pages = new Map((await prerenderedPages()).map(({ file, options }) => [file, pageDocument(TEMPLATE, options)]));
  return check(pages);
});

test('on a language page every link to an indexable page stays in that language', async () => {
  await renderAll((pages) => {
    for (const lang of SEO_LANGS.filter((code) => code !== 'en')) {
      const ownPages = new Set(SEO_PAGES.map(({ path }) => localizedPath(path, lang)));
      for (const { path } of SEO_PAGES) {
        const file = fileOf(localizedPath(path, lang));
        for (const href of internalHrefs(pages.get(file))) {
          const trimmed = href.length > 1 ? href.replace(/\/$/, '') : href;
          assert.ok(ownPages.has(trimmed) || NON_PAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix)), `${file}: ${href}`);
        }
      }
    }
  });
});

test('every internal link in every page body reaches a page the build writes', async () => {
  await renderAll((pages) => {
    const written = new Set([...pages.keys()].filter((file) => file.endsWith('index.html'))
      .map((file) => (file === 'index.html' ? '/' : `/${file.slice(0, -'/index.html'.length)}`)));
    for (const [file, html] of pages) {
      for (const href of internalHrefs(html)) {
        const trimmed = href.length > 1 ? href.replace(/\/$/, '') : href;
        assert.ok(written.has(trimmed) || NON_PAGE_PREFIXES.some((prefix) => trimmed.startsWith(prefix)), `${file}: dead link ${href}`);
      }
    }
  });
});
