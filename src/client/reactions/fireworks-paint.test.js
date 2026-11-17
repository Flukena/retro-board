import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE } from '../ui/palette.js';
import { MAX_ACTIVE_SPARKS, addReaction, reactionEntry } from './reaction-feed.js';
import { FIREWORKS_DURATION_MS } from './reaction-timeline.js';
import { MAX_CANVAS_PIXEL_RATIO, fitCanvas, paintFireworks } from './fireworks-paint.js';

const NOW_MS = 1_700_000_000_000;
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const MID_SHOW_MS = 600;

/** Records what a 2D context is asked to draw. */
function recordingContext() {
  const calls = { strokes: 0, colours: [], cleared: 0, transform: null, alpha: [], segments: [] };
  let from = null;
  return {
    calls,
    set globalAlpha(value) { calls.alpha.push(value); },
    set strokeStyle(value) { calls.colours.push(value); },
    set lineWidth(value) { calls.width = value; },
    set lineCap(value) { calls.cap = value; },
    clearRect() { calls.cleared += 1; },
    beginPath() {},
    moveTo(x, y) { from = { x, y }; },
    lineTo(x, y) { calls.segments.push(Math.hypot(x - from.x, y - from.y)); },
    stroke() { calls.strokes += 1; },
    setTransform(...matrix) { calls.transform = matrix; },
  };
}

const shows = (count) => {
  let entries = [];
  for (let clientId = 1; clientId <= count; clientId += 1) {
    entries = addReaction(entries, reactionEntry({ clientId, seq: 1, emoji: '🎆', name: 'A' }, { reducedMotion: false, now: NOW_MS }), NOW_MS);
  }
  return entries;
};

test('mid-show it paints palette-coloured sparks, never more than the global spark cap', () => {
  const context = recordingContext();
  const drawn = paintFireworks(context, shows(10), NOW_MS + MID_SHOW_MS, VIEWPORT);
  assert.ok(drawn > 0 && drawn <= MAX_ACTIVE_SPARKS, `${drawn} sparks`);
  assert.equal(context.calls.strokes, drawn);
  const palette = new Set(PALETTE.map(({ border }) => border));
  assert.ok(context.calls.colours.every((colour) => palette.has(colour)));
  assert.equal(context.calls.cap, 'round', 'a spark that has not moved yet is still a round dot');
  assert.ok(context.calls.segments.some((length) => length > 0), 'moving sparks leave a short streak');
  assert.equal(context.calls.alpha.at(-1), 1, 'alpha is restored for the next frame');
});

test('after the named duration it only clears: nothing is left on screen', () => {
  const context = recordingContext();
  assert.equal(paintFireworks(context, shows(2), NOW_MS + FIREWORKS_DURATION_MS, VIEWPORT), 0);
  assert.equal(context.calls.cleared, 1);
  assert.equal(context.calls.strokes, 0);
});

test('the canvas matches the viewport, with the pixel ratio capped and no resize when unchanged', () => {
  const canvas = { width: 0, height: 0 };
  let resized = 0;
  const watched = {
    get width() { return canvas.width; }, set width(value) { resized += 1; canvas.width = value; },
    get height() { return canvas.height; }, set height(value) { canvas.height = value; },
  };
  const context = recordingContext();
  const RETINA_3X = 3;
  const size = fitCanvas(watched, context, { innerWidth: 390, innerHeight: 844, devicePixelRatio: RETINA_3X });
  assert.deepEqual(size, { width: 390, height: 844 });
  assert.deepEqual(canvas, { width: 390 * MAX_CANVAS_PIXEL_RATIO, height: 844 * MAX_CANVAS_PIXEL_RATIO });
  assert.deepEqual(context.calls.transform, [MAX_CANVAS_PIXEL_RATIO, 0, 0, MAX_CANVAS_PIXEL_RATIO, 0, 0]);
  fitCanvas(watched, context, { innerWidth: 390, innerHeight: 844, devicePixelRatio: RETINA_3X });
  assert.equal(resized, 1);
});
