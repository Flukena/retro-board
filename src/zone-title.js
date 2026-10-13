// Screen geometry shared by theme, browser and relay vote finalization.
export const ZONE_TITLE_DEFAULT_FONT_PX = 32;
export const ZONE_COUNT_FONT_PX = 11;
export const ZONE_TITLE_LINE_HEIGHT_RATIO = 1.35;
export const ZONE_CHIP_PADDING_VERTICAL_PX = 6;
export const ZONE_CHIP_PADDING_HORIZONTAL_PX = 14;
export const ZONE_HEADER_INSET_PX = 14;
export const ZONE_HEADER_GAP_PX = 8;
export const ZONE_CHIP_MIN_WIDTH_PX = 80;
export const ZONE_ICON_BUTTON_SIZE_PX = 44;
export const ZONE_ICON_GLYPH_SIZE_PX = 32;
export const ZONE_ICON_GAP_PX = 2;
export const ZONE_HEADER_MENU_BREAKPOINT_PX = 72;
export const ZONE_HEADER_Z_INDEX = 4; // Above intra-card badge/medal layers (2/3).
const CHIP_VERTICAL_SIDES = 2;

export function zoneTitleFontSize(item) {
  return item.fontSize || ZONE_TITLE_DEFAULT_FONT_PX;
}

export function zoneHeaderClearancePx(zone) {
  const lineFontPx = Math.max(zoneTitleFontSize(zone), ZONE_COUNT_FONT_PX);
  return ZONE_HEADER_INSET_PX + lineFontPx * ZONE_TITLE_LINE_HEIGHT_RATIO
    + CHIP_VERTICAL_SIDES * ZONE_CHIP_PADDING_VERTICAL_PX + ZONE_HEADER_GAP_PX;
}
