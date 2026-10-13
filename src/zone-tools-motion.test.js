import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOKENS } from './theme.js';
import * as layout from './zone-header-layout.js';
import { PALETTE } from './palette.js';
import { ZONE_TOOLS_EXIT_DURATION_MS, ZONE_POPUP_MOTION_DURATION_MS } from './usePresence.js';

const REQUIRED_TOOLS_BASE_FONT_PX = 32;

const css = readFileSync(new URL('./board-cards.css', import.meta.url), 'utf8');
test('inline breakpoint fits the chip, palette, size value, tools and admin icons using theme tokens', () => {
  for (const tokens of Object.values(TOKENS)) {
    const px = (key) => {
      const match = tokens[key].match(/^calc\(var\(--rb-zone-title-size\) \* ([\d.]+)\)$/);
      assert.ok(match, `${key} scales from the effective title size`);
      return Number(match[1]) * REQUIRED_TOOLS_BASE_FONT_PX;
    };
    for (const [key, expectedPx] of Object.entries({
      '--zone-icon-button-size': 36, '--zone-icon-size': 24, '--zone-strip-swatch-size': 18,
      '--zone-font-value-width': 32, '--zone-icon-gap': 2, '--zone-chip-min-width': 80, '--zone-chip-gap': 8,
    })) assert.equal(px(key), expectedPx);
    const gap = px('--zone-icon-gap');
    const button = px('--zone-icon-button-size');
    const palette = PALETTE.length * px('--zone-strip-swatch-size') + (PALETTE.length - 1) * gap;
    const font = 2 * button + px('--zone-font-value-width') + 2 * gap;
    const strip = palette + font + 6 * button + 7 * gap;
    const expected = px('--zone-chip-min-width') + px('--zone-chip-gap') + strip + 3 * button + 3 * gap;
    assert.equal(layout.ZONE_HEADER_INLINE_TOOLS_MIN_PX, expected);
  }
  assert.equal(layout.ZONE_HEADER_TOOLS_BASE_FONT_PX, REQUIRED_TOOLS_BASE_FONT_PX);
  assert.equal(layout.ZONE_HEADER_INLINE_TOOLS_MIN_EM, layout.ZONE_HEADER_INLINE_TOOLS_MIN_PX / REQUIRED_TOOLS_BASE_FONT_PX);
  assert.ok(css.includes(`@container rb-zone-header (width < ${layout.ZONE_HEADER_INLINE_TOOLS_MIN_EM}em)`));
  assert.match(css, /\.rb-zone__tool-strip, \.rb-zone__admin-action\s*\{ display: none; \}/);
  assert.match(css, /\.rb-zone__tool-popup\s*\{ display: flex; \}/);
  assert.match(css, /\.rb-zone__tool-popup\s*\{\s*display: none;/);
  assert.match(css, /\.rb-zone__tools \.rb-color-swatch\s*\{ box-sizing: border-box;/);
});
test('motion uses shared durations, reversible states, top-right popup origin and reduced-motion override', () => {
  for (const tokens of Object.values(TOKENS)) {
    assert.equal(tokens['--zone-tools-motion-duration'], `${ZONE_TOOLS_EXIT_DURATION_MS}ms`);
    assert.equal(tokens['--zone-popup-motion-duration'], `${ZONE_POPUP_MOTION_DURATION_MS}ms`);
    assert.equal(tokens['--zone-tools-slide-distance'], '8px');
    assert.equal(tokens['--zone-popup-enter-scale'], '0.92');
  }
  assert.match(css, /\.rb-zone__tool-strip\[data-state="open"\]/);
  assert.match(css, /\.rb-zone__tool-popup\[data-state="open"\]/);
  assert.match(css, /transform-origin: top right/);
  assert.match(css, /transform: translateX\(var\(--zone-tools-slide-distance\)\)/);
  assert.match(css, /transform: scale\(var\(--zone-popup-enter-scale\)\)/);
  for (const duration of ['--zone-tools-motion-duration', '--zone-popup-motion-duration']) {
    assert.ok(css.includes(`transition: opacity var(${duration}) var(--zone-motion-easing), transform var(${duration}) var(--zone-motion-easing)`));
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/);
  assert.match(css, /\.rb-zone__menu\[aria-expanded="true"\] \.rb-zone__menu-close/);
});
