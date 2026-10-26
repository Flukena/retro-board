// Smallest and largest world size a user can resize an item to.
//
// The cap keeps graphics layers small enough for phones: WebKit backs a
// composited layer at its full CSS size × DPR² (DPR 3 on iPhone, so 9×), and
// iOS kills a Safari tab near 2GB. A 9,520px-wide image alone reached that.
// Items already larger than the cap are left as they are: they can shrink but
// not grow.

const size = (w, h) => Object.freeze({ w, h });

export const ZONE_MIN_WIDTH_PX = 240;
export const ZONE_MIN_HEIGHT_PX = 200;

export const ITEM_MIN_SIZE_PX = Object.freeze({
  zone: size(ZONE_MIN_WIDTH_PX, ZONE_MIN_HEIGHT_PX),
  sticky: size(120, 100),
  image: size(60, 40),
  text: size(60, 30),
});

// Longest allowed side per type, in world px.
export const ZONE_MAX_SIDE_PX = 4_800;
export const IMAGE_MAX_SIDE_PX = 2_400;
export const STICKY_MAX_SIDE_PX = 1_200;
export const TEXT_MAX_SIDE_PX = 2_400;

export const ITEM_MAX_SIDE_PX = Object.freeze({
  zone: ZONE_MAX_SIDE_PX,
  sticky: STICKY_MAX_SIDE_PX,
  image: IMAGE_MAX_SIDE_PX,
  text: TEXT_MAX_SIDE_PX,
});

// Group resize never shrinks below a tenth of the starting size.
const GROUP_MIN_SCALE = 0.1;
const DEFAULT_TYPE = 'zone';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const movesLeftEdge = corner => corner === 'nw' || corner === 'sw';
const movesTopEdge = corner => corner === 'nw' || corner === 'ne';

/** Size limits for one item, given its size when the resize started. */
export function itemSizeBounds(type, initial) {
  const min = ITEM_MIN_SIZE_PX[type] ?? ITEM_MIN_SIZE_PX[DEFAULT_TYPE];
  const cap = ITEM_MAX_SIDE_PX[type] ?? ITEM_MAX_SIDE_PX[DEFAULT_TYPE];
  return { minW: min.w, minH: min.h, maxW: Math.max(cap, initial.w), maxH: Math.max(cap, initial.h) };
}

/** Clamp a corner-drag rect to the bounds, keeping the opposite corner fixed. */
export function clampCornerResize(initial, corner, rect, bounds) {
  const w = clamp(rect.w, bounds.minW, bounds.maxW);
  const h = clamp(rect.h, bounds.minH, bounds.maxH);
  return {
    x: movesLeftEdge(corner) ? initial.x + initial.w - w : rect.x,
    y: movesTopEdge(corner) ? initial.y + initial.h - h : rect.y,
    w,
    h,
  };
}

/** Largest proportional scale that keeps both sides within the cap. */
export function clampAspectScale(scale, initial, bounds) {
  return Math.min(scale, bounds.maxW / initial.w, bounds.maxH / initial.h);
}

/** Scale range for a group resize so no item leaves its own bounds. */
export function groupScaleRange(seeds) {
  const range = { minX: GROUP_MIN_SCALE, minY: GROUP_MIN_SCALE, maxX: Infinity, maxY: Infinity };
  for (const seed of seeds) {
    const bounds = itemSizeBounds(seed.type, seed);
    if (seed.w > 0) {
      range.minX = Math.max(range.minX, bounds.minW / seed.w);
      range.maxX = Math.min(range.maxX, bounds.maxW / seed.w);
    }
    if (seed.h > 0) {
      range.minY = Math.max(range.minY, bounds.minH / seed.h);
      range.maxY = Math.min(range.maxY, bounds.maxH / seed.h);
    }
  }
  return range;
}
