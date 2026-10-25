import {
  DRAWING_DEFAULT_ERASER_WIDTH_SCREEN_PX, DRAWING_DEFAULT_WIDTH_SCREEN_PX, DRAWING_ERASER_WIDTHS_SCREEN_PX, DRAWING_WIDTHS_SCREEN_PX,
} from '../../domain/freehand-drawing.js';
import { FONT_COLORS } from '../ui/palette.js';

// Per-browser convenience only: losing it just resets the toolbar to defaults.
const STORAGE_KEY = 'rb:drawing-preferences';
const COLOR_VALUES = new Set(FONT_COLORS.map((entry) => entry.value));

export const DEFAULT_DRAWING_PREFERENCES = Object.freeze({
  color: null, width: DRAWING_DEFAULT_WIDTH_SCREEN_PX, eraserWidth: DRAWING_DEFAULT_ERASER_WIDTH_SCREEN_PX,
});

const pick = (value, allowed, fallback) => (allowed.has(value) ? value : fallback);

function readStored(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function loadDrawingPreferences(storage) {
  const stored = readStored(storage);
  return {
    color: pick(stored.color, COLOR_VALUES, DEFAULT_DRAWING_PREFERENCES.color),
    width: pick(stored.width, new Set(DRAWING_WIDTHS_SCREEN_PX), DEFAULT_DRAWING_PREFERENCES.width),
    eraserWidth: pick(stored.eraserWidth, new Set(DRAWING_ERASER_WIDTHS_SCREEN_PX), DEFAULT_DRAWING_PREFERENCES.eraserWidth),
  };
}

export function saveDrawingPreferences(storage, preferences) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Blocked or full storage only loses the remembered toolbar choice.
  }
}
