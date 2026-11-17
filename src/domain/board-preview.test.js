import test from 'node:test';
import assert from 'node:assert/strict';
import { boardPreviewFromItems, MAX_PREVIEW_ZONES } from './board-preview.js';

const zone = (overrides = {}) => ({ type: 'zone', x: 0, y: 0, w: 100, h: 100, color: 0, ...overrides });

test('keeps only geometry and colour of valid zones', () => {
  const result = boardPreviewFromItems([
    zone({ x: 10, y: 20, w: 300, h: 200, color: 2, title: 'private retro text', text: 'x' }),
  ]);
  assert.deepEqual(result, { zones: [{ x: 10, y: 20, w: 300, h: 200, color: 2 }] });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('skips zones whose geometry fails the board rules', () => {
  const result = boardPreviewFromItems([
    zone({ x: Number.NaN }), zone({ w: 0 }), zone({ h: -1 }),
    zone({ x: 10_000_001 }), zone({ w: 100_001 }),
  ]);
  assert.equal(result, null);
});

test('colour outside the palette falls back to the default index', () => {
  for (const color of [6, -1, 1.5, 'red', undefined]) {
    assert.equal(boardPreviewFromItems([zone({ color })]).zones[0].color, 0);
  }
  assert.equal(boardPreviewFromItems([zone({ color: 5 })]).zones[0].color, 5);
});

test('caps at MAX_PREVIEW_ZONES keeping the largest by area', () => {
  const items = Array.from({ length: 30 }, (_, i) => zone({ w: i + 1, h: i + 1 }));
  const { zones } = boardPreviewFromItems(items);
  assert.equal(zones.length, MAX_PREVIEW_ZONES);
  assert.equal(Math.min(...zones.map((z) => z.w)), 7);
  assert.deepEqual(zones.map((z) => z.w), [...zones.map((z) => z.w)].sort((a, b) => a - b));
});

test('non-zone items and empty input give null', () => {
  assert.equal(boardPreviewFromItems([{ type: 'sticky', x: 0, y: 0 }, { type: 'sticky', x: 5, y: 5 }]), null);
  assert.equal(boardPreviewFromItems([]), null);
});
