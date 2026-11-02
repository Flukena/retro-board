import test from 'node:test';
import assert from 'node:assert/strict';

import { csvCell, csvDocument, csvRow } from './csv-writer.js';

test('cells that a spreadsheet would run as formulas are neutralised', () => {
  for (const formula of ['=SUM(A1)', '+1', '-2', '@cmd', ' =1']) {
    assert.equal(csvCell(formula).startsWith("'"), true, formula);
  }
});

test('cells with separators, quotes or line breaks are quoted per RFC 4180', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(8), '8');
});

test('a document starts with a UTF-8 BOM and separates rows with CRLF', () => {
  const contents = csvDocument([csvRow(['story', 'estimate']), csvRow(['งาน ก', 5])]);
  assert.equal(contents, '﻿story,estimate\r\nงาน ก,5');
});
