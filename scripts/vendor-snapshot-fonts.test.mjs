import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { familySlug, fontStylesheetURL, parseFontFaces, relativeStylesheet } from './vendor-snapshot-fonts.mjs';

const GOOGLE_CSS = `/* thai */
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/a/thai.woff2) format('woff2');
  unicode-range: U+0E01-0E5B;
}
/* latin */
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/a/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}`;

const readRepoFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Google font-face blocks keep their subset, family, weight and file URL', () => {
  assert.deepEqual(parseFontFaces(GOOGLE_CSS), [
    { subset: 'thai', family: 'IBM Plex Mono', weight: '700', url: 'https://fonts.gstatic.com/s/a/thai.woff2' },
    { subset: 'latin', family: 'IBM Plex Mono', weight: '400', url: 'https://fonts.gstatic.com/s/a/latin.woff2' },
  ]);
});

test('vendored stylesheet points at same-origin copies and keeps unicode ranges', () => {
  const css = relativeStylesheet(GOOGLE_CSS, new Map([['https://fonts.gstatic.com/s/a/thai.woff2', 'abc.woff2']]));
  assert.match(css, /src: url\(\.\/abc\.woff2\) format\('woff2'\)/);
  assert.match(css, /url\(https:\/\/fonts\.gstatic\.com\/s\/a\/latin\.woff2\)/, 'unknown URLs are left alone');
  assert.match(css, /unicode-range: U\+0E01-0E5B;/);
});

test('license slugs match the google/fonts ofl directory names', () => {
  assert.equal(familySlug('IBM Plex Mono'), 'ibmplexmono');
  assert.equal(familySlug('Anuphan'), 'anuphan');
});

test('board-image fonts are a copy of exactly the families index.html loads', () => {
  const manifest = JSON.parse(readRepoFile('public/fonts/board-snapshot/manifest.json'));
  const pageFonts = fontStylesheetURL(readRepoFile('index.html'));
  assert.equal(manifest.cssSourceUrl, pageFonts);
  const vendoredFamilies = new Set(parseFontFaces(readRepoFile('public/fonts/board-snapshot/fonts.css')).map((face) => face.family));
  const requestedFamilies = new Set(new URL(pageFonts).searchParams.getAll('family').map((spec) => spec.split(':')[0].replaceAll('+', ' ')));
  assert.deepEqual(vendoredFamilies, requestedFamilies);
});
