import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHref } from './page-links.js';
import { SEO_LANGS, SEO_PAGES } from './seo-pages.js';
import { setLang } from '../ui/i18n.js';

test('the root page links to the language home, other pages to their prefixed path', () => {
  assert.equal(pageHref('/', 'th'), '/th');
  assert.equal(pageHref('/privacy', 'th'), '/th/privacy');
  assert.equal(pageHref('/templates/mad-sad-glad', 'ja'), '/ja/templates/mad-sad-glad');
});

test('English keeps the unprefixed paths', () => {
  for (const { path } of SEO_PAGES) assert.equal(pageHref(path, 'en'), path);
});

test('every indexable page gets every language prefix', () => {
  for (const { path } of SEO_PAGES) {
    for (const lang of SEO_LANGS.filter((code) => code !== 'en')) {
      assert.ok(pageHref(path, lang).startsWith(`/${lang}`), `${lang} ${path}`);
    }
  }
});

test('targets that are not indexable pages stay unchanged', () => {
  for (const path of ['/public', '/b/abc', '/p/room', '/assets/app.js', '#landing-guide-faq', 'https://example.com/x', '/th/privacy']) {
    assert.equal(pageHref(path, 'th'), path);
  }
});

test('the current UI language is the default', async () => {
  await setLang('th');
  try {
    assert.equal(pageHref('/terms'), '/th/terms');
  } finally {
    await setLang('en');
  }
  assert.equal(pageHref('/terms'), '/terms');
});
