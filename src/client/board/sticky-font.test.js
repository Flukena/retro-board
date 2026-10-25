import test from 'node:test';
import assert from 'node:assert/strict';
import { stickyFontSize, stickyCreationFontSize } from './sticky-font.js';

test('missing sticky font defaults to 20 without changing stored values', () => {
  const item = Object.freeze({ type: 'sticky' });
  assert.equal(stickyFontSize(item), 20);
  for (const fontSize of [11, 15, 27, 96]) {
    assert.equal(stickyFontSize(Object.freeze({ fontSize })), fontSize);
  }
});

test('creation scales the 20px base with card width, keeping the existing 11px floor', () => {
  for (const [widthPx, expectedPx] of [[200, 20], [400, 40], [135, 14], [50, 11]]) {
    assert.equal(stickyCreationFontSize(widthPx), expectedPx);
  }
});
