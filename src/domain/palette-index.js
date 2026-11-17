export const PALETTE_COLOR_COUNT = 6;
export const DEFAULT_PALETTE_INDEX = 0;

export const isPaletteIndex = (value) => (
  Number.isSafeInteger(value) && value >= 0 && value < PALETTE_COLOR_COUNT
);
