import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import { SEO_PAGES, SITE_ORIGIN, canonicalUrl, seoPageForPath, sitemapXml } from './seo-pages.js';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('the sitemap lists exactly the indexable pages and nothing private or user-made', () => {
  const sitemap = read('public/sitemap.xml');
  assert.equal(sitemap, sitemapXml());
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locs, SEO_PAGES.map((page) => canonicalUrl(page.path)));
  assert.ok(locs.every((loc) => loc.startsWith(`${SITE_ORIGIN}/`)));
  assert.ok(!locs.some((loc) => /\/(b|public)(\/|$)/.test(new URL(loc).pathname)), 'boards and the Public Wall stay out');
  for (const path of ['/', '/templates/start-stop-continue', '/templates/mad-sad-glad', '/templates/4ls-retrospective']) {
    assert.ok(locs.includes(canonicalUrl(path)), path);
  }
});

test('robots.txt lets crawlers read the noindex on boards and points at the sitemap', () => {
  const robots = read('public/robots.txt');
  assert.doesNotMatch(robots, /Disallow:\s*\/b\//, 'blocking /b/ would hide its noindex from crawlers');
  assert.match(robots, /^Sitemap: https:\/\/retroroom\.party\/sitemap\.xml$/m);
  assert.match(robots, /^Disallow: \/yjs\/$/m);
});

test('every indexable page has its own title and description in both languages', async () => {
  await withChromeModule('/src/client/seo/seo-pages.js', (seo, { setLang, t }) => {
    for (const lang of ['th', 'en']) {
      setLang(lang);
      const titles = seo.SEO_PAGES.map((page) => t(page.titleKey));
      const descriptions = seo.SEO_PAGES.map((page) => t(page.descriptionKey));
      for (const text of [...titles, ...descriptions]) assert.ok(!text.startsWith('seo.'), `${lang}: untranslated ${text}`);
      assert.equal(new Set(titles).size, titles.length, `${lang}: titles repeat`);
      assert.equal(new Set(descriptions).size, descriptions.length, `${lang}: descriptions repeat`);
    }
    setLang('en');
    assert.equal(t(seo.seoPageForPath('/').titleKey), 'Free Online Retrospective Board — RetroRoom');
  });
});

test('page lookup ignores a trailing slash and knows nothing about boards', () => {
  assert.equal(seoPageForPath('/templates/mad-sad-glad/').path, '/templates/mad-sad-glad');
  assert.equal(seoPageForPath('/b/Room1234'), null);
  assert.equal(seoPageForPath('/public'), null);
});
