import { VIEWPORT_ZOOM_MIN } from './viewport-limits.js';

export const ZOOM_STEP_FACTOR = 1.2;

// Trackpad pinch emits small pixel deltas; mouse wheels emit much larger
// notches. Integrating their distance keeps event coalescing from changing
// zoom speed. Bound extreme input before exponentiation.
export const wheelZoomFactor = (deltaY, pinch = false) => {
  if (!Number.isFinite(deltaY)) return 1;
  const exponent = -deltaY * (pinch ? 0.01 : 0.002);
  return Math.exp(Math.max(-4, Math.min(4, exponent)));
};

// The DOM already contains an overscan around its snapped culling viewport.
// Zooming inside that coverage only needs a transform; rebuilding the item
// list on every 10% scale change creates avoidable layout/paint stalls.
export const viewportNeedsCullRefresh = (rendered, next, size) => {
  const z = Math.max(VIEWPORT_ZOOM_MIN, Math.round(rendered.zoom * 20) / 20);
  const x = Math.floor(rendered.x / 200) * 200;
  const y = Math.floor(rendered.y / 200) * 200;
  const margin = (z < 0.4 ? 320 : 600) / z;
  const nextMargin = 80 / next.zoom;
  return -next.x / next.zoom - nextMargin < -x / z - margin
    || -next.y / next.zoom - nextMargin < -y / z - margin
    || (size.w - next.x) / next.zoom + nextMargin > (size.w - x) / z + margin
    || (size.h - next.y) / next.zoom + nextMargin > (size.h - y) / z + margin;
};
