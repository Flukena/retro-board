import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { boardPreviewOfDoc } from './board-preview-reader.js';

const zoneMap = (fields) => new Y.Map(Object.entries({ type: 'zone', ...fields }));

test('reads zones from Y.Map items and ignores everything else', () => {
  const doc = new Y.Doc();
  const items = doc.getMap('items');
  items.set('zone-1', zoneMap({ x: 0, y: 0, w: 400, h: 300, color: 3, title: 'private' }));
  items.set('sticky-1', new Y.Map(Object.entries({ type: 'sticky', x: 5, y: 5, w: 100, h: 100, text: 'secret' })));
  items.set('plain', { type: 'zone', x: 0, y: 0, w: 400, h: 300, color: 1 });
  const preview = boardPreviewOfDoc(doc);
  assert.deepEqual(preview, { zones: [{ x: 0, y: 0, w: 400, h: 300, color: 3 }] });
  assert.equal(JSON.stringify(preview).includes('private'), false);
});

test('reads only the zone fields it needs and never copies an item', () => {
  const doc = new Y.Doc();
  const items = doc.getMap('items');
  items.set('zone-1', zoneMap({ x: 10, y: 20, w: 300, h: 200, color: 2, title: 'private' }));
  items.set('sticky-1', new Y.Map(Object.entries({ type: 'sticky', x: 5, y: 5, w: 100, h: 100, text: 'secret' })));
  for (const item of items.values()) item.toJSON = () => assert.fail('an item was copied whole');
  assert.deepEqual(boardPreviewOfDoc(doc), { zones: [{ x: 10, y: 20, w: 300, h: 200, color: 2 }] });
});

test('a doc without zones gives null', () => {
  const doc = new Y.Doc();
  doc.getMap('items').set('sticky-1', new Y.Map(Object.entries({ type: 'sticky', x: 5, y: 5, w: 100, h: 100 })));
  assert.equal(boardPreviewOfDoc(doc), null);
  assert.equal(boardPreviewOfDoc(new Y.Doc()), null);
});
