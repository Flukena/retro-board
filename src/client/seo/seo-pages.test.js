import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withChromeModule } from '../../test-support/chrome-test-helper.js';
import {
  SEO_PAGES, SITE_ORIGIN, canonicalUrl, localizedPath, pageAlternates, seoPageForPath, sitemapXml, splitLangPath,
} from './seo-pages.js';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('the sitemap lists exactly the indexable pages and nothing private or user-made', () => {
  const sitemap = read('public/sitemap.xml');
  assert.equal(sitemap, sitemapXml());
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locs, SEO_PAGES.flatMap((page) => [canonicalUrl(page.path), canonicalUrl(localizedPath(page.path, 'th'))]));
  assert.ok(locs.every((loc) => loc.startsWith(`${SITE_ORIGIN}/`)));
  assert.ok(!locs.some((loc) => /\/(b|p|public)(\/|$)/.test(new URL(loc).pathname)), 'boards, poker rooms and the Public Wall stay out');
  for (const path of ['/', '/planning-poker', '/th/planning-poker', '/templates/start-stop-continue', '/templates/mad-sad-glad', '/templates/4ls-retrospective',
    '/th', '/th/templates/retro-loop', '/th/privacy']) {
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

test('Thai pages live under /th and the lookup finds the same page through the prefix', () => {
  assert.equal(localizedPath('/', 'th'), '/th');
  assert.equal(localizedPath('/templates/mad-sad-glad', 'th'), '/th/templates/mad-sad-glad');
  assert.equal(localizedPath('/privacy', 'en'), '/privacy');
  assert.deepEqual(splitLangPath('/th'), { lang: 'th', path: '/' });
  assert.deepEqual(splitLangPath('/th/'), { lang: 'th', path: '/' });
  assert.deepEqual(splitLangPath('/th/terms'), { lang: 'th', path: '/terms' });
  assert.deepEqual(splitLangPath('/thai'), { lang: null, path: '/thai' }, 'only a whole /th segment is a prefix');
  assert.equal(seoPageForPath('/th/templates/mad-sad-glad/').path, '/templates/mad-sad-glad');
  assert.equal(seoPageForPath('/th').path, '/');
  assert.equal(seoPageForPath('/th/b/Room1234'), null);
});

test('every language version of a page points at all versions, with English as x-default', () => {
  assert.deepEqual(pageAlternates('/privacy'), [
    { hreflang: 'en', href: 'https://retroroom.party/privacy' },
    { hreflang: 'th', href: 'https://retroroom.party/th/privacy' },
    { hreflang: 'x-default', href: 'https://retroroom.party/privacy' },
  ]);
});

// RFC 9116: Contact and Expires are required, and an expired file must be renewed, not ignored.
test('security.txt names a contact, a future expiry and its canonical URL', () => {
  const fields = Object.fromEntries(read('public/.well-known/security.txt').trim().split('\n').map((line) => {
    const separator = line.indexOf(': ');
    return [line.slice(0, separator), line.slice(separator + 2)];
  }));
  assert.match(fields.Contact, /^mailto:[^@\s]+@[^@\s]+$/);
  const expires = Date.parse(fields.Expires);
  assert.ok(Number.isFinite(expires) && expires > Date.now(), 'security.txt has expired: set a new Expires date');
  assert.equal(fields.Canonical, `${SITE_ORIGIN}/.well-known/security.txt`);
});
