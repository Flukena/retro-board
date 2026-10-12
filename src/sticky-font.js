import { DEFAULT_STICKY_WIDTH_PX } from './board-geometry.js';

// Derived from design 14px/135px card × our 200px card.
export const STICKY_DEFAULT_FONT_PX = 20;
const STICKY_CREATION_MIN_FONT_PX = 11;

export function stickyFontSize(item) {
  return item.fontSize || STICKY_DEFAULT_FONT_PX;
}

export function stickyCreationFontSize(widthPx) {
  return Math.max(STICKY_CREATION_MIN_FONT_PX,
    Math.round(STICKY_DEFAULT_FONT_PX * widthPx / DEFAULT_STICKY_WIDTH_PX));
}
