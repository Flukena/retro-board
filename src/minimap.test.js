import test from 'node:test';
import assert from 'node:assert/strict';
import * as minimap from './minimap.js';

import {
  buildMinimapModel,
  centerViewportOnWorld,
  minimapPointToWorld,
  minimapViewportRect,
  viewportWorldRect,
} from './minimap.js';

test('minimap model fits board items and the current viewport inside its surface', () => {
  const viewport = { x: -100, y: -50, zoom: 1 };
  const viewportSize = { w: 1000, h: 700 };
  const model = buildMinimapModel({
    items: [
      { id: 'zone', type: 'zone', x: 0, y: 0, w: 1200, h: 900, color: 2 },
      { id: 'note', type: 'sticky', x: 1400, y: 250, w: 200, h: 180, color: 0 },
    ],
    viewport,
    viewportSize,
    width: 220,
    height: 132,
  });

  assert.equal(model.items.length, 2);
  assert.ok(model.scale > 0);
  assert.ok(model.viewport.x >= 0);
  assert.ok(model.viewport.y >= 0);
  assert.ok(model.viewport.x + model.viewport.w <= model.width);
  assert.ok(model.viewport.y + model.viewport.h <= model.height);
  model.items.forEach((item) => {
    assert.ok(item.x >= 0);
    assert.ok(item.y >= 0);
    assert.ok(item.x + item.w <= model.width);
    assert.ok(item.y + item.h <= model.height);
  });
});

test('minimap never coerces invalid item coordinates to the board origin', () => {
  const model = buildMinimapModel({
    items: [
      { id: 'null-position', type: 'sticky', x: null, y: null, w: 200, h: 180 },
      { id: 'valid-position', type: 'sticky', x: 10, y: 20, w: 200, h: 180 },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportSize: { w: 800, h: 600 },
  });

  assert.deepEqual(model.items.map((item) => item.id), ['valid-position']);
});

test('minimap pointer coordinates map back to world coordinates', () => {
  const model = buildMinimapModel({
    items: [{ id: 'zone', type: 'zone', x: 0, y: 0, w: 1000, h: 500 }],
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportSize: { w: 1000, h: 500 },
    width: 220,
    height: 132,
  });
  const expectedWorld = {
    x: model.bounds.x + model.bounds.w / 2,
    y: model.bounds.y + model.bounds.h / 2,
  };
  const mapped = minimapPointToWorld(
    { clientX: 160, clientY: 86 },
    { left: 50, top: 20, width: 220, height: 132 },
    model,
  );

  assert.ok(Math.abs(mapped.x - expectedWorld.x) < 0.000001);
  assert.ok(Math.abs(mapped.y - expectedWorld.y) < 0.000001);
});

test('centering on a minimap point preserves zoom and centers that world point', () => {
  const next = centerViewportOnWorld(
    { x: 20, y: 40, zoom: 0.5 },
    { w: 1200, h: 800 },
    { x: 2000, y: 1000 },
  );

  assert.deepEqual(next, { x: -400, y: -100, zoom: 0.5 });
  assert.deepEqual(viewportWorldRect(next, { w: 1200, h: 800 }), {
    x: 800,
    y: 200,
    w: 2400,
    h: 1600,
  });
});

test('live viewport rectangle can be remapped without rebuilding item geometry', () => {
  const viewportSize = { w: 800, h: 600 };
  const model = buildMinimapModel({
    items: [{ id: 'zone', type: 'zone', x: 0, y: 0, w: 1600, h: 1200 }],
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportSize,
    width: 220,
    height: 132,
  });
  const first = minimapViewportRect({ x: 0, y: 0, zoom: 1 }, viewportSize, model);
  const moved = minimapViewportRect({ x: -400, y: -300, zoom: 1 }, viewportSize, model);

  assert.ok(moved.x > first.x);
  assert.ok(moved.y > first.y);
  assert.equal(moved.w, first.w);
  assert.equal(moved.h, first.h);
});


test('zoom percentage rounds on either side of half-percent boundaries', () => {
  for (const [zoom, percentage] of [[0.0049, 0], [0.005, 1], [0.9949, 99], [0.995, 100], [1.2349, 123], [1.235, 124], [2, 200]]) {
    assert.equal(minimap.minimapZoomPercent(zoom), percentage);
  }
});
