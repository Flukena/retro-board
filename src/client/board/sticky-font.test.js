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

test('a sticky created in a huge zone stays at most 300px wide with its font scaled to match', async () => {
  const { stickyCreationSize } = await import('./sticky-font.js');
  const size = stickyCreationSize({ w: 4_800, h: 4_800 });
  assert.equal(size.w, 300);
  assert.equal(size.fontSize, 30);
  assert.equal(Math.round(size.w / size.h * 100), Math.round(200 / 180 * 100));
});

test('a sticky in a default zone keeps its zone-relative size, and one outside a zone keeps the default', async () => {
  const { stickyCreationSize } = await import('./sticky-font.js');
  const inZone = stickyCreationSize({ w: 1_200, h: 1_080 });
  assert.ok(inZone.w > 120 && inZone.w < 300, `w=${inZone.w}`);
  assert.equal(inZone.fontSize, stickyCreationFontSize(inZone.w));
  assert.deepEqual(stickyCreationSize(null), { w: 200, h: 180 });
});
