import { DEFAULT_STICKY_WIDTH_PX, DEFAULT_STICKY_HEIGHT_PX } from './board-geometry.js';
import { VIEWPORT_ZOOM_MIN, VIEWPORT_ZOOM_MAX } from './viewport-limits.js';

// Screen pixels on each side, whatever the zoom: clears the 72 px top bar.
// Narrow screens use at most a tenth of the side so content stays readable.
const FIT_SCREEN_PADDING_PX = 80;
const FIT_PADDING_MAX_FRACTION = 0.1;
const FIT_PADDING_SIDES = 2;
const MIN_FIT_AREA_PX = 1;
const DEFAULT_ITEM_WIDTH_PX = 200;
const DEFAULT_ITEM_HEIGHT_PX = 60;
const DEFAULT_IMAGE_SIZE_PX = 200;
const VIEW_CENTER_FRACTION = 0.5;
const DEFAULT_ZOOM_SCALE = 1;

const clampZoom = (zoom) => Math.max(VIEWPORT_ZOOM_MIN, Math.min(VIEWPORT_ZOOM_MAX, zoom));

export const zoomViewportAt = (viewport, targetZoom, screenAnchor) => {
  const zoom = clampZoom(targetZoom);
  const worldX = (screenAnchor.x - viewport.x) / viewport.zoom;
  const worldY = (screenAnchor.y - viewport.y) / viewport.zoom;
  return {
    zoom,
    x: screenAnchor.x - worldX * zoom,
    y: screenAnchor.y - worldY * zoom,
  };
};

const itemSize = (item) => {
  if (item.type === 'zone') return { w: item.w, h: item.h };
  if (item.type === 'sticky') return {
    w: item.w || DEFAULT_STICKY_WIDTH_PX,
    h: item.h || DEFAULT_STICKY_HEIGHT_PX,
  };
  if (item.type === 'image') return {
    w: item.w || DEFAULT_IMAGE_SIZE_PX,
    h: item.h || DEFAULT_IMAGE_SIZE_PX,
  };
  return { w: DEFAULT_ITEM_WIDTH_PX, h: DEFAULT_ITEM_HEIGHT_PX };
};

export const fitViewportToItems = (items, width, height) => {
  if (items.length === 0) return {
    x: width * VIEW_CENTER_FRACTION, y: height * VIEW_CENTER_FRACTION, zoom: DEFAULT_ZOOM_SCALE,
  };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  items.forEach((item) => {
    const { w, h } = itemSize(item);
    minX = Math.min(minX, item.x); minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + w); maxY = Math.max(maxY, item.y + h);
  });
  const fitArea = (side) => {
    const padding = Math.min(FIT_SCREEN_PADDING_PX, side * FIT_PADDING_MAX_FRACTION);
    return Math.max(MIN_FIT_AREA_PX, side - padding * FIT_PADDING_SIDES);
  };
  const zoom = clampZoom(Math.min(fitArea(width) / (maxX - minX), fitArea(height) / (maxY - minY)));
  const cx = (minX + maxX) * VIEW_CENTER_FRACTION;
  const cy = (minY + maxY) * VIEW_CENTER_FRACTION;
  return {
    zoom,
    x: width * VIEW_CENTER_FRACTION - cx * zoom,
    y: height * VIEW_CENTER_FRACTION - cy * zoom,
  };
};
