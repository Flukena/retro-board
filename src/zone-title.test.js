import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZONE_TITLE_DEFAULT_FONT_PX, ZONE_TITLE_LINE_HEIGHT_RATIO,
  ZONE_CHIP_PADDING_VERTICAL_EM, ZONE_TITLE_BODY_GAP_EM,
  zoneTitleFontSize, zoneTitleHeight,
} from './zone-title.js';

test('zones without a font size use 24px and explicit sizes are preserved', () => {
  assert.equal(ZONE_TITLE_DEFAULT_FONT_PX, 24);
  assert.equal(zoneTitleFontSize({}), 24);
  for (const fontSize of [10, 16, 24, 48, 96]) {
    assert.equal(zoneTitleFontSize({ fontSize }), fontSize);
  }
});

test('header contains the chip and body clearance and grows monotonically', () => {
  let previousHeight = 0;
  for (const fontSize of [10, 16, 24, 48, 96]) {
    const chipHeight = fontSize * (ZONE_TITLE_LINE_HEIGHT_RATIO + 2 * ZONE_CHIP_PADDING_VERTICAL_EM);
    const height = zoneTitleHeight({ fontSize });
    assert.ok(height >= chipHeight);
    assert.equal(height - chipHeight, fontSize * ZONE_TITLE_BODY_GAP_EM);
    assert.equal(height, fontSize * 2.5);
    assert.ok(height > previousHeight);
    previousHeight = height;
  }
  assert.equal(zoneTitleHeight({}), 60);
});
