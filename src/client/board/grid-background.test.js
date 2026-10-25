import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_LIVE_SCALE_LIMIT, gridBackgroundForZoom, gridLayout, gridStyleForViewport, paintGrid } from './grid-background.js';
import { GRID_PITCH_PX } from '../chrome/chrome-layout.js';
import { GRID_DOTS_MIN_ZOOM } from '../../domain/viewport-limits.js';

const BELOW_GRID_MIN_ZOOM = 0.149;

test('grid dots disappear below fifteen percent zoom', () => {
  assert.deepEqual(gridBackgroundForZoom(BELOW_GRID_MIN_ZOOM), {
    backgroundImage: 'none', backgroundSize: 'auto',
  });
});

const GRID_BOUNDARY_ZOOM = 0.15;
const NORMAL_ZOOM = 1;
const EXPECTED_DOTS_IMAGE = 'radial-gradient(circle, var(--grid-dot) 1px, transparent 1px)';

test('grid dots begin at fifteen percent zoom and retain the scaled board pitch', () => {
  assert.equal(GRID_DOTS_MIN_ZOOM, GRID_BOUNDARY_ZOOM);
  for (const zoom of [GRID_BOUNDARY_ZOOM, NORMAL_ZOOM]) {
    const pitchPx = GRID_PITCH_PX * zoom;
    assert.deepEqual(gridBackgroundForZoom(zoom), {
      backgroundImage: EXPECTED_DOTS_IMAGE,
      backgroundSize: `${pitchPx}px ${pitchPx}px`,
    });
  }
});

test('zooming out then back restores dots without retaining the hidden background', () => {
  const style = { ...gridBackgroundForZoom(NORMAL_ZOOM) };
  Object.assign(style, gridBackgroundForZoom(BELOW_GRID_MIN_ZOOM));
  assert.equal(style.backgroundImage, 'none');
  Object.assign(style, gridBackgroundForZoom(NORMAL_ZOOM));
  assert.equal(style.backgroundImage, EXPECTED_DOTS_IMAGE);
  assert.equal(style.backgroundSize, `${GRID_PITCH_PX}px ${GRID_PITCH_PX}px`);
});

test('panning reuses the grid texture instead of changing its paint properties', () => {
  const first = gridStyleForViewport({ x: 0, y: 0, zoom: NORMAL_ZOOM });
  const next = gridStyleForViewport({ x: 123.25, y: -987.5, zoom: NORMAL_ZOOM });
  for (const property of ['backgroundImage', 'backgroundSize', 'backgroundPosition', 'inset']) {
    assert.equal(next[property], first[property], property);
  }
  assert.notEqual(next.transform, first.transform);
});

test('wrapped grid translation preserves board alignment and covers the viewport across the live scale band', () => {
  const viewportSize = { w: 1280, h: 720 };
  const coordinateSamples = [-1_000_000.25, -18, -0.5, 0, 0.5, 18, 1_000_000.25];
  const zoomSamples = [GRID_BOUNDARY_ZOOM, 0.375, NORMAL_ZOOM, 3];
  const scaleSamples = [1 / GRID_LIVE_SCALE_LIMIT, 1, GRID_LIVE_SCALE_LIMIT];
  const ALIGNMENT_TOLERANCE = 1e-6;
  for (const zoom of zoomSamples) {
    const pitchPx = GRID_PITCH_PX * zoom;
    for (const scale of scaleSamples) {
      for (const x of coordinateSamples) {
        const viewport = { x, y: -x, zoom };
        const layout = gridLayout(viewport, zoom / scale);
        assert.ok(Math.abs(layout.texturePitchPx * layout.scale - pitchPx) < ALIGNMENT_TOLERANCE, 'Scaled dots keep the board pitch');
        const tileOffset = (viewport.x - layout.offsetX) / pitchPx;
        const rowOffset = (viewport.y - layout.offsetY) / pitchPx;
        assert.ok(Math.abs(tileOffset - Math.round(tileOffset)) < ALIGNMENT_TOLERANCE, 'Grid columns remain aligned with board coordinates');
        assert.ok(Math.abs(rowOffset - Math.round(rowOffset)) < ALIGNMENT_TOLERANCE, 'Grid rows remain aligned with board coordinates');
        const extent = (sizePx) => layout.scale * (GRID_LIVE_SCALE_LIMIT * sizePx + layout.texturePitchPx);
        assert.ok(layout.offsetX <= 0 && layout.offsetX + extent(viewportSize.w) >= viewportSize.w);
        assert.ok(layout.offsetY <= 0 && layout.offsetY + extent(viewportSize.h) >= viewportSize.h);
      }
    }
  }
});

test('live zoom scales the cached dot texture and a settled paint restores the exact texture', () => {
  const grid = { style: {} };
  paintGrid(grid, { x: 0, y: 0, zoom: NORMAL_ZOOM }, false);
  const cachedSize = grid.style.backgroundSize;
  for (const zoom of [1.2, 1.6, GRID_LIVE_SCALE_LIMIT, 0.7, 1 / GRID_LIVE_SCALE_LIMIT]) {
    paintGrid(grid, { x: 5, y: 7, zoom }, true);
    assert.equal(grid.style.backgroundSize, cachedSize, `zoom ${zoom} reuses the cached texture`);
  }
  paintGrid(grid, { x: 5, y: 7, zoom: 1.5 }, false);
  assert.equal(grid.style.backgroundSize, `${GRID_PITCH_PX * 1.5}px ${GRID_PITCH_PX * 1.5}px`);
  assert.match(grid.style.transform, /scale\(1\)$/);
});

test('live zoom re-textures once it drifts beyond the scale band', () => {
  const grid = { style: {} };
  paintGrid(grid, { x: 0, y: 0, zoom: NORMAL_ZOOM }, false);
  const beyondZoom = NORMAL_ZOOM * GRID_LIVE_SCALE_LIMIT * 1.25;
  paintGrid(grid, { x: 0, y: 0, zoom: beyondZoom }, true);
  assert.equal(grid.style.backgroundSize, `${GRID_PITCH_PX * beyondZoom}px ${GRID_PITCH_PX * beyondZoom}px`);
  paintGrid(grid, { x: 0, y: 0, zoom: beyondZoom * 1.5 }, true);
  assert.equal(grid.style.backgroundSize, `${GRID_PITCH_PX * beyondZoom}px ${GRID_PITCH_PX * beyondZoom}px`,
    'The new texture becomes the cached one');
});

test('hiding the dots releases the grid layer and zooming back restores its texture', () => {
  const style = { ...gridStyleForViewport({ x: 12, y: 34, zoom: NORMAL_ZOOM }) };
  Object.assign(style, gridStyleForViewport({ x: 12, y: 34, zoom: BELOW_GRID_MIN_ZOOM }));
  assert.equal(style.backgroundImage, 'none');
  assert.equal(style.transform, 'none');
  assert.equal(Number.parseFloat(style.inset), 0);
  assert.equal(style.willChange, 'auto');
  Object.assign(style, gridStyleForViewport({ x: 12, y: 34, zoom: NORMAL_ZOOM }));
  assert.equal(style.backgroundImage, EXPECTED_DOTS_IMAGE);
  assert.equal(style.backgroundSize, `${GRID_PITCH_PX}px ${GRID_PITCH_PX}px`);
});

test('live zoom from a dotless overview shows dots as soon as it crosses the visibility threshold', () => {
  const grid = { style: {} };
  paintGrid(grid, { x: 0, y: 0, zoom: BELOW_GRID_MIN_ZOOM }, false);
  const visibleZoom = GRID_BOUNDARY_ZOOM * 1.2;
  paintGrid(grid, { x: 0, y: 0, zoom: visibleZoom }, true);
  assert.equal(grid.style.backgroundImage, EXPECTED_DOTS_IMAGE);
  assert.equal(grid.style.backgroundSize, `${GRID_PITCH_PX * visibleZoom}px ${GRID_PITCH_PX * visibleZoom}px`);
});
