import { sizeForPlacement } from './board-geometry.js';
import { cardOverviewAtZoom } from './viewport-limits.js';

// Bounded overview preloading avoids mounting cards halfway through a pinch.
// Larger boards retain spatial culling instead of growing the DOM without limit.
export const OVERVIEW_PRELOAD_ITEM_LIMIT = 2048;
const LOW_ZOOM_THRESHOLD = 0.4;
const OVERVIEW_OVERSCAN_PX = 320;
const DETAIL_OVERSCAN_PX = 600;
// Offscreen cards retain their cheap DOM; native controls only need the visible viewport.
const STICKY_DETAIL_OVERSCAN_PX = 0;
// Keep cold native-card layout within the measured WebKit frame budget.
export const STICKY_DETAIL_BATCH_ITEM_LIMIT = 2;

function worldViewportBounds(viewport, size, overscanPx) {
  const z = viewport.zoom, margin = overscanPx / z;
  return { x0: (-viewport.x / z) - margin, y0: (-viewport.y / z) - margin,
    x1: (size.w - viewport.x) / z + margin, y1: (size.h - viewport.y) / z + margin };
}

export function viewportCullBounds(viewport, size) {
  return worldViewportBounds(viewport, size, viewport.zoom < LOW_ZOOM_THRESHOLD ? OVERVIEW_OVERSCAN_PX : DETAIL_OVERSCAN_PX);
}

// Phones mount only cards near the screen: on iPhone a full public wall
// (1,500 cards) mounted at once made Safari reload the page repeatedly.
export const preloadsOverview = ({ dense, phoneLayout }) => dense && !phoneLayout;

export function visibleBoardItems(items, viewport, size, preloadOverview = false) {
  const preloadCards = preloadOverview && items.length <= OVERVIEW_PRELOAD_ITEM_LIMIT;
  if (preloadCards && items.every(item => item.type === 'sticky')) return items;
  const { x0, y0, x1, y1 } = viewportCullBounds(viewport, size);
  return items.filter(item => {
    if (preloadCards && item.type === 'sticky') return true;
    const { w, h } = sizeForPlacement(item);
    return item.x + w >= x0 && item.x <= x1 && item.y + h >= y0 && item.y <= y1;
  });
}


export function detailedStickyIds(items, viewport, size, compact, dense) {
  if (!dense || items.length > OVERVIEW_PRELOAD_ITEM_LIMIT) return null;
  const ids = new Set();
  if (compact || cardOverviewAtZoom(viewport.zoom)) return ids;
  const { x0, y0, x1, y1 } = worldViewportBounds(viewport, size, STICKY_DETAIL_OVERSCAN_PX);
  for (const item of items) {
    if (item.type !== 'sticky') continue;
    const { w, h } = sizeForPlacement(item);
    if (item.x + w >= x0 && item.x <= x1 && item.y + h >= y0 && item.y <= y1) ids.add(item.id);
  }
  return ids;
}

export function usesCompactStickyPaint(id, compact, detailedIds) {
  return detailedIds === null ? compact : !detailedIds.has(id);
}

export function nextStickyDetailBatch(current, target) {
  if (target === null) return null;
  const next = new Set(current);
  let changed = 0;
  for (const id of next) {
    if (target.has(id)) continue;
    next.delete(id); changed++;
    if (changed === STICKY_DETAIL_BATCH_ITEM_LIMIT) return next;
  }
  for (const id of target) {
    if (next.has(id)) continue;
    next.add(id); changed++;
    if (changed === STICKY_DETAIL_BATCH_ITEM_LIMIT) return next;
  }
  return changed || current === null ? next : current;
}
