import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneTitleFontSize, zoneHeaderClearancePx } from './zone-title.js';

test('screen title defaults to 16px and preserves explicit sizes', () => {
  assert.equal(zoneTitleFontSize({}), 16);
  for (const fontSize of [10, 24, 48, 96]) assert.equal(zoneTitleFontSize({ fontSize }), fontSize);
});

test('clearance includes screen inset, fixed padding, title line and gap at zoom one', () => {
  for (const fontSize of [10, 16, 24, 48, 96]) {
    assert.equal(zoneHeaderClearancePx({ fontSize }), 14 + 12 + Math.max(fontSize, 11) * 1.35 + 8);
  }
});
