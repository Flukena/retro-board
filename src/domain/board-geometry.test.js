import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GEOMETRY_SOURCE,
  sizeForPlacement, sizeForResize, sizeForGroupBounds, sizeForStickySignature,
  geometryErrorForBoard,
  geometryErrorForItem,
  geometryErrorForPatch,
  repairBoardGeometry,
} from './board-geometry.js';

test('trusted room repair converts every invalid coordinate pair into durable patches', () => {
  const items = [
    { id: 'valid', type: 'sticky', x: 10, y: 20, w: 200, h: 180 },
    { id: 'nulls', type: 'sticky', x: null, y: null, w: 200, h: 180 },
    { id: 'partial', type: 'image', x: 50, y: undefined, w: 100, h: 100 },
    { id: 'zone', type: 'zone', x: Number.NaN, y: 5, w: 0, h: null },
  ];

  const repaired = repairBoardGeometry(items, { source: GEOMETRY_SOURCE.STORED_ROOM });

  assert.deepEqual(repaired.repairs, { positions: 3, zoneDimensions: 1 });
  assert.equal(repaired.patchEntries.length, 3);
  assert.deepEqual(repaired.items[0], items[0]);
  assert.ok(repaired.items.every((item) => geometryErrorForItem(item) == null));
  assert.equal(Number.isNaN(items[3].x), true);
});

test('legacy import repairs omitted geometry but leaves explicit invalid values for rejection', () => {
  const items = [
    { id: 'anchor', type: 'sticky', x: 0, y: 0, w: 200, h: 180 },
    { id: 'omitted', type: 'zone', title: 'Recover me' },
    { id: 'explicit-null', type: 'sticky', x: null, y: null, w: 200, h: 180 },
  ];

  const repaired = repairBoardGeometry(items, { source: GEOMETRY_SOURCE.LEGACY_IMPORT });

  assert.deepEqual(repaired.repairs, { positions: 1, zoneDimensions: 1 });
  assert.equal(geometryErrorForItem(repaired.items[1]), null);
  assert.equal(
    geometryErrorForItem(repaired.items[2]),
    'item explicit-null has invalid coordinates',
  );
});

test('write guards reject corrupt creates, patches, and snapshots before storage mutation', () => {
  const valid = { id: 'sticky-1', type: 'sticky', x: 10, y: 20, w: 200, h: 180 };

  assert.equal(geometryErrorForPatch(valid, { color: 2 }), null);
  assert.equal(
    geometryErrorForPatch(valid, { x: null }),
    'item sticky-1 has invalid coordinates',
  );
  assert.equal(
    geometryErrorForBoard([valid, { id: 'zone-1', type: 'zone', x: 0, y: 0, w: 0, h: 100 }]),
    'zone zone-1 has invalid dimensions',
  );
});

const FOOTPRINT_CASES = [
  ['sticky', { w: 200, h: 180 }, { w: 200, h: 180 }, { w: 200, h: 180 }],
  ['text', { w: 400, h: 80 }, { w: 400, h: 80 }, { w: 400, h: 80 }],
  ['image', { w: 200, h: 200 }, { w: 200, h: 200 }, { w: 200, h: 200 }],
  ['zone', { w: 1200, h: 1080 }, { w: 200, h: 200 }, { w: 0, h: 0 }],
  ['unknown', { w: 200, h: 180 }, { w: 200, h: 200 }, { w: 0, h: 0 }],
];
for (const [type, placement, resize, group] of FOOTPRINT_CASES) {
  test(`the four named footprint variants preserve ${type} defaults and explicit sizes`, () => {
    for (const omitted of [undefined, null, 0, NaN]) {
      const item = { type, w: omitted, h: omitted };
      assert.deepEqual(sizeForPlacement(item), placement);
      assert.deepEqual(sizeForResize(item), resize);
      assert.deepEqual(sizeForGroupBounds(item), group);
      assert.deepEqual(sizeForStickySignature(item), { w: 200, h: 180 });
    }
    const explicit = { type, w: 321, h: 123 };
    for (const size of [sizeForPlacement, sizeForResize, sizeForGroupBounds, sizeForStickySignature]) {
      assert.deepEqual(size(explicit), { w: 321, h: 123 });
    }
    const invalid = { type, w: -1, h: Infinity };
    assert.deepEqual(sizeForPlacement(invalid), placement);
    for (const size of [sizeForResize, sizeForGroupBounds, sizeForStickySignature]) {
      assert.deepEqual(size(invalid), { w: -1, h: Infinity }, 'legacy truthiness is intentionally distinct from canonical size validation');
    }
  });
}

test('legacy footprints treat inherited object names as unknown item types', () => {
  for (const type of ['constructor', 'toString', '__proto__']) {
    assert.deepEqual(sizeForResize({ type }), { w: 200, h: 200 });
    assert.deepEqual(sizeForGroupBounds({ type }), { w: 0, h: 0 });
    assert.deepEqual(sizeForStickySignature({ type }), { w: 200, h: 180 });
  }
});
