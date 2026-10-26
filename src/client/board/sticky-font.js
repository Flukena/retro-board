import { DEFAULT_STICKY_WIDTH_PX, DEFAULT_STICKY_HEIGHT_PX } from '../../domain/board-geometry.js';
import { ITEM_MIN_SIZE_PX } from '../../domain/item-size-limits.js';

// Derived from design 14px/135px card × our 200px card.
export const STICKY_DEFAULT_FONT_PX = 20;
const STICKY_CREATION_MIN_FONT_PX = 11;
// A sticky created in a zone takes ~2.5% of the zone's area, so ~40 cards fit.
const STICKY_ZONE_AREA_SHARE = 0.025;
// Big zones would otherwise give 600px cards with 60px text.
export const STICKY_CREATION_MAX_WIDTH_PX = 300;
const STICKY_ASPECT = DEFAULT_STICKY_WIDTH_PX / DEFAULT_STICKY_HEIGHT_PX;

export function stickyFontSize(item) {
  return item.fontSize || STICKY_DEFAULT_FONT_PX;
}

export function stickyCreationFontSize(widthPx) {
  return Math.max(STICKY_CREATION_MIN_FONT_PX,
    Math.round(STICKY_DEFAULT_FONT_PX * widthPx / DEFAULT_STICKY_WIDTH_PX));
}

/** Size for a new sticky: zone-relative inside a zone, the default outside one. */
export function stickyCreationSize(zone) {
  if (!zone) return { w: DEFAULT_STICKY_WIDTH_PX, h: DEFAULT_STICKY_HEIGHT_PX };
  const targetW = Math.sqrt(zone.w * zone.h * STICKY_ZONE_AREA_SHARE * STICKY_ASPECT);
  const w = Math.round(Math.max(ITEM_MIN_SIZE_PX.sticky.w, Math.min(STICKY_CREATION_MAX_WIDTH_PX, targetW)));
  return { w, h: Math.round(w / STICKY_ASPECT), fontSize: stickyCreationFontSize(w) };
}
