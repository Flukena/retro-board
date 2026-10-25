import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionLayerAttributes, paintSelectionOverlay, cacheSelectionToolbarBounds } from './selection-overlay.js';

function style(initial = {}) { return { ...initial, setProperty(name, value) { this[name] = value; } }; }
function fixture(kind = 'group') {
  const handles = ['nw', 'ne', 'sw', 'se'].map(corner => ({ dataset: { selectionCorner: corner }, style: style({ width: '44px', borderWidth: '2px' }) }));
  const bounds = { style: style() };
  const toolbar = { dataset: {}, style: style(), scrollWidth: 240, clientWidth: 200, getBoundingClientRect: () => ({ width: 200 }) };
  const layer = { dataset: { selectionKind: kind, selectionX: '100.25', selectionY: '200.5', selectionW: '80.5', selectionH: '60.25', selectionStackPx: '0' },
    querySelectorAll: () => handles, querySelector: selector => selector === '[data-selection-bounds]' ? bounds : toolbar };
  return { layer, handles, bounds, toolbar };
}

test('selection metadata keeps canonical item/group bounds and disables itself during editing', () => {
  const item = { type: 'sticky', x: 100.25, y: 200.5, w: 80.5, h: 60.25 };
  const config = { item, selectedCount: 1, stackHeightPx: 48, editing: false };
  assert.deepEqual(selectionLayerAttributes(config), { 'data-selection-kind': 'sticky', 'data-selection-x': 100.25,
    'data-selection-y': 200.5, 'data-selection-w': 80.5, 'data-selection-h': 60.25, 'data-selection-stack-px': 48 });
  assert.deepEqual(selectionLayerAttributes({ ...config, editing: true }), {});
  assert.deepEqual(selectionLayerAttributes({ ...config, item: null }), {});
  const group = selectionLayerAttributes({ ...config, selectedCount: 2, groupBBox: { x: 10, y: 20, w: 400, h: 500 } });
  assert.equal(group['data-selection-kind'], 'group'); assert.equal(group['data-selection-x'], 10); assert.equal(group['data-selection-w'], 400);
});

test('group corners, bounds and toolbar update together without layout reads or resized touch targets', () => {
  const { layer, handles, bounds, toolbar } = fixture();
  cacheSelectionToolbarBounds(toolbar, { anchorXPx: 600, railRightPx: 140, viewportWidthPx: 1000 });
  assert.equal(toolbar.style['--rb-selection-max-width-px'], '832px'); assert.equal(toolbar.dataset.toolbarOverflow, 'true');
  toolbar.getBoundingClientRect = () => { throw new Error('Live viewport frames must not force toolbar layout'); };
  paintSelectionOverlay({ x: 20.5, y: -30.25, zoom: 0.5 }, layer);
  assert.deepEqual(handles.map(handle => [handle.style.left, handle.style.top]), [['70.625px', '70px'], ['110.875px', '70px'], ['70.625px', '100.125px'], ['110.875px', '100.125px']]);
  assert.equal(bounds.style.width, '40.25px'); assert.equal(bounds.style.height, '30.125px');
  assert.equal(toolbar.style['--rb-selection-anchor-x-px'], '254px'); assert.equal(toolbar.style['--rb-selection-anchor-y-px'], '124px');
  paintSelectionOverlay({ x: 400, y: 0, zoom: 2 }, layer);
  assert.equal(toolbar.style['--rb-selection-anchor-x-px'], '681px'); assert.equal(toolbar.style['--rb-selection-anchor-y-px'], '387px');
  for (const handle of handles) { assert.equal(handle.style.width, '44px'); assert.equal(handle.style.borderWidth, '2px'); }
});

test('mobile toolbar stays docked and empty selection does no DOM work', () => {
  const { layer, handles, toolbar } = fixture('sticky'); toolbar.dataset.selectionToolbarMobile = 'true';
  toolbar.style['--rb-selection-anchor-x-px'] = 'saved'; paintSelectionOverlay({ x: 0, y: 0, zoom: 1 }, layer);
  assert.equal(toolbar.style['--rb-selection-anchor-x-px'], 'saved'); assert.equal(handles[0].style.left, '100.25px');
  assert.doesNotThrow(() => paintSelectionOverlay({ x: 0, y: 0, zoom: 1 }, { dataset: {}, querySelectorAll() { throw new Error('No selection should not query DOM'); } }));
});
