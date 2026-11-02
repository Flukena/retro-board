import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { LANGUAGE_OPTIONS } from './i18n.js';

const SOURCE_ROOT = new URL('../../../', import.meta.url);
const STATIC_TRANSLATION_CALL = /\bt\(\s*(['"])([^'"\n]+)\1/g;
const dictionarySource = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
const dictionaryStart = dictionarySource.indexOf('const dict = ') + 'const dict = '.length;
const dictionaryEnd = dictionarySource.indexOf('\n};', dictionaryStart) + '\n}'.length;
const dictionaries = runInNewContext(`(${dictionarySource.slice(dictionaryStart, dictionaryEnd)})`);

function sourcePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) return sourcePaths(new URL(`${entry.name}/`, directory));
    return /\.jsx?$/.test(entry.name) ? [path] : [];
  });
}

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
  const lazyCodes = LANGUAGE_OPTIONS.map(({ code }) => code).filter((code) => !Object.hasOwn(dictionaries, code));
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

