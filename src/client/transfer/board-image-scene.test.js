import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPORT_MAX_EDGE_PX, EXPORT_MAX_PIXELS, EXPORT_PADDING_PX, EXPORT_PREFERRED_SCALE,
  boardImageBounds, boardImageScale, buildBoardImageScene, paintOrder, sceneImageUrls,
} from './board-image-scene.js';

const LOOK = Object.freeze({ background: 'white', text: 'black', uiFont: 'UI', displayFont: 'Display' });
const LABELS = Object.freeze({
  hidden: 'Hidden card', votes: n => `${n} votes`,
});
const sticky = (id, fields = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 200, h: 180, text: `text ${id}`,
  authorId: `a-${id}`, authorName: `Author ${id}`, createdAt: 1, ...fields });

const scene = (items, extra = {}) => {
  const bounds = boardImageBounds(items);
  return buildBoardImageScene({ items, votesByItem: new Map(), userId: 'viewer', allRevealed: false,
    look: LOOK, labels: LABELS, bounds, scale: 1, ...extra });
};
const texts = (built) => built.plates.filter(entry => entry.text).map(entry => entry.text.content);

test('bounds enclose every item plus padding, using default sizes for missing w/h', () => {
  const bounds = boardImageBounds([
    { id: 'z', type: 'zone', x: -100, y: 50, w: 300, h: 300 },
    { id: 's', type: 'sticky', x: 900, y: 1000 },
  ]);
  assert.deepEqual(bounds, { x: -100 - EXPORT_PADDING_PX, y: 50 - EXPORT_PADDING_PX,
    w: 900 + 200 + 100 + EXPORT_PADDING_PX * 2, h: 1000 + 180 - 50 + EXPORT_PADDING_PX * 2 });
  assert.equal(boardImageBounds([]), null);
});

test('scale prefers 2x but never exceeds the canvas edge or pixel budget', () => {
  assert.equal(boardImageScale({ w: 1000, h: 800 }), EXPORT_PREFERRED_SCALE);
  const wide = { w: 20_000, h: 1000 };
  assert.ok(wide.w * boardImageScale(wide) <= EXPORT_MAX_EDGE_PX);
  const huge = { w: 9000, h: 9000 };
  const scale = boardImageScale(huge);
  assert.ok((huge.w * scale) * (huge.h * scale) <= EXPORT_MAX_PIXELS + 1);
  assert.ok(scale < 1);
});

test('zones paint underneath, then everything else in z-order', () => {
  const items = [sticky('top', { zIndex: 5 }), { id: 'z', type: 'zone', x: 0, y: 0, w: 500, h: 500, zIndex: 9 }, sticky('low', { zIndex: 1 })];
  assert.deepEqual(paintOrder(items).map(item => item.id), ['z', 'low', 'top']);
});

test('sticky text, author and votes appear; hidden private cards are masked', () => {
  const items = [sticky('a'), sticky('s', { private: true, text: 'secret plan' })];
  const built = scene(items, { votesByItem: new Map([['a', new Set(['u1', 'u2'])]]) });
  const content = texts(built);
  assert.ok(content.includes('text a'));
  assert.ok(content.includes('Author a'));
  assert.ok(content.includes('2 votes'));
  assert.ok(content.includes('Hidden card'));
  assert.ok(!content.some(text => text.includes('secret plan') || text === 'Author s'));
});

test('legacy action fields have no effect on a visible or hidden card in image exports', () => {
  const items = [sticky('a', { actionItem: true, actionOwner: 'Nok', actionDue: '2026-11-30' }),
    sticky('s', { private: true, actionItem: true, actionOwner: 'Secret owner', actionDone: true })];
  assert.deepEqual(scene(items), scene([sticky('a'), sticky('s', { private: true })]));
});

test('scene size and plate geometry follow the scale; images are listed once', () => {
  const items = [{ id: 'i', type: 'image', x: 0, y: 0, w: 100, h: 50, src: '/rooms/r/images/1.png' },
    { id: 'j', type: 'image', x: 200, y: 0, w: 100, h: 50, src: '/rooms/r/images/1.png' }];
  const bounds = boardImageBounds(items);
  const built = scene(items, { bounds, scale: 2 });
  assert.equal(built.width, Math.ceil(bounds.w * 2));
  assert.equal(built.plates[0].w, 200);
  assert.equal(built.plates[0].x, EXPORT_PADDING_PX * 2);
  assert.deepEqual(sceneImageUrls(built), ['/rooms/r/images/1.png']);
});
