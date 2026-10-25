import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidFontColor, isValidFontSize, isValidZIndex, safeSnapshotAppearance } from './item-appearance.js';
import { IMPORT_FONT_SIZE_MAX } from './security-boundaries.js';
import { normalizeImportManifest, validateBoardItem } from './import-schema.js';

test('font sizes keep the shared positive finite import bound', () => {
  for (const value of [0.5, 24, IMPORT_FONT_SIZE_MAX]) assert.equal(isValidFontSize(value), true);
  for (const value of [undefined, null, '24', 0, -1, NaN, Infinity, IMPORT_FONT_SIZE_MAX + 1]) {
    assert.equal(isValidFontSize(value), false);
  }
});

test('font colors accept exactly six hexadecimal digits with a leading hash', () => {
  assert.equal(isValidFontColor('#aBc123'), true);
  for (const value of [undefined, null, 123, '#abc', '#abcdef12', 'abcdef', 'red', 'url(tracker)']) {
    assert.equal(isValidFontColor(value), false);
  }
});

test('z-index validation permits finite fractional order and respects a caller-provided import limit', () => {
  for (const value of [0, -2.5, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    assert.equal(isValidZIndex(value), true);
  }
  for (const value of [undefined, null, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isValidZIndex(value), false);
  }
  assert.equal(isValidZIndex(9, 9), true);
  assert.equal(isValidZIndex(-9, 9), true);
  assert.equal(isValidZIndex(10, 9), false);
});

test('snapshot appearance normalizes color, preserves explicit order and exposes only display fields', () => {
  assert.deepEqual(safeSnapshotAppearance({
    fontSize: 32, fontColor: '#ABC123', zIndex: -2.5, createdAt: 1234,
    authorId: 'private-author', text: 'private-text', src: 'https://tracker.example',
  }), { fontSize: 32, fontColor: '#abc123', zIndex: -2.5 });
});

test('snapshot stacking uses creation order only when explicit z-index is absent', () => {
  assert.deepEqual(safeSnapshotAppearance({ createdAt: 42 }), { zIndex: 42 });
  assert.deepEqual(safeSnapshotAppearance({ zIndex: null, createdAt: 42 }), { zIndex: 42 });
  assert.deepEqual(safeSnapshotAppearance({ zIndex: 0, createdAt: 42 }), { zIndex: 0 });
  assert.deepEqual(safeSnapshotAppearance({ zIndex: NaN, createdAt: 42 }), {});
  assert.deepEqual(safeSnapshotAppearance({ createdAt: Infinity, fontColor: 'red', fontSize: 0 }), {});
  assert.deepEqual(safeSnapshotAppearance({}), {});
});

test('strict imports retain appearance rejection messages and their smaller reserved z-index limit', () => {
  const item = { id: 'card', type: 'sticky', x: 0, y: 0, text: 'Visible' };
  for (const [field, value] of [['fontSize', 0], ['fontColor', '#abc'], ['zIndex', Infinity]]) {
    assert.throws(() => normalizeImportManifest({ board: { items: [{ ...item, [field]: value }] } }),
      { message: `item card has an invalid ${field}` });
  }
  const reservedZIndex = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(isValidZIndex(reservedZIndex), true);
  assert.doesNotThrow(() => validateBoardItem({ ...item, zIndex: reservedZIndex }));
  assert.throws(() => normalizeImportManifest({ board: { items: [{ ...item, zIndex: reservedZIndex }] } }),
    { message: 'item card has an invalid zIndex' });
  const appearance = { fontSize: IMPORT_FONT_SIZE_MAX, fontColor: '#ABC123', zIndex: -2.5 };
  const normalized = normalizeImportManifest({ board: { items: [{ ...item, ...appearance }] } }).items[0];
  assert.equal(normalized.fontSize, IMPORT_FONT_SIZE_MAX);
  assert.equal(normalized.fontColor, '#abc123');
  assert.equal(normalized.zIndex, -2.5);
});
