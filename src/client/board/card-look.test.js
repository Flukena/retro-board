import test from 'node:test';
import assert from 'node:assert/strict';
import { stickyClassName, stickyShadowClass, stickyCardVars, zoneCardVars, medalLook } from './card-look.js';
import { PALETTE, MEDAL_COLORS } from '../ui/palette.js';
import { parseColor } from '../ui/color-contrast.js';

const WINNER_RANKS = [1, 2, 3];

const SHADOW_CASES = [
  [false, false, false, 'rb-sticky--shadow-default'],
  [false, false, true, 'rb-sticky--shadow-flat'],
  [false, true, false, 'rb-sticky--shadow-winner'],
  [false, true, true, 'rb-sticky--shadow-winner'],
  [true, false, false, ''],
  [true, false, true, ''],
  [true, true, false, ''],
  [true, true, true, ''],
];

test('one sticky shadow follows remote > winner > dense > default for every combination', () => {
  for (const [remoteSelected, winner, dense, expected] of SHADOW_CASES) {
    const result = stickyShadowClass({ remoteSelected, winner, dense });
    assert.equal(result, expected);
    assert.ok(!result.includes(' '), 'multiple competing modifiers are forbidden');
  }
});

const STICKY_ITEM_VARS = ['--rb-card-bg', '--rb-card-ink'];
const ZONE_ITEM_VARS = ['--rb-zone-bg', '--rb-zone-border-w', '--rb-zone-ink', '--rb-zone-rgb'];

test('sticky vars contain only the two documented per-item palette colors', () => {
  for (const entry of PALETTE) {
    const vars = stickyCardVars(entry);
    assert.deepEqual(Object.keys(vars).sort(), STICKY_ITEM_VARS);
    assert.equal(vars['--rb-card-bg'], entry.bg);
    assert.equal(vars['--rb-card-ink'], entry.ink);
  }
});

test('zone vars follow the palette and derive RGB channels from its border', () => {
  for (const entry of PALETTE) {
    const vars = zoneCardVars(entry);
    const { r, g, b } = parseColor(entry.border);
    assert.deepEqual(Object.keys(vars).sort(), ZONE_ITEM_VARS);
    assert.equal(vars['--rb-zone-bg'], entry.bg);
    assert.equal(vars['--rb-zone-ink'], entry.ink);
    assert.equal(vars['--rb-zone-rgb'], `${r},${g},${b}`);
    assert.equal(vars['--rb-zone-border-w'], '2px', 'the title seam requires the existing 2px border');
  }
});

test('sticky class names include selection and exactly the permitted shadow without empty slots', () => {
  for (const [remoteSelected, winner, dense, expectedShadow] of SHADOW_CASES) {
    for (const selected of [false, true]) {
      const result = stickyClassName({ selected, remoteSelected, winner, dense });
      const classes = result.split(' ');
      assert.equal(classes[0], 'rb-sticky');
      assert.equal(classes.includes('rb-sticky--selected'), selected);
      assert.equal(classes.includes('rb-remote-selected-card'), remoteSelected);
      assert.deepEqual(classes.filter(name => name.startsWith('rb-sticky--shadow-')),
        expectedShadow ? [expectedShadow] : []);
      assert.ok(classes.every(Boolean), 'no empty class slots');
      assert.equal(new Set(classes).size, classes.length);
    }
  }
});

test('medal variables represent only the three supported ranks', () => {
  for (const rank of WINNER_RANKS) {
    assert.deepEqual(medalLook(rank), {
      '--rb-medal-bg': MEDAL_COLORS[rank].bg, '--rb-medal-fg': MEDAL_COLORS[rank].fg,
    });
  }
  for (const rank of [null, undefined, 0, 4, -1, 1.5, '1', NaN]) {
    assert.equal(medalLook(rank), null);
  }
});
