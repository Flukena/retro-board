// Shared geometry also supplies theme tokens so CSS and board calculations agree.
export const ZONE_TITLE_DEFAULT_FONT_PX = 24;
export const ZONE_TITLE_LINE_HEIGHT_RATIO = 1.25;
export const ZONE_CHIP_PADDING_VERTICAL_EM = 0.375;
export const ZONE_CHIP_PADDING_HORIZONTAL_EM = 0.875;
export const ZONE_TITLE_BODY_GAP_EM = 0.5;
const CHIP_VERTICAL_SIDES = 2;

export function zoneTitleFontSize(item) {
  return item.fontSize || ZONE_TITLE_DEFAULT_FONT_PX;
}

export function zoneTitleHeight(item) {
  return zoneTitleFontSize(item) * (ZONE_TITLE_LINE_HEIGHT_RATIO
    + CHIP_VERTICAL_SIDES * ZONE_CHIP_PADDING_VERTICAL_EM + ZONE_TITLE_BODY_GAP_EM);
}
