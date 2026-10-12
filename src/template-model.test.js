import test from 'node:test';
import assert from 'node:assert/strict';
import { templateZonesFromSelection, templateBounds, templatePlacementOffset, templateOccupiedRects, templateRevealViewport } from './template-model.js';
import { IMPORT_COORDINATE_MAX_ABS } from './security-boundaries.js';

const zone = (id, x, y, w, h, extra = {}) => ({ id, type: 'zone', title: id, color: 2, x, y, w, h, ...extra });
const nested = () => [zone('parent', 100, 200, 600, 600), zone('child', 150, 250, 300, 300, { parentZoneId: 'parent' }), zone('grandchild', 180, 280, 100, 100, { parentZoneId: 'child' })];
const titles = (items, ids) => templateZonesFromSelection(items, new Set(ids)).map((z) => z.title);

test('selected zones include descendants in board order, deduplicated; child excludes its parent', () => {
  const items = nested();
  assert.deepEqual(titles(items, ['parent']), ['parent', 'child', 'grandchild']);
  assert.deepEqual(titles(items, ['child']), ['child', 'grandchild']);
  assert.deepEqual(titles(items, ['parent', 'child']), ['parent', 'child', 'grandchild']);
  assert.deepEqual(titles([...items].reverse(), ['parent']), ['grandchild', 'child', 'parent']);
});

test('ownership uses the full snapshot: legacy geometry, explicit null, invalid and moved parent', () => {
  const items = nested();
  items.push(zone('legacy', 200, 300, 30, 30), zone('null', 200, 300, 30, 30, { parentZoneId: null }),
    zone('invalid', 200, 300, 30, 30, { parentZoneId: 'missing' }),
    zone('outside', 900, 900, 30, 30, { parentZoneId: 'parent' }),
    { id: 'sticky', type: 'sticky', x: 200, y: 300 }, { id: 'text', type: 'text', x: 200, y: 300 });
  assert.deepEqual(titles(items, ['child']), ['child', 'grandchild', 'legacy']);
  assert.deepEqual(titles(items, ['sticky', 'text']), []);
  assert.deepEqual(titles(items, ['parent']), ['parent', 'child', 'grandchild', 'legacy']);
});

test('cycles terminate, selected cyclic ancestors work, values copy and normalize to minimum x/y', () => {
  const items = [zone('a', -100, -200, 300, 300, { parentZoneId: 'b' }), zone('b', -100, -200, 300, 300, { parentZoneId: 'a' }), zone('other', 1000, 1000, 100, 100)];
  assert.deepEqual(titles(items, ['other']), ['other']);
  assert.deepEqual(titles(items, ['a']), ['a', 'b']);
  const zones = templateZonesFromSelection(nested(), ['child']);
  assert.deepEqual(zones, [{ title: 'child', color: 2, x: 0, y: 0, w: 300, h: 300 }, { title: 'grandchild', color: 2, x: 30, y: 30, w: 100, h: 100 }]);
  assert.deepEqual(templateBounds(zones), { x: 0, y: 0, w: 300, h: 300 });
  assert.equal(templateBounds([]), null);
});

const placement = (options = {}) => templatePlacementOffset({ templateZones: [zone('template', 0, 0, 100, 200)], viewportCenter: { x: 0, y: 0 }, occupiedRects: [], gapPx: 20, maxRings: 2, ...options });
const free = (box, occupied, gap) => occupied.every((r) => box.x + box.w + gap <= r.x || r.x + r.w + gap <= box.x || box.y + box.h + gap <= r.y || r.y + r.h + gap <= box.y);

test('empty or sparse distant board uses centered formula, even for oversized templates', () => {
  assert.deepEqual(placement(), { dx: -50, dy: -100 });
  assert.deepEqual(placement({ occupiedRects: [{ x: 50000, y: 50000, w: 100, h: 100 }] }), { dx: -50, dy: -100 });
  assert.deepEqual(placement({ templateZones: [zone('large', 10, 20, 4000, 6000)], viewportCenter: { x: 500, y: 300 } }), { dx: -1510, dy: -2720 });
});

test('nearest free grid candidate respects gap for all item bboxes and is deterministic', () => {
  const occupiedRects = [{ x: -50, y: -100, w: 100, h: 200 }];
  const offset = placement({ occupiedRects });
  assert.equal(Math.hypot(offset.dx + 50, offset.dy + 100), 120);
  assert.ok(free({ x: offset.dx, y: offset.dy, w: 100, h: 200 }, occupiedRects, 20));
  assert.deepEqual(placement({ occupiedRects }), offset);
});

test('touching an item edge is occupied; touching the full gap boundary is free', () => {
  assert.notDeepEqual(placement({ occupiedRects: [{ x: 50, y: -100, w: 100, h: 200 }] }), { dx: -50, dy: -100 });
  assert.deepEqual(placement({ occupiedRects: [{ x: 70, y: -100, w: 100, h: 200 }] }), { dx: -50, dy: -100 });
});

test('bounded search falls back right of the union, aligned to its top; cap rejects overflow', () => {
  assert.deepEqual(placement({ maxRings: 0, occupiedRects: [{ x: -50, y: -100, w: 100, h: 200 }, { x: 500, y: 300, w: 100, h: 100 }] }), { dx: 620, dy: -100 });
  assert.equal(placement({ coordinateLimit: 50 }), null);
  assert.equal(placement({ maxRings: 0, occupiedRects: [{ x: -IMPORT_COORDINATE_MAX_ABS, y: -IMPORT_COORDINATE_MAX_ABS, w: IMPORT_COORDINATE_MAX_ABS * 2, h: IMPORT_COORDINATE_MAX_ABS * 2 }] }), null);
});

test('reveal keeps visible bounds unchanged and pans offscreen bounds without changing zoom', () => {
  const viewport = { x: 0, y: 0, zoom: 2 };
  assert.equal(templateRevealViewport({ bounds: { x: 10, y: 10, w: 100, h: 100 }, viewport, viewportSize: { w: 800, h: 600 } }), null);
  assert.deepEqual(templateRevealViewport({ bounds: { x: 500, y: 500, w: 100, h: 100 }, viewport, viewportSize: { w: 800, h: 600 } }), { x: -700, y: -800, zoom: 2 });
});


test('occupied rectangles reuse canonical sticky, text, image and zone default sizes', () => {
  const items = ['sticky', 'text', 'image', 'zone'].map((type) => ({ type, x: 0, y: 0 }));
  const rects = templateOccupiedRects(items);
  assert.deepEqual(rects.map(({ w, h }) => [w, h]), [[200, 180], [400, 80], [200, 200], [1200, 1080]]);
  assert.deepEqual(templateOccupiedRects([{ type: 'text', x: 10, y: 20, w: 90, h: 40 }]), [{ x: 10, y: 20, w: 90, h: 40 }]);
});

test('distance order crosses ring boundaries for tall templates rather than exhausting a farther ring', () => {
  const occupiedRects = [{ x: -170, y: -100, w: 340, h: 200 }];
  const offset = placement({ occupiedRects });
  // Both horizontal neighbours are blocked; ring-two horizontal distance 240
  // is farther than ring-one vertical distance 220, so choose vertical first.
  assert.equal(Math.hypot(offset.dx + 50, offset.dy + 100), 220);
  const tall = placement({ templateZones: [zone('tall', 0, 0, 100, 1000)],
    occupiedRects: [{ x: -170, y: -500, w: 340, h: 1000 }] });
  assert.equal(Math.hypot(tall.dx + 50, tall.dy + 500), 240);
  assert.ok(free({ x: tall.dx, y: tall.dy, w: 100, h: 1000 }, [{ x: -170, y: -500, w: 340, h: 1000 }], 20));
});
