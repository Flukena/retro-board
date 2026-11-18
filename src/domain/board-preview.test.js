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

// The rule: keep the MAX_PREVIEW_ZONES largest zones by area, ties going to the earlier item, and return them in input order.
const OVER_CAP_ZONES = MAX_PREVIEW_ZONES + 6;
// Side lengths 1..OVER_CAP_ZONES in a fixed scrambled order, so "input order" and "sorted by area" give different answers.
const SCRAMBLE_STEP = 7;
const scrambledSides = Array.from({ length: OVER_CAP_ZONES }, (_, i) => ((i * SCRAMBLE_STEP) % OVER_CAP_ZONES) + 1);

test('over the cap, the largest zones are kept and returned in input order, not area order', () => {
  const items = scrambledSides.map((side, i) => zone({ x: i, w: side, h: side }));
  const smallestKeptSide = OVER_CAP_ZONES - MAX_PREVIEW_ZONES + 1;
  const expected = items.filter((item) => item.w >= smallestKeptSide).map(({ x, y, w, h, color }) => ({ x, y, w, h, color }));
  assert.equal(expected.length, MAX_PREVIEW_ZONES);
  const { zones } = boardPreviewFromItems(items);
  assert.deepEqual(zones, expected);
  assert.notDeepEqual(zones.map((z) => z.w), [...zones.map((z) => z.w)].sort((a, b) => b - a), 'the fixture tells the orders apart');
});

test('zones of equal area competing for the last places go to the earlier items', () => {
  const LARGE_COUNT = MAX_PREVIEW_ZONES - 2;
  const LARGE_SIDE_PX = 200;
  const TIED_SIDE_PX = 50;
  const TIED_COUNT = 4;
  const large = Array.from({ length: LARGE_COUNT }, (_, i) => zone({ x: i, w: LARGE_SIDE_PX + i, h: LARGE_SIDE_PX }));
  const tied = Array.from({ length: TIED_COUNT }, (_, i) => zone({ x: 1000 + i, w: TIED_SIDE_PX, h: TIED_SIDE_PX }));
  // Tied zones sit before, between and after the large ones.
  const items = [tied[0], ...large.slice(0, 10), tied[1], tied[2], ...large.slice(10), tied[3]];
  const kept = new Set([...large, tied[0], tied[1]]);
  const { zones } = boardPreviewFromItems(items);
  assert.deepEqual(zones.map((z) => z.x), items.filter((item) => kept.has(item)).map((item) => item.x));
});

test('a valid zone among invalid items is the only one kept', () => {
  const valid = zone({ x: 5, y: 6, w: 70, h: 80, color: 1 });
  const items = [zone({ w: '100' }), null, valid, zone({ h: '100' }), undefined, { type: 'zone' }, zone({ x: Number.POSITIVE_INFINITY })];
  assert.deepEqual(boardPreviewFromItems(items), { zones: [{ x: 5, y: 6, w: 70, h: 80, color: 1 }] });
});

test('non-zone items and empty input give null', () => {
  assert.equal(boardPreviewFromItems([{ type: 'sticky', x: 0, y: 0 }, { type: 'sticky', x: 5, y: 5 }]), null);
  assert.equal(boardPreviewFromItems([]), null);
});
