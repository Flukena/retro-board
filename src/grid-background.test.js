import test from 'node:test';
import assert from 'node:assert/strict';
import { gridBackgroundForZoom } from './grid-background.js';
import { GRID_PITCH_PX } from './chrome-layout.js';
import { GRID_DOTS_MIN_ZOOM } from './viewport-limits.js';

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
