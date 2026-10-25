import test from 'node:test';
import assert from 'node:assert/strict';
import { csvLabels } from './csv-labels.js';
import { getLang, setLang } from '../ui/i18n.js';

test('CSV label snapshot follows the language at export time', () => {
  const original = getLang();
  try {
    setLang('en');
    const english = csvLabels();
    assert.equal(english.text, 'Text');
    setLang('th');
    assert.equal(english.untitledZone, '(untitled zone)');
    assert.equal(csvLabels().untitledZone, '(โซนไม่มีชื่อ)');
    assert.equal(english.text, 'Text');
  } finally { setLang(original); }
});
