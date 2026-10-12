import { toolbarAnchorY, SELECTION_TOOLBAR_GAP_PX } from './chrome-layout.js';

const DEFAULT_STICKY_WIDTH_PX = 200;
const DEFAULT_IMAGE_WIDTH_PX = 200;
const TEXT_ANCHOR_OFFSET_PX = 60;
const ZONE_TITLE_HEIGHT_PX = 40;
const CENTRE_DIVISOR = 2;
export const FONT_SIZE_MIN_PX = 10;
export const FONT_SIZE_MAX_PX = 96;
export const FONT_SIZE_STEP_PX = 2;
const FONT_SIZE_DEFAULT_PX = Object.freeze({ text: 40, zone: 14, sticky: 15 });

export function selectionToolbarAnchor(item, viewport, stackHeightPx) {
  let offsetX = TEXT_ANCHOR_OFFSET_PX;
  let offsetY = 0;
  if (item.type === 'zone') {
    offsetX = item.w * viewport.zoom / CENTRE_DIVISOR;
    offsetY = ZONE_TITLE_HEIGHT_PX * viewport.zoom;
  } else if (item.type === 'sticky' || item.type === 'image') {
    const defaultWidth = item.type === 'sticky' ? DEFAULT_STICKY_WIDTH_PX : DEFAULT_IMAGE_WIDTH_PX;
    offsetX = (item.w || defaultWidth) * viewport.zoom / CENTRE_DIVISOR;
  }
  return {
    x: item.x * viewport.zoom + viewport.x + offsetX,
    y: toolbarAnchorY(
      item.y * viewport.zoom + viewport.y - offsetY - SELECTION_TOOLBAR_GAP_PX, stackHeightPx,
    ),
  };
}

export function groupSelectionToolbarAnchor(groupBBox, viewport, stackHeightPx) {
  return {
    x: (groupBBox.x + groupBBox.w / CENTRE_DIVISOR) * viewport.zoom + viewport.x,
    y: toolbarAnchorY(groupBBox.y * viewport.zoom + viewport.y - SELECTION_TOOLBAR_GAP_PX, stackHeightPx),
  };
}

export function fontSizeForItem(item) { return item.fontSize || FONT_SIZE_DEFAULT_PX[item.type]; }
export function clampFontSize(size) { return Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, size)); }
export function canDecreaseFontSize(size, can) { return can && size > FONT_SIZE_MIN_PX; }
export function canIncreaseFontSize(size, can) { return can && size < FONT_SIZE_MAX_PX; }

export function selectionToolbarSections(type) {
  return {
    palette: type === 'sticky' || type === 'zone',
    fontSize: type === 'sticky' || type === 'zone' || type === 'text',
    fontColor: type === 'sticky' || type === 'text',
    privacy: type === 'sticky',
    zone: type === 'zone',
  };
}
