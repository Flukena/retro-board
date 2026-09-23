import test from 'node:test';
import assert from 'node:assert/strict';

import * as Y from 'yjs';
import { repairStoredBoardGeometry } from './stored-geometry-repair.js';

const addItem = (items, item) => {
  const yItem = new Y.Map();
  Object.entries(item).forEach(([key, value]) => {
    if (key !== 'id') yItem.set(key, value);
  });
  items.set(item.id, yItem);
};

test('repairs missing geometry in the canonical Yjs room state exactly once', () => {
  const doc = new Y.Doc();
  const items = doc.getMap('items');
  addItem(items, {
    id: 'positioned', type: 'sticky', x: 10, y: 20, w: 200, h: 180,
  });
  addItem(items, {
    id: 'legacy-zone', type: 'zone', x: null, y: null, w: null, h: null, title: 'Old zone',
  });
  addItem(items, {
    id: 'legacy-sticky', type: 'sticky', x: null, y: null, w: 200, h: 180,
  });

  const first = repairStoredBoardGeometry(doc, items);

  assert.deepEqual(first, { positions: 2, zoneDimensions: 1 });
  assert.deepEqual(
    ['x', 'y', 'w', 'h'].map((key) => items.get('legacy-zone').get(key)),
    [10, 248, 1200, 1080],
  );
  assert.deepEqual(
    ['x', 'y'].map((key) => items.get('legacy-sticky').get(key)),
    [1258, 248],
  );
  assert.deepEqual(
    ['x', 'y'].map((key) => items.get('positioned').get(key)),
    [10, 20],
  );

  let updateCount = 0;
  doc.on('update', () => { updateCount += 1; });
  const second = repairStoredBoardGeometry(doc, items);
  assert.deepEqual(second, { positions: 0, zoneDimensions: 0 });
  assert.equal(updateCount, 0);
});
