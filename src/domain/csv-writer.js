// Shared CSV writer for every spreadsheet export (board zones, poker estimates).

// Spreadsheet apps run cells starting with these as formulas (CSV injection).
const CSV_FORMULA_PREFIX_PATTERN = /^\s*[=+\-@\t\r]/;
const CSV_QUOTE_REQUIRED_PATTERN = /[",\n\r]/;
// Excel needs the BOM to read UTF-8 (Thai text) correctly.
const CSV_BOM = '﻿';
const CSV_ROW_SEPARATOR = '\r\n';
const CSV_COLUMN_SEPARATOR = ',';

export const csvCell = (value) => {
  let text = value == null ? '' : String(value);
  if (CSV_FORMULA_PREFIX_PATTERN.test(text)) text = `'${text}`;
  return CSV_QUOTE_REQUIRED_PATTERN.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
};

export const csvRow = (cells) => cells.map(csvCell).join(CSV_COLUMN_SEPARATOR);

export const csvDocument = (rows) => CSV_BOM + rows.join(CSV_ROW_SEPARATOR);
