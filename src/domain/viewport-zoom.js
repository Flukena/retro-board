import { viewportCullBounds } from './board-render-visibility.js';
import { VIEWPORT_ZOOM_MIN } from './viewport-limits.js';

export const ZOOM_STEP_FACTOR = 1.2;
const PINCH_ZOOM_SENSITIVITY = 0.01;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

// Trackpad pinch emits small pixel deltas; mouse wheels emit much larger
// notches. Integrating their distance keeps event coalescing from changing
// zoom speed. Bound extreme input before exponentiation.
export const wheelZoomFactor = (deltaY, pinch = false) => {
  if (!Number.isFinite(deltaY)) return 1;
  const exponent = -deltaY * (pinch ? PINCH_ZOOM_SENSITIVITY : WHEEL_ZOOM_SENSITIVITY);
  return Math.exp(Math.max(-4, Math.min(4, exponent)));
};

export const wheelDeltaForZoomFactor = (factor, pinch = false) => {
  if (!Number.isFinite(factor) || factor <= 0) return 0;
  return -Math.log(factor) / (pinch ? PINCH_ZOOM_SENSITIVITY : WHEEL_ZOOM_SENSITIVITY);
};

// The DOM already contains an overscan around its snapped culling viewport.
// Zooming inside that coverage only needs a transform; rebuilding the item
// list on every 10% scale change creates avoidable layout/paint stalls.
export const viewportNeedsCullRefresh = (rendered, next, size, allItemsRendered = false) => {
  if (allItemsRendered) return false;
  const z = Math.max(VIEWPORT_ZOOM_MIN, Math.round(rendered.zoom * 20) / 20);
  const x = Math.floor(rendered.x / 200) * 200;
  const y = Math.floor(rendered.y / 200) * 200;
  const bounds = viewportCullBounds({ x, y, zoom: z }, size);
  const nextMargin = 80 / next.zoom;
  return -next.x / next.zoom - nextMargin < bounds.x0
    || -next.y / next.zoom - nextMargin < bounds.y0
    || (size.w - next.x) / next.zoom + nextMargin > bounds.x1
    || (size.h - next.y) / next.zoom + nextMargin > bounds.y1;
};
