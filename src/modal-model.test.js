import test from 'node:test';
import assert from 'node:assert/strict';
import { pinValidity, sanitizePin, importWarningNotes } from './modal-model.js';

test('PIN accepts only four through eight digits and setting requires matching confirmation', () => {
  for (const pin of ['123', '123456789', 'abcd', '123a', '１２３４']) {
    assert.equal(pinValidity(pin, pin, true).valid, false);
  }
  for (const pin of ['1234', '12345678']) {
    assert.deepEqual(pinValidity(pin, pin, true), { valid: true, matches: true });
    assert.equal(pinValidity(pin, '4321', true).matches, false);
    assert.equal(pinValidity(pin, '', false).matches, true);
  }
  assert.equal(sanitizePin('1a234567890'), '12345678');
});

test('import warnings independently describe CSV loss and geometry repairs', () => {
  assert.deepEqual(importWarningNotes({}), []);
  assert.deepEqual(importWarningNotes({ sourceFormat: 'csv' }), [
    { key: 'import.csv.warning', params: { votes: 0, skipped: 0 } },
  ]);
  const warnings = importWarningNotes({
    sourceFormat: 'csv', csvSummary: { voteCountLost: 7, skippedRows: 2 },
    geometryRepairs: { positions: 3, zoneDimensions: 4 },
  });
  assert.deepEqual(warnings, [
    { key: 'import.csv.warning', params: { votes: 7, skipped: 2 } },
    { key: 'import.geometry.warning', params: { positions: 3, zones: 4 } },
  ]);
});
