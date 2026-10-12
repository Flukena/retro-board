import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, FONT_COLORS, paletteColor } from './palette.js';
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
  const valid = { name: 'yellow', bg: '#fef3c7', border: '#f59e0b', zoneBg: 'rgba(251,191,36,0.12)' };
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
