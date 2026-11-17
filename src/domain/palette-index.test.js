import test from 'node:test';
import assert from 'node:assert/strict';
import { isPaletteIndex } from './palette-index.js';

test('isPaletteIndex accepts the first and last palette index', () => {
  assert.equal(isPaletteIndex(0), true);
  assert.equal(isPaletteIndex(5), true);
});

test('isPaletteIndex rejects out-of-range, fractional, string and NaN values', () => {
  for (const value of [6, -1, 1.5, '1', Number.NaN]) assert.equal(isPaletteIndex(value), false);
});
