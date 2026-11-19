import test from 'node:test';
import assert from 'node:assert/strict';
import { backupDoneNotice, flattenedIdList } from './export-notice.js';
import { setLang } from '../ui/i18n.js';

const NO_REPAIRS = { positions: 0, zoneDimensions: 0 };
const FILE = 'retro-ABC.zip';

test('the toast names the flattened images instead of the plain done message', () => {
  setLang('en');
  const { msg, type } = backupDoneNotice({ fileName: FILE, geometryRepairs: NO_REPAIRS, flattenedImageIds: ['a', 'b'] });
  assert.equal(type, 'info');
  assert.equal(msg, `Downloaded ${FILE} — 2 animated or oversized image(s) were saved as still images (a, b)`);
});

test('without flattened images the plain done message is kept', () => {
  setLang('en');
  assert.equal(backupDoneNotice({ fileName: FILE, geometryRepairs: NO_REPAIRS, flattenedImageIds: [] }).msg, `Downloaded ${FILE}`);
  assert.equal(backupDoneNotice({ fileName: FILE, geometryRepairs: NO_REPAIRS }).msg, `Downloaded ${FILE}`);
});

test('repaired geometry is appended when images were flattened too, and the Thai text renders', () => {
  setLang('en');
  const both = backupDoneNotice({ fileName: FILE, geometryRepairs: { positions: 3, zoneDimensions: 1 }, flattenedImageIds: ['a'] }).msg;
  assert.match(both, /1 animated or oversized image\(s\)/);
  assert.match(both, /repositioned 3 item\(s\)/);
  setLang('th');
  assert.match(backupDoneNotice({ fileName: FILE, geometryRepairs: NO_REPAIRS, flattenedImageIds: ['a'] }).msg, /แปลงเป็นภาพนิ่ง \(a\)/);
  setLang('en');
});

test('the id list shows the first five and counts the rest', () => {
  assert.equal(flattenedIdList(['1', '2', '3', '4', '5']), '1, 2, 3, 4, 5');
  assert.equal(flattenedIdList(['1', '2', '3', '4', '5', '6', '7']), '1, 2, 3, 4, 5, +2');
});
