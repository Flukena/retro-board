import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as viewportLimits from './viewport-limits.js';
import { VIEWPORT_ZOOM_MIN, VIEWPORT_ZOOM_MAX } from './viewport-limits.js';

test('viewport zoom scale ranges from five percent to three hundred percent', () => {
  assert.equal(VIEWPORT_ZOOM_MIN, 0.05);
  assert.equal(VIEWPORT_ZOOM_MAX, 3);
});

test('card overview begins strictly below seven and a half percent zoom', () => {
  assert.equal(viewportLimits.CARD_OVERVIEW_ZOOM_MAX, 0.075);
  for (const [zoom, expected] of [[0.05, true], [0.074, true], [0.075, false], [0.4, false], [1, false]]) {
    assert.equal(viewportLimits.cardOverviewAtZoom(zoom), expected, `zoom ${zoom}`);
  }
});

test('settled overview uses only zoom regardless of card count', () => {
  const source = readFileSync(new URL('../RetroBoard.jsx', import.meta.url), 'utf8');
  const compactUpdate = source.split('\n').find((line) => line.includes('setCompactRender('));
  assert.equal(compactUpdate?.trim(), 'setCompactRender(cardOverviewAtZoom(viewportRef.current.zoom));');
});
