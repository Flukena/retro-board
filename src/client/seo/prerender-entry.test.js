import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { pageDocument } from './page-document.js';
import { SEO_LANGS, SEO_PAGES, SITE_ORIGIN, SOCIAL_IMAGE, canonicalUrl, localizedPath, pageAlternates } from './seo-pages.js';

const TEMPLATE = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const hrefs = (html) => new Set([...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]));

const renderAll = (check) => withChromeModule('/src/client/seo/prerender-entry.jsx', async ({ prerenderedPages }) => {
  const pages = new Map((await prerenderedPages()).map(({ file, options }) => [file, pageDocument(TEMPLATE, options)]));
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

const fileFor = (path) => (path === '/' ? 'index.html' : `${path.slice(1)}/index.html`);
const THAI_TEXT = /[\u0E00-\u0E7F]/;
const linkTags = (html, rel) => [...html.matchAll(new RegExp(`<link rel="${rel}"[^>]*>`, 'g'))].map((match) => match[0]);

test('template guides ship a localized example note for every column before JavaScript runs', async () => {
  await renderAll((pages) => {
    for (const guide of SEO_PAGES.filter(page => page.slug)) {
      const examplesByLanguage = new Set();
      for (const lang of SEO_LANGS) {
        const path = localizedPath(guide.path, lang);
        const html = pages.get(fileFor(path));
        const board = html.match(/<section[^>]+aria-labelledby="template-board"[^>]*>([\s\S]*?)<\/section>/)[1];
        const columns = [...board.matchAll(/<li>([\s\S]*?)<\/li>/g)];
        assert.ok(columns.length > 0, path);
        const notes = columns.map(([, column]) => {
          const note = column.match(/<q\b[^>]*>([^<]+)<\/q>/)?.[1];
          assert.ok(note && !note.startsWith('tpl.'), path + ' needs a filled-in example for each column');
          return note;
        });
        assert.equal(new Set(notes).size, columns.length, path);
        examplesByLanguage.add(notes.join('\n'));
      }
      assert.equal(examplesByLanguage.size, SEO_LANGS.length, guide.path + ' examples must be translated');
    }
  });
});

test('every public page also ships a Thai version under /th with Thai head and content', async () => {
  await renderAll((pages) => {
    const thaiTitles = new Set();
    for (const page of SEO_PAGES) {
      const path = localizedPath(page.path, 'th');
      const html = pages.get(fileFor(path));
      assert.ok(html, path);
      assert.match(html, /<html lang="th">/, path);
      assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl(path)}" />`), path);
      const title = html.match(/<title>([^<]+)<\/title>/)[1];
      assert.match(title, THAI_TEXT, `${path}: Thai title`);
      thaiTitles.add(title);
      assert.match(html.match(/<meta name="description" content="([^"]+)"/)[1], THAI_TEXT, `${path}: Thai description`);
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${path}: one h1`);
      assert.match(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1], THAI_TEXT, `${path}: Thai h1`);
      assert.match(html, /property="og:image"/, path);
      assert.doesNotMatch(html, /<div id="root"><\/div>/, `${path}: content is pre-rendered`);
    }
    assert.equal(thaiTitles.size, SEO_PAGES.length);
    assert.doesNotMatch(pages.get('index.html').match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1], THAI_TEXT, 'English home stays English');
  });
});

test('both language versions of a page carry the same reciprocal hreflang set', async () => {
  await renderAll((pages) => {
    for (const page of SEO_PAGES) {
      const expected = pageAlternates(page.path)
        .map(({ hreflang, href }) => `<link rel="alternate" hreflang="${hreflang}" href="${href}" />`);
      for (const lang of SEO_LANGS) {
        const html = pages.get(fileFor(localizedPath(page.path, lang)));
        assert.deepEqual(linkTags(html, 'alternate'), expected, `${lang} ${page.path}`);
      }
    }
    for (const file of ['404.html', 'app.html']) assert.deepEqual(linkTags(pages.get(file), 'alternate'), [], file);
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

// PNG layout: 8-byte signature, then the IHDR chunk with width and height as
// big-endian 32-bit integers at bytes 16 and 20.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
// Facebook and X reject preview images above this size.
const MAX_SOCIAL_IMAGE_BYTES = 5 * 1024 * 1024;

test('every public page links the same absolute preview image and a large card; 404 and app shell do not', async () => {
  await renderAll((pages) => {
    const imageUrl = `${SITE_ORIGIN}${SOCIAL_IMAGE.path}`;
    for (const page of SEO_PAGES) {
      const html = pages.get(page.path === '/' ? 'index.html' : `${page.path.slice(1)}/index.html`);
      assert.ok(html.includes(`<meta property="og:image" content="${imageUrl}" />`), page.path);
      assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/, page.path);
    }
    for (const file of ['404.html', 'app.html']) assert.doesNotMatch(pages.get(file), /og:image|twitter:card/, file);
  });
});

test('the preview image file is a PNG of the declared size and small enough for social sites', () => {
  const png = readFileSync(new URL(`../../../public${SOCIAL_IMAGE.path}`, import.meta.url));
  assert.equal(SOCIAL_IMAGE.type, 'image/png');
  assert.ok(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE));
  assert.equal(png.readUInt32BE(PNG_WIDTH_OFFSET), SOCIAL_IMAGE.widthPx);
  assert.equal(png.readUInt32BE(PNG_HEIGHT_OFFSET), SOCIAL_IMAGE.heightPx);
  assert.ok(png.length < MAX_SOCIAL_IMAGE_BYTES);
});

test('every public page ships in every app language with its own translated head and body', async () => {
  await renderAll((pages) => {
    for (const lang of SEO_LANGS.filter((code) => code !== 'en')) {
      for (const page of SEO_PAGES) {
        const path = localizedPath(page.path, lang);
        const html = pages.get(fileFor(path));
        const english = pages.get(fileFor(page.path));
        assert.ok(html, path);
        assert.match(html, new RegExp(`<html lang="${lang}">`), path);
        assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl(path)}" />`), path);
        const titleOf = (doc) => doc.match(/<title>([^<]+)<\/title>/)[1];
        assert.notEqual(titleOf(html), titleOf(english), `${path}: translated title`);
        assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${path}: one h1`);
      }
    }
    for (const page of SEO_PAGES) {
      const titles = SEO_LANGS.map((lang) => pages.get(fileFor(localizedPath(page.path, lang))).match(/<title>([^<]+)<\/title>/)[1]);
      assert.equal(new Set(titles).size, SEO_LANGS.length, `${page.path}: each language has its own title`);
    }
  });
});

const structuredDataOf = (html) => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  return blocks.map((match) => JSON.parse(match[1]));
};

test('the Agile guide tells search engines it is an article, in its language, citing its sources', async () => {
  await renderAll((pages) => {
    for (const lang of SEO_LANGS) {
      const path = localizedPath('/agile-scrum', lang);
      const [article, ...extra] = structuredDataOf(pages.get(fileFor(path)));
      assert.deepEqual(extra, [], path);
      assert.equal(article['@type'], 'Article');
      assert.equal(article.inLanguage, lang);
      assert.equal(article.url, canonicalUrl(path));
      assert.ok(article.headline && article.description, path);
      assert.deepEqual(article.citation, ['https://scrumguides.org/scrum-guide.html', 'https://agilemanifesto.org/', 'https://agilemanifesto.org/principles.html']);
      assert.equal(article.publisher.name, 'RetroRoom');
    }
    assert.deepEqual(structuredDataOf(pages.get('index.html')), [], 'other pages carry no article data');
  });
});
