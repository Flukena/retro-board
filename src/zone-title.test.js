import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneTitleFontSize, zoneHeaderClearancePx } from './zone-title.js';

const DEFAULT_ZONE_TITLE_FONT_PX = 32;
const DEFAULT_ZONE_HEADER_CLEARANCE_PX = 77.2;
const REQUIRED_AUTO_MIN_FONT_PX = 20;
const REQUIRED_AUTO_MAX_FONT_PX = 32;
const REQUIRED_AUTO_FONT_STEP_PX = 2;
const REQUIRED_HEADER_INSET_PX = 14;
const REQUIRED_CHIP_VERTICAL_PADDING_PX = 12;
const REQUIRED_TITLE_LINE_HEIGHT_RATIO = 1.35;
const REQUIRED_HEADER_GAP_PX = 8;

test('missing geometry defaults to 32px and explicit sizes stay pinned', () => {
  assert.equal(zoneTitleFontSize({}), DEFAULT_ZONE_TITLE_FONT_PX);
  for (const fontSize of [10, 24, 48, 96]) {
    for (const [w, h] of [[300, 200], [600, 400], [960, 400]]) {
      assert.equal(zoneTitleFontSize({ fontSize, w, h }), fontSize);
    }
  }
});

test('null or zero fontSize is unset, so the title still auto-fits', () => {
  for (const fontSize of [null, 0]) {
    assert.equal(zoneTitleFontSize({ fontSize, w: 300, h: 400 }), REQUIRED_AUTO_MIN_FONT_PX);
    assert.equal(zoneTitleFontSize({ fontSize, w: 960, h: 400 }), REQUIRED_AUTO_MAX_FONT_PX);
  }
});

test('clearance includes screen inset, fixed padding, title line and gap at zoom one', () => {
  for (const fontSize of [10, 16, 24, 48, 96]) {
    assert.equal(zoneHeaderClearancePx({ fontSize }), 14 + 12 + Math.max(fontSize, 11) * 1.35 + 8);
  }
});

test('default title clearance reserves the 32px title line', () => {
  assert.equal(zoneHeaderClearancePx({}), DEFAULT_ZONE_HEADER_CLEARANCE_PX);
});

const AUTO_CASES = [[960, 400, 32], [600, 400, 24], [300, 400, 20], [960, 220, 22], [648, 400, 26]];

test('auto title fits the limiting dimension, floors to even pixels and drives clearance', () => {
  for (const [w, h, expectedFontPx] of AUTO_CASES) {
    assert.equal(zoneTitleFontSize({ w, h }), expectedFontPx);
    assert.equal(zoneHeaderClearancePx({ w, h }), REQUIRED_HEADER_INSET_PX + expectedFontPx * REQUIRED_TITLE_LINE_HEIGHT_RATIO
      + REQUIRED_CHIP_VERTICAL_PADDING_PX + REQUIRED_HEADER_GAP_PX);
  }
});

test('auto title stays bounded, even and non-decreasing in each dimension', () => {
  const dimensionsPx = [100, 200, 220, 300, 400, 600, 648, 960, 1200];
  for (const fixedDimensionPx of dimensionsPx) {
    for (const dimension of ['w', 'h']) {
      let previousFontPx = REQUIRED_AUTO_MIN_FONT_PX;
      for (const growingDimensionPx of dimensionsPx) {
        const item = { w: fixedDimensionPx, h: fixedDimensionPx, [dimension]: growingDimensionPx };
        const fontPx = zoneTitleFontSize(item);
        assert.ok(fontPx >= REQUIRED_AUTO_MIN_FONT_PX && fontPx <= REQUIRED_AUTO_MAX_FONT_PX);
        assert.equal(fontPx % REQUIRED_AUTO_FONT_STEP_PX, 0);
        assert.ok(fontPx >= previousFontPx);
        previousFontPx = fontPx;
      }
    }
  }
});

test('missing or non-finite dimensions use the maximum auto size', () => {
  for (const invalidDimension of [undefined, NaN, Infinity, -Infinity]) {
    assert.equal(zoneTitleFontSize({ w: invalidDimension, h: 200 }), 32);
    assert.equal(zoneTitleFontSize({ w: 300, h: invalidDimension }), 32);
  }
});
