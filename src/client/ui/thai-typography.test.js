import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filesUnder } from '../../../scripts/project-files.mjs';
import { TOKENS } from './theme.js';

const KEYWORD_WEIGHTS = { normal: '400', bold: '700' };
const FONT_FAMILY_TOKEN_PATTERN = /var\((--font-[\w-]+)\)/;
const GOOGLE_FONTS_HREF_PATTERN = /href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/;
const THAI_LANGUAGE_SELECTOR = ':lang(th)';

const readRepoFile = (file) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

function cssRules(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    declarations: Object.fromEntries(body.split(';').filter((entry) => entry.includes(':')).map((entry) => {
      const separator = entry.indexOf(':');
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
    })),
  }));
}

function loadedWeightsByFamily() {
  const href = readRepoFile('index.html').match(GOOGLE_FONTS_HREF_PATTERN)[1].replaceAll('&amp;', '&');
  const families = new URL(href).searchParams.getAll('family');
  return Object.fromEntries(families.map((spec) => {
    const [name, axes = ''] = spec.split(':');
    return [name, new Set(axes.replace('wght@', '').split(';'))];
  }));
}

function resolveToken(value) {
  const token = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return token ? TOKENS.light[token] : value;
}

function familyAndWeight({ declarations }) {
  const shorthand = declarations.font?.match(/^(\d{3}|bold|normal)\s.*(var\(--font-[\w-]+\))/);
  const familyValue = shorthand?.[2] ?? declarations['font-family'];
  const weightValue = shorthand?.[1] ?? declarations['font-weight'];
  const familyToken = familyValue?.match(FONT_FAMILY_TOKEN_PATTERN)?.[1];
  if (!familyToken || !weightValue) return null;
  const family = TOKENS.light[familyToken].split(',')[0].replaceAll('"', '').trim();
  const weight = resolveToken(weightValue);
  return { family, weight: KEYWORD_WEIGHTS[weight] ?? weight };
}

test('every font weight the CSS asks for is a real loaded face, so Thai headings are never faux-bold', () => {
  const loaded = loadedWeightsByFamily();
  const missing = [];
  for (const file of filesUnder('src').filter((name) => name.endsWith('.css'))) {
    for (const rule of cssRules(readRepoFile(file))) {
      const face = familyAndWeight(rule);
      if (face && loaded[face.family] && !loaded[face.family].has(face.weight)) {
        missing.push(`${file} ${rule.selector}: ${face.family} ${face.weight}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('landing text with letter-spacing drops the tracking for Thai, which has no tracked forms', () => {
  const rules = cssRules(readRepoFile('src/client/app/landing.css'));
  const thaiResets = new Set(rules
    .filter((rule) => rule.declarations['letter-spacing'] === 'normal')
    .flatMap((rule) => rule.selector.split(',').map((selector) => selector.trim())));
  const tracked = rules
    .filter((rule) => rule.declarations['letter-spacing'] && rule.declarations['letter-spacing'] !== 'normal')
    .flatMap((rule) => rule.selector.split(',').map((selector) => selector.trim()));
  assert.ok(tracked.length > 0, 'landing.css has tracked text to check');
  for (const selector of tracked) {
    assert.ok(thaiResets.has(`${selector}${THAI_LANGUAGE_SELECTOR}`), `${selector} keeps letter-spacing in Thai`);
  }
});
