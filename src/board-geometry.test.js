import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GEOMETRY_SOURCE,
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
