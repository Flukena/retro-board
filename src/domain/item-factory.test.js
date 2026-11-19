import test from 'node:test';
import assert from 'node:assert/strict';
import { createStickyItem, createTextItem, createZoneItem, createImageItem } from './item-factory.js';

const AUTHOR = { id: 'new', authorId: 'self', authorName: 'Writer', createdAt: 10000 };
const parent = { id: 'parent', type: 'zone', x: 0, y: 0, w: 1200, h: 1080, color: 3 };

test('sticky builder preserves centered size, parent/color, author and private flags', () => {
  const result = createStickyItem({ ...AUTHOR, wx: 500, wy: 400, size: { w: 200, h: 180 }, enclosingZone: parent, color: 3, publicMode: false });
  assert.deepEqual(result, { ...AUTHOR, type: 'sticky', x: 400, y: 310, w: 200, h: 180, text: '', color: 3, parentZoneId: 'parent', private: true });
  assert.ok(!Object.hasOwn(result, 'fontSize'));
});

test('scaled public sticky preserves the supplied font size and leaves an absent owner null', () => {
  const result = createStickyItem({ ...AUTHOR, wx: 500, wy: 400, size: { w: 400, h: 360, fontSize: 40 }, enclosingZone: null, color: 2, publicMode: true });
  assert.deepEqual(result, { ...AUTHOR, type: 'sticky', x: 300, y: 220, w: 400, h: 360, text: '', color: 2, parentZoneId: null, private: false, fontSize: 40 });
});

test('text uses the pointer as top-left, default text footprint, supplied localized copy and geometric owner', () => {
  assert.deepEqual(createTextItem({ ...AUTHOR, wx: 100, wy: 200, text: 'ข้อความ' }, [parent]), {
    ...AUTHOR, type: 'text', x: 100, y: 200, w: 400, h: 80, text: 'ข้อความ', parentZoneId: 'parent',
  });
});

test('zones retain explicit dimensions/title/color and default unnamed zones', () => {
  assert.deepEqual(createZoneItem({ ...AUTHOR, x: 100, y: 200, w: 300, h: 200, title: 'Team', color: 4 }, [parent]), {
    ...AUTHOR, type: 'zone', x: 100, y: 200, w: 300, h: 200, title: 'Team', color: 4, parentZoneId: 'parent',
  });
  const result = createZoneItem({ ...AUTHOR, x: 100, y: 200, w: 300, h: 200 }, []);
  assert.equal(result.title, 'Untitled');
  assert.equal(result.color, 0);
  assert.equal(result.parentZoneId, null);
});

for (const { name, natW, natH, w, h } of [
  { name: 'small', natW: 240, natH: 120, w: 240, h: 120 },
  { name: 'width cap boundary', natW: 480, natH: 240, w: 480, h: 240 },
  { name: 'wide rounded', natW: 1000, natH: 333, w: 480, h: 160 },
  { name: 'tall narrow', natW: 100, natH: 2000, w: 100, h: 2000 },
]) {
  test(`image builder preserves natural size/src and centers ${name} display geometry`, () => {
    const items = structuredClone([parent]);
    const before = structuredClone(items);
    assert.deepEqual(createImageItem({ ...AUTHOR, wx: 600, wy: 540, src: '/image.png', natW, natH }, items), {
      ...AUTHOR, type: 'image', x: 600 - w / 2, y: 540 - h / 2, w, h, natW, natH, src: '/image.png',
      parentZoneId: 'parent',
    });
    assert.deepEqual(items, before);
  });
}
