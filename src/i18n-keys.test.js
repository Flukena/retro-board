import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const SOURCE_ROOT = new URL('../', import.meta.url);
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
