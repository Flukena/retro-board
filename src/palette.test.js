import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, FONT_COLORS, paletteColor, paletteIndexByName } from './palette.js';
import * as palette from './palette.js';
import { contrastRatio, parseColor } from './color-contrast.js';
import { parseBoardCsv } from './csv-import.js';
import { normalizeImportManifest } from './import-schema.js';

test('palette order matches persisted indices through the public CSV API', () => {
  PALETTE.forEach((entry, index) => {
    const csv = `zone,text,author,votes,color,created at\n,Note,,0,${entry.name},`;
    const { payload } = parseBoardCsv(csv);
    assert.equal(payload.board.items.find((item) => item.type === 'sticky').color, index);
  });
});

test('palette length matches the public manifest color boundary', () => {
  const manifest = (color) => ({ board: { items: [{
    id: 'sticky', type: 'sticky', x: 0, y: 0, w: 200, h: 180, text: 'Note', color,
  }] } });
  const lastIndex = PALETTE.length - 1;
  assert.equal(normalizeImportManifest(manifest(lastIndex)).items[0].color, lastIndex);
  assert.throws(() => normalizeImportManifest(manifest(PALETTE.length)), /invalid color/);
});

test('palette entries validate their invariants and presets are frozen', () => {
  const valid = { name: 'yellow', bg: '#fef3c7', border: '#f59e0b', ink: '#92400e', zoneBg: 'rgba(251,191,36,0.12)' };
  assert.throws(() => paletteColor({ ...valid, zoneBg: 'rgba(300,0,0,0.1)' }), Error);
  for (const patch of [{ bg: '#fff' }, { border: 'red' }, { zoneBg: 'rgba(0,0,0,1.1)' }, { name: '' }, { name: 'Yellow' }]) {
    assert.throws(() => paletteColor({ ...valid, ...patch }), Error);
  }
  assert.ok(Object.isFrozen(paletteColor(valid)));
  for (const array of [PALETTE, FONT_COLORS]) {
    assert.ok(Object.isFrozen(array));
    assert.ok(array.every(Object.isFrozen));
  }
});

test('palette name lookup resolves known names and rejects unknown names', () => {
  for (const entry of PALETTE) {
    assert.equal(PALETTE[paletteIndexByName(entry.name)], entry);
  }
  for (const unknown of ['purpel', '', 'toString', undefined]) {
    assert.throws(() => paletteIndexByName(unknown), /Unknown palette name/);
  }
});

const MIN_TEXT_CONTRAST_RATIO = 4.5; // WCAG 2.2 SC 1.4.3.

test('sticky and zone inks meet AA contrast on every fixed pastel', () => {
  for (const entry of PALETTE) {
    assert.ok(contrastRatio(entry.ink, entry.bg) >= MIN_TEXT_CONTRAST_RATIO, entry.name);
  }
});

test('medal colors are frozen and meet AA contrast', () => {
  assert.ok(palette.MEDAL_COLORS);
  assert.ok(Object.isFrozen(palette.MEDAL_COLORS));
  assert.deepEqual(Object.keys(palette.MEDAL_COLORS), ['1', '2', '3']);
  for (const entry of Object.values(palette.MEDAL_COLORS)) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(contrastRatio(entry.fg, entry.bg) >= MIN_TEXT_CONTRAST_RATIO);
  }
});

test('zone RGB channels derive from the unchanged palette borders', () => {
  assert.deepEqual(PALETTE.map(({ name }) => name), ['yellow', 'red', 'green', 'blue', 'purple', 'orange']);
  for (const entry of PALETTE) {
    const { r, g, b } = parseColor(entry.border);
    assert.equal(entry.rgb, `${r},${g},${b}`);
  }
});

test('palette rejects missing and invalid ink', () => {
  const valid = { ...PALETTE[0] };
  for (const ink of [undefined, null, '', '#fff', 'red', '#zzzzzz']) {
    assert.throws(() => paletteColor({ ...valid, ink }), /ink/);
  }
});
