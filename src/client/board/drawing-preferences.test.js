import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DRAWING_PREFERENCES, loadDrawingPreferences, saveDrawingPreferences } from './drawing-preferences.js';
import {
  DRAWING_DEFAULT_ERASER_WIDTH_SCREEN_PX, DRAWING_DEFAULT_WIDTH_SCREEN_PX, DRAWING_ERASER_WIDTHS_SCREEN_PX, DRAWING_WIDTHS_SCREEN_PX,
} from '../../domain/freehand-drawing.js';
import { FONT_COLORS } from '../ui/palette.js';

const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
};

test('defaults are the auto colour and the documented default widths', () => {
  assert.deepEqual(DEFAULT_DRAWING_PREFERENCES, {
    color: null, width: DRAWING_DEFAULT_WIDTH_SCREEN_PX, eraserWidth: DRAWING_DEFAULT_ERASER_WIDTH_SCREEN_PX,
  });
  assert.deepEqual(loadDrawingPreferences(memoryStorage()), DEFAULT_DRAWING_PREFERENCES);
});

test('the last colour and widths round-trip through storage', () => {
  const storage = memoryStorage();
  const prefs = { color: FONT_COLORS.at(-1).value, width: DRAWING_WIDTHS_SCREEN_PX[0], eraserWidth: DRAWING_ERASER_WIDTHS_SCREEN_PX.at(-1) };
  saveDrawingPreferences(storage, prefs);
  assert.deepEqual(loadDrawingPreferences(storage), prefs);
});

test('unknown or corrupt stored values fall back per field and storage errors never throw', () => {
  const storage = memoryStorage();
  storage.setItem('rb:drawing-preferences', JSON.stringify({ color: '#123456', width: 5, eraserWidth: DRAWING_ERASER_WIDTHS_SCREEN_PX[0] }));
  assert.deepEqual(loadDrawingPreferences(storage), { ...DEFAULT_DRAWING_PREFERENCES, eraserWidth: DRAWING_ERASER_WIDTHS_SCREEN_PX[0] });
  storage.setItem('rb:drawing-preferences', '{not json');
  assert.deepEqual(loadDrawingPreferences(storage), DEFAULT_DRAWING_PREFERENCES);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(loadDrawingPreferences(broken), DEFAULT_DRAWING_PREFERENCES);
  assert.doesNotThrow(() => saveDrawingPreferences(broken, DEFAULT_DRAWING_PREFERENCES));
  assert.deepEqual(loadDrawingPreferences(null), DEFAULT_DRAWING_PREFERENCES);
});
