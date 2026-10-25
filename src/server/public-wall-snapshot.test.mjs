import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

const addItem = (doc, id, fields) => doc.getMap('items').set(id, new Y.Map(Object.entries(fields)));
test('public snapshots include only current-room upload images and cache keeps the room boundary', async () => {
  const { publicWallSnapshot, PublicSnapshotCache } = await import('./public-wall-snapshot.js');
  const roomHandle = 'a'.repeat(32);
  const src = `/rooms/${roomHandle}/images/12345678.png`;
  const doc = new Y.Doc();
  try {
    addItem(doc, 'upload', { type: 'image', x: 10, y: 20, w: 320, h: 200,
      src: `https://uploads.example${src}`, authorId: 'private-author', text: 'private metadata' });
    addItem(doc, 'other', { type: 'image', x: 0, y: 0, src: src.replace(roomHandle, 'b'.repeat(32)) });
    addItem(doc, 'invalid-image', { type: 'image', x: 0, y: 0, w: Infinity, h: 200, src });
    const snapshot = publicWallSnapshot(doc, { roomHandle });
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].src, `/yjs-public${src}`);
    assert.equal(snapshot.items[0].w, 320);
    assert.equal(JSON.stringify(snapshot).includes('private'), false);
    assert.deepEqual(new PublicSnapshotCache({ roomHandle }).read(doc, 0), snapshot);
  } finally { doc.destroy(); }
});
test('snapshot narrows fields, filters unsafe geometry and images, and redacts private cards', async () => {
  const { publicWallSnapshot } = await import('./public-wall-snapshot.js');
  const doc = new Y.Doc();
  addItem(doc, 'card', { type: 'sticky', x: 0, y: 10, text: new Y.Text('<script>'), authorId: 'secret', private: false });
  addItem(doc, 'hidden', { type: 'sticky', x: 0, y: 0, text: 'secret', private: true });
  addItem(doc, 'bad', { type: 'zone', x: 0, y: 0, w: -1, h: 10 });
  addItem(doc, 'nan', { type: 'text', x: NaN, y: 0 });
  addItem(doc, 'image', { type: 'image', x: 0, y: 0, src: 'https://tracker.example' });
  const value = publicWallSnapshot(doc);
  assert.equal(value.items.length, 2);
  assert.equal(value.items[0].text, '<script>');
  assert.equal(value.items[1].text, '');
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.equal(JSON.stringify(value).includes('tracker'), false);
  doc.destroy();
});
test('snapshot cache coalesces changed documents for ten seconds and does not rebuild unchanged docs', async () => {
  const { PublicSnapshotCache } = await import('./public-wall-snapshot.js');
  const doc = new Y.Doc();
  const cache = new PublicSnapshotCache();
  const first = cache.read(doc, 0);
  addItem(doc, 'new', { type: 'text', x: 0, y: 0, text: 'hello' });
  assert.equal(cache.read(doc, 9999), first);
  const next = cache.read(doc, 10000);
  assert.equal(next.items.length, 1);
  assert.equal(cache.read(doc, 20000), next);
  doc.destroy();
});

test('snapshot color field accepts safe integers only without exposing arbitrary style fields', async () => {
  const { publicWallSnapshot } = await import('./public-wall-snapshot.js');
  const doc = new Y.Doc();
  try {
    for (const [index, color] of [3, -1, 1.5, NaN, Infinity, 'red', Number.MAX_SAFE_INTEGER + 1].entries()) {
      addItem(doc, `item-${index}`, { type: 'sticky', x: 0, y: 0, color, style: 'url(tracker)' });
    }
    const snapshot = publicWallSnapshot(doc);
    assert.equal(snapshot.items[0].color, 3);
    assert.equal(snapshot.items[1].color, -1);
    for (const item of snapshot.items.slice(2)) assert.equal(Object.hasOwn(item, 'color'), false);
    assert.equal(JSON.stringify(snapshot).includes('tracker'), false);
  } finally {
    doc.destroy();
  }
});

test('snapshot preserves bounded text appearance and effective stacking without leaking private metadata', async () => {
  const { publicWallSnapshot } = await import('./public-wall-snapshot.js');
  const doc = new Y.Doc();
  try {
    addItem(doc, 'styled', { type: 'sticky', x: 0, y: 0, text: 'Visible', fontSize: 32,
      fontColor: '#ABC123', zIndex: -2.5, createdAt: 800, authorId: 'secret-author' });
    addItem(doc, 'hidden-styled', { type: 'sticky', x: 20, y: 20, text: 'secret-text', private: true,
      fontSize: 24, fontColor: '#123ABC', createdAt: 400, authorName: 'secret-name' });
    const [styled, hidden] = publicWallSnapshot(doc).items;
    assert.equal(styled.fontSize, 32);
    assert.equal(styled.fontColor, '#abc123');
    assert.equal(styled.zIndex, -2.5);
    assert.equal(hidden.fontSize, 24);
    assert.equal(hidden.fontColor, '#123abc');
    assert.equal(hidden.zIndex, 400);
    assert.equal(hidden.text, '');
    for (const item of [styled, hidden]) {
      for (const key of ['authorId', 'authorName', 'createdAt', 'private']) {
        assert.equal(Object.hasOwn(item, key), false, key);
      }
    }
    assert.equal(JSON.stringify([styled, hidden]).includes('secret'), false);
  } finally {
    doc.destroy();
  }
});

test('invalid snapshot appearance is omitted while geometry and redacted text remain intact', async () => {
  const { publicWallSnapshot } = await import('./public-wall-snapshot.js');
  const doc = new Y.Doc();
  try {
    const invalid = [
      { fontSize: 0, fontColor: 'red', zIndex: Infinity },
      { fontSize: 513, fontColor: '#abc', zIndex: Number.MAX_SAFE_INTEGER + 1 },
      { fontSize: NaN, fontColor: 'url(tracker)', zIndex: '9' },
      { fontSize: '24', fontColor: 123, zIndex: NaN },
    ];
    invalid.forEach((appearance, index) => addItem(doc, `invalid-${index}`, {
      type: 'text', x: index, y: 0, text: 'Safe', ...appearance,
    }));
    for (const item of publicWallSnapshot(doc).items) {
      assert.equal(item.text, 'Safe');
      for (const key of ['fontSize', 'fontColor', 'zIndex']) assert.equal(Object.hasOwn(item, key), false, key);
    }
  } finally {
    doc.destroy();
  }
});
