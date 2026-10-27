import test from 'node:test';
import assert from 'node:assert/strict';
import { retroLoopTemplate } from './retro-loop-template.js';
import { fitViewportToItems } from '../../domain/viewport-framing.js';
import { zoneTitleFontSize, ZONE_AUTO_TITLE_MAX_FONT_PX } from '../../domain/zone-title.js';

const DESKTOP_VIEWPORT_PX = Object.freeze({ w: 1440, h: 900 });
// Below this zoom, zone titles render under ~10px on a laptop screen.
const MIN_READABLE_FIT_ZOOM = 0.4;
test('Retro Loop fits a desktop screen at a readable zoom with headers below the title-size cap', () => {
  const [wrapper, ...columns] = retroLoopTemplate().zones;
  const fit = fitViewportToItems([{ type: 'zone', ...wrapper }], DESKTOP_VIEWPORT_PX.w, DESKTOP_VIEWPORT_PX.h);
  assert.ok(fit.zoom >= MIN_READABLE_FIT_ZOOM, `fit zoom ${fit.zoom}`);
  for (const column of columns) assert.ok(zoneTitleFontSize(column) < ZONE_AUTO_TITLE_MAX_FONT_PX, column.title);
});
