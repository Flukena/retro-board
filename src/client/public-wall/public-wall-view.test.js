import test from 'node:test';
import assert from 'node:assert/strict';

test('preview renders safe uploaded image geometry but drops arbitrary or private sources', async () => {
  const { publicWallView } = await import('./public-wall-view.js');
  const src = `/yjs-public/rooms/${'a'.repeat(32)}/images/12345678.webp`;
  const items = [{ id: 'uploaded', type: 'image', x: -20, y: 50, w: 320, h: 240, src },
    { id: 'tracker', type: 'image', x: 0, y: 0, src: 'https://tracker.example/image.png' },
    { id: 'private', type: 'image', x: 0, y: 0, src: src.replace('yjs-public', 'yjs') }];
  const view = publicWallView({ items });
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].src, src);
  assert.equal(view.w, 320);
  assert.equal(view.h, 240);
});

test('preview bounds include negative coordinates and scale without changing canonical geometry', async () => {
  const { publicWallView } = await import('./public-wall-view.js');
  const data = { items: [{ id: 'a', type: 'zone', x: -100, y: -50, w: 200, h: 100 },
    { id: 'bad', type: 'zone', x: 0, y: 0, w: -1, h: 1 }] };
  const view = publicWallView(data);
  assert.equal(view.items.length, 1);
  assert.equal(view.x, -100);
  assert.equal(view.y, -50);
  assert.equal(view.w, 200);
  assert.equal(view.h, 100);
  assert.equal(data.items[0].x, -100);
  assert.equal(publicWallView(null).items.length, 0);
});

test('preview normalizes only palette indices without mutating source geometry', async () => {
  const { publicWallView } = await import('./public-wall-view.js');
  const { PALETTE } = await import('../ui/palette.js');
  for (const color of [undefined, -1, PALETTE.length, 1.5, Infinity, 'red', 'url(tracker)']) {
    const view = publicWallView({ items: [{ id: 'item', type: 'sticky', x: 0, y: 0, color }] });
    assert.equal(view.items[0].color, 0);
  }
  const source = { items: [{ id: 'zone', type: 'zone', x: -100, y: -50, w: 200, h: 100, color: 4 }] };
  const original = structuredClone(source);
  assert.equal(publicWallView(source).items[0].color, 4);
  assert.deepEqual(source, original);
});

test('actual scene fits zone extents without letting stray notes shrink the board', async () => {
  const { publicWallScene } = await import('./public-wall-view.js');
  const zone = { id: 'zone', type: 'zone', x: -100, y: 200, w: 1200, h: 800, color: 2, text: 'Zone title' };
  const source = { items: [zone, { id: 'stray', type: 'sticky', x: 100000, y: 100000, text: 'Far away' }] };
  const scene = publicWallScene(source);
  const withoutStray = publicWallScene({ items: [zone] });
  assert.deepEqual(scene.viewport, withoutStray.viewport);
  assert.equal(scene.items.find((item) => item.id === 'zone').title, 'Zone title');
  assert.equal(scene.items.find((item) => item.id === 'stray').x, 100000);
  assert.equal(source.items[0].title, undefined);
  assert.equal(scene.width, 1200);
  assert.equal(scene.height, 720);
});

test('notes-only scenes fit all actual notes and leave canonical geometry unchanged', async () => {
  const { publicWallScene } = await import('./public-wall-view.js');
  const snapshot = { items: [{ id: 'note', type: 'sticky', x: -100, y: -50, text: 'Actual note', color: 4 }] };
  const original = structuredClone(snapshot);
  const scene = publicWallScene(snapshot);
  const note = scene.items[0];
  assert.ok(note.x * scene.viewport.zoom + scene.viewport.x >= 0);
  assert.ok((note.x + note.w) * scene.viewport.zoom + scene.viewport.x <= scene.width);
  assert.equal(note.color, 4);
  assert.deepEqual(snapshot, original);
});

test('actual snapshot preserves validated typography and board overlap order without leaking style metadata', async () => {
  const { publicWallView, publicWallScene } = await import('./public-wall-view.js');
  const snapshot = { items: [
    { id: 'zone', type: 'zone', x: 0, y: 0, w: 1200, h: 800, zIndex: 30, text: 'Above cards' },
    { id: 'sticky', type: 'sticky', x: 40, y: 40, zIndex: 10, fontSize: 96, fontColor: '#FFFFFF', text: 'Large white type' },
    { id: 'text', type: 'text', x: 80, y: 80, createdAt: 20, fontSize: 32, fontColor: '#00AABB', text: 'Middle layer' },
    { id: 'invalid', type: 'text', x: 0, y: 0, zIndex: 40, fontSize: Infinity, fontColor: 'url(tracker)', authorId: 'private-author' },
  ] };
  const view = publicWallView(snapshot);
  assert.deepEqual(view.items.map((item) => item.id), ['sticky', 'text', 'zone', 'invalid']);
  assert.equal(view.items[0].fontSize, 96);
  assert.equal(view.items[0].fontColor, '#ffffff');
  assert.equal(view.items[1].fontColor, '#00aabb');
  assert.equal(view.items[1].zIndex, 20);
  assert.equal(view.items[3].fontSize, undefined);
  assert.equal(view.items[3].fontColor, undefined);
  assert.equal(JSON.stringify(view).includes('createdAt'), false);
  assert.equal(JSON.stringify(view).includes('private-author'), false);
  assert.deepEqual(publicWallScene(snapshot).items.map((item) => item.id), ['sticky', 'text', 'zone', 'invalid']);
});
