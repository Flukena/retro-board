import test from 'node:test';
import assert from 'node:assert/strict';
import { paintViewport } from './viewport-renderer.js';
import { LIVE_LAYER_SETTLE_MS } from './live-layer-hint.js';
import { GRID_PITCH_PX } from '../chrome/chrome-layout.js';

test('viewport painting preserves world, grid, cursor and minimap coordinate alignment', () => {
  const world = { style: {} }, grid = { style: {} }, mini = { style: {} };
  const cursor = { dataset: { cursorX: '100', cursorY: '200' }, style: {} };
  paintViewport({ x: 20, y: -30, zoom: 0.5 }, { world, grid, cursorLayer: { children: [cursor] }, minimapViewport: mini,
    minimapModel: { viewportSize: { w: 100, h: 80 }, bounds: { x: 0, y: 0 }, scale: 0.1, offsetX: 0, offsetY: 0 } });
  assert.equal(world.style.transform, 'translate3d(20px, -30px, 0) scale(0.5)');
  assert.equal(cursor.style.transform, 'translate3d(70px, 70px, 0)');
  assert.equal(mini.style.transform, 'translate3d(-4px, 6px, 0)');
  assert.equal(mini.style.width, '20px'); assert.equal(mini.style.height, '16px');
  assert.notEqual(grid.style.backgroundImage, 'none');
  assert.doesNotThrow(() => paintViewport({ x: 0, y: 0, zoom: 1 }, {}));
});


test('live viewport painting moves selected handles with the same fractional world transform', () => {
  const se = { dataset: { selectionCorner: 'se' }, style: {} };
  const selectionLayer = {
    dataset: { selectionKind: 'sticky', selectionX: '100.25', selectionY: '200.5', selectionW: '80.5', selectionH: '60.25', selectionStackPx: '0' },
    querySelectorAll: () => [se], querySelector: () => null,
  };
  paintViewport({ x: 20.5, y: -30.25, zoom: 0.5 }, { selectionLayer });
  assert.equal(se.style.left, '110.875px');
  assert.equal(se.style.top, '100.125px');
  paintViewport({ x: -20.125, y: 15.5, zoom: 2 }, { selectionLayer });
  assert.equal(se.style.left, '341.375px');
  assert.equal(se.style.top, '537px');
});

test('native gesture browsers keep fractional world alignment without forcing a 3D backing layer', () => {
  const world = { style: {}, ownerDocument: { defaultView: { GestureEvent: class {} } } };
  paintViewport({ x: 20.125, y: -30.25, zoom: 0.375 }, { world });
  assert.equal(world.style.transform, 'translate(20.125px, -30.25px) scale(0.375)');
});

test('live painting keeps the world raster scalable and a settled paint restores full-detail rendering', () => {
  const world = { style: {} };
  paintViewport({ x: 0, y: 0, zoom: 0.25 }, { world }, { live: true });
  assert.equal(world.style.willChange, 'transform');
  paintViewport({ x: 0, y: 0, zoom: 0.5 }, { world });
  assert.equal(world.style.willChange, '');
});

test('native gesture browsers never promote the world during live painting', () => {
  const world = { style: {}, ownerDocument: { defaultView: { GestureEvent: class {} } } };
  paintViewport({ x: 0, y: 0, zoom: 0.25 }, { world }, { live: true });
  assert.equal(world.style.willChange, undefined);
});

test('input settling on its own re-textures the grid at the settled zoom', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const world = { style: {} }, grid = { style: {} };
  paintViewport({ x: 0, y: 0, zoom: 1 }, { world, grid });
  paintViewport({ x: 0, y: 0, zoom: 1.5 }, { world, grid }, { live: true });
  assert.equal(grid.style.backgroundSize, `${GRID_PITCH_PX}px ${GRID_PITCH_PX}px`, 'Live frames reuse the texture');
  context.mock.timers.tick(LIVE_LAYER_SETTLE_MS);
  assert.equal(grid.style.backgroundSize, `${GRID_PITCH_PX * 1.5}px ${GRID_PITCH_PX * 1.5}px`);
  assert.equal(world.style.willChange, '');
});
