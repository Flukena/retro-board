import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PDF_PAGE_HEIGHT_PT, PDF_PAGE_MARGIN_PT, PDF_PAGE_WIDTH_PT, createImagePdf, pdfImagePlacement,
} from './pdf-image-document.js';

// Any bytes work for structure checks; real JPEG markers make the stream realistic.
const FAKE_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const asText = (bytes) => Array.from(bytes, byte => String.fromCharCode(byte)).join('');

test('the document has a PDF header, one page and an EOF marker', () => {
  const text = asText(createImagePdf(FAKE_JPEG, 1600, 900));
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.endsWith('%%EOF\n'));
  assert.match(text, /\/Type \/Pages \/Kids \[3 0 R\] \/Count 1/);
  assert.match(text, /\/Width 1600 \/Height 900 .*\/Filter \/DCTDecode \/Length 10 /);
});

test('every xref offset points at the start of its object, and startxref at the table', () => {
  const text = asText(createImagePdf(FAKE_JPEG, 640, 480));
  const xrefStart = Number(/startxref\n(\d+)\n/.exec(text)[1]);
  assert.ok(text.startsWith('xref\n', xrefStart));
  const entries = [...text.slice(xrefStart).matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
  assert.equal(entries.length, 5);
  entries.forEach((offset, index) => assert.ok(text.startsWith(`${index + 1} 0 obj\n`, offset), `object ${index + 1}`));
  assert.match(text, /trailer\n<< \/Size 6 \/Root 1 0 R >>/);
});

test('the JPEG bytes are embedded unchanged', () => {
  const pdf = createImagePdf(FAKE_JPEG, 10, 10);
  const text = asText(pdf);
  const start = text.indexOf('stream\n') + 'stream\n'.length;
  assert.deepEqual(pdf.slice(start, start + FAKE_JPEG.length), FAKE_JPEG);
});

test('the image is scaled to fit inside the page margins and centred', () => {
  const wide = pdfImagePlacement(4000, 1000);
  assert.equal(wide.w, PDF_PAGE_WIDTH_PT - PDF_PAGE_MARGIN_PT * 2);
  assert.equal(wide.x, PDF_PAGE_MARGIN_PT);
  assert.ok(Math.abs(wide.y * 2 + wide.h - PDF_PAGE_HEIGHT_PT) < 0.02);
  const tall = pdfImagePlacement(500, 2000);
  assert.equal(tall.h, PDF_PAGE_HEIGHT_PT - PDF_PAGE_MARGIN_PT * 2);
  assert.ok(Math.abs(tall.x * 2 + tall.w - PDF_PAGE_WIDTH_PT) < 0.02);
});
