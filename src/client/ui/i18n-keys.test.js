import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LANGUAGE_OPTIONS, LOCALE_LOADERS } from './i18n.js';
import th from './locales/th.js';
import en from './locales/en.js';

const SOURCE_ROOT = new URL('../../../', import.meta.url);
const STATIC_TRANSLATION_CALL = /\bt\(\s*(['"])([^'"\n]+)\1/g;
const dictionaries = { th, en };

function sourcePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) return sourcePaths(new URL(`${entry.name}/`, directory));
    return /\.jsx?$/.test(entry.name) ? [path] : [];
  });
}

test('every language in the picker has a dictionary and every on-demand loader resolves to its own locale', async () => {
  const offered = LANGUAGE_OPTIONS.map(({ code }) => code).sort();
  assert.deepEqual([...Object.keys(dictionaries), ...Object.keys(LOCALE_LOADERS)].sort(), offered);
  for (const [code, load] of Object.entries(LOCALE_LOADERS)) {
    const canonical = await import(`./locales/${code}.js`);
    assert.equal((await load()).default, canonical.default, code);
  }
});

test('Thai and English dictionaries have identical key sets', () => {
  assert.deepEqual(Object.keys(dictionaries.th).sort(), Object.keys(dictionaries.en).sort());
});

test('every static translation call has a Thai and English dictionary entry', () => {
  const paths = [new URL('RetroBoard.jsx', SOURCE_ROOT), ...sourcePaths(new URL('src/', SOURCE_ROOT))];
  const missing = [];
  for (const path of paths) {
    const source = readFileSync(path, 'utf8');
    for (const [, , key] of source.matchAll(STATIC_TRANSLATION_CALL)) {
      for (const language of ['th', 'en']) {
        if (!Object.hasOwn(dictionaries[language], key)) missing.push(`${path.pathname}: ${language}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

const PLACEHOLDER = /\{[a-zA-Z]+\}/g;
const placeholdersOf = (value) => [...new Set(String(value).match(PLACEHOLDER) ?? [])].sort();

test('every on-demand language has exactly the English keys and keeps their placeholders', async () => {
  const lazyCodes = Object.keys(LOCALE_LOADERS);
  assert.ok(lazyCodes.length > 0);
  const englishKeys = Object.keys(dictionaries.en).sort();
  for (const code of lazyCodes) {
    const { default: locale } = await import(`./locales/${code}.js`);
    assert.deepEqual(Object.keys(locale).sort(), englishKeys, `${code}: key set`);
    // Keep every English placeholder; use no token the code never passes (English or Thai may omit one, e.g. "1 card").
    const mismatched = englishKeys.filter((key) => {
      const allowed = new Set([...placeholdersOf(dictionaries.en[key]), ...placeholdersOf(dictionaries.th[key])]);
      const used = placeholdersOf(locale[key]);
      return placeholdersOf(dictionaries.en[key]).some((token) => !used.includes(token)) || used.some((token) => !allowed.has(token));
    });
    assert.deepEqual(mismatched, [], `${code}: placeholders`);
    const untranslated = englishKeys.filter((key) => typeof locale[key] !== 'string' || !locale[key].trim());
    assert.deepEqual(untranslated, [], `${code}: empty values`);
  }
});


// The browser-storage paragraph is one line per fact: what is kept, the signed-in hint, then how to remove it.
const PRIVACY_BROWSER_KEY = 'legal.privacy.browser.body';
const PRIVACY_BROWSER_LINES = Object.freeze({ STORED: 0, SIGNED_IN_HINT: 1, REMOVAL: 2 });

test('every language lists the signed-in hint in the browser-storage paragraph and keeps the removal line last', async () => {
  const lazyCodes = Object.keys(LOCALE_LOADERS);
  const bodies = { th: dictionaries.th[PRIVACY_BROWSER_KEY], en: dictionaries.en[PRIVACY_BROWSER_KEY] };
  for (const code of lazyCodes) bodies[code] = (await import(`./locales/${code}.js`)).default[PRIVACY_BROWSER_KEY];
  const lineCount = Object.keys(PRIVACY_BROWSER_LINES).length;
  for (const [code, body] of Object.entries(bodies)) {
    const lines = body.split('\n');
    assert.equal(lines.length, lineCount, `${code}: one line per fact`);
    assert.ok(lines.every((line) => line.trim()), `${code}: no empty line`);
    assert.equal(new Set(lines).size, lineCount, `${code}: the lines say different things`);
  }
  // Only the signed-in line may mention signing in, so the removal line stays the closing line.
  const english = bodies.en.split('\n');
  assert.match(english[PRIVACY_BROWSER_LINES.SIGNED_IN_HINT], /sign/i);
  assert.doesNotMatch(english[PRIVACY_BROWSER_LINES.REMOVAL], /sign/i);
  assert.match(english[PRIVACY_BROWSER_LINES.REMOVAL], /remove/i);
});
