import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { LOCALE_LOADERS } from '../i18n.js';

const LOCALE_CODES = ['th', 'en', ...Object.keys(LOCALE_LOADERS)];
const areaFiles = (code) => readdirSync(new URL(`./${code}/`, import.meta.url)).sort();

async function areaKeys(code, file) {
  const sections = await import(`./${code}/${file}`);
  const keys = Object.values(sections).flatMap((section) => Object.keys(section));
  assert.equal(new Set(keys).size, keys.length, `${code}/${file}: no repeated keys`);
  return keys.sort();
}

test('every locale has matching area files and each area covers the English keys', async () => {
  const files = areaFiles('en');
  for (const code of LOCALE_CODES) {
    assert.deepEqual(areaFiles(code), files, `${code}: area files`);
    for (const file of files) {
      assert.deepEqual(await areaKeys(code, file), await areaKeys('en', file), `${code}/${file}: key set`);
    }
  }
});

test('locale indexes assemble every area key exactly once', async () => {
  for (const code of LOCALE_CODES) {
    const keys = [];
    for (const file of areaFiles(code)) keys.push(...await areaKeys(code, file));
    assert.equal(new Set(keys).size, keys.length, `${code}: no overlap between areas`);
    const { default: dictionary } = await import(`./${code}.js`);
    assert.deepEqual(Object.keys(dictionary).sort(), keys.sort(), `${code}: assembled keys`);
  }
});
