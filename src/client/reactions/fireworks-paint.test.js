import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKENS } from '../ui/theme.js';
import { contrastRatio } from '../ui/color-contrast.js';
import { MIN_NON_TEXT_CONTRAST_RATIO } from '../../test-support/contrast.js';
import { MAX_ACTIVE_PARTICLES, addReaction, reactionEntry } from './reaction-feed.js';
import { FIREWORKS_DURATION_MS } from './reaction-timeline.js';
import { FIREWORKS_PALETTE_SIZE, burstAt } from './fireworks-physics.js';
import {
  FIREWORKS_TOKENS, MAX_CANVAS_PIXEL_RATIO, animateFireworks, fireworksLook, fitCanvas, paintFireworks, showsRunning,
} from './fireworks-paint.js';

const NOW_MS = 1_700_000_000_000;
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const FRAME_MS = 16;
const ADDITIVE = 'lighter';
const SOURCE_OVER = 'source-over';
// Each shell is drawn as batched paths whatever its particle count: three fading trail steps and one glow pass.
const PASSES_PER_SHELL = 4;
const LOOK = Object.freeze({
  colours: Object.freeze(Array.from({ length: FIREWORKS_PALETTE_SIZE }, (_, index) => `colour-${index}`)),
  glitter: 'glitter', glowAlpha: 0.3, flashAlpha: 0.5,
});

/** Records what a 2D context is asked to draw. */
function recordingContext() {
  const calls = { strokes: 0, fills: 0, colours: new Set(), cleared: 0, transform: null, alpha: [], composite: [], segments: 0 };
  return {
    calls,
    set globalAlpha(value) { calls.alpha.push(value); },
    set globalCompositeOperation(value) { calls.composite.push(value); },
    set strokeStyle(value) { calls.colours.add(value); },
    set fillStyle(value) { calls.colours.add(value); },
    set lineWidth(value) { calls.width = value; },
    set lineCap(value) { calls.cap = value; },
    clearRect() { calls.cleared += 1; },
    beginPath() {},
    moveTo() {},
    lineTo() { calls.segments += 1; },
    arc() {},
    stroke() { calls.strokes += 1; },
    fill() { calls.fills += 1; },
    setTransform(...matrix) { calls.transform = matrix; },
  };
}

const showsOf = (count, startedAt = NOW_MS) => {
  let entries = [];
  for (let clientId = 1; clientId <= count; clientId += 1) {
    entries = addReaction(entries, reactionEntry({ clientId, seq: 1, emoji: '🎆', name: 'A' }, { reducedMotion: false, now: startedAt }), startedAt);
  }
  return entries;
};
const shellTotal = (entries) => entries.reduce((sum, entry) => sum + entry.fireworks.shells.length, 0);

test('mid-show it paints palette colours additively, batched per shell, never more than the global particle cap', () => {
  const entries = showsOf(10);
  const [shell] = entries[0].fireworks.shells;
  const context = recordingContext();
  const drawn = paintFireworks(context, entries, NOW_MS + shell.burstMs + FRAME_MS * 4, VIEWPORT, LOOK);
  assert.ok(drawn > 0 && drawn <= MAX_ACTIVE_PARTICLES, `${drawn} particles`);
  assert.ok(context.calls.strokes <= shellTotal(entries) * PASSES_PER_SHELL, `${context.calls.strokes} strokes`);
  assert.ok(context.calls.segments >= drawn, 'every drawn particle is a trail segment');
  const known = new Set([...LOOK.colours, LOOK.glitter]);
  assert.ok([...context.calls.colours].every((colour) => known.has(colour)), 'only the themed palette');
  assert.equal(context.calls.composite[0], ADDITIVE, 'glow adds up instead of covering');
  assert.equal(context.calls.composite.at(-1), SOURCE_OVER, 'the blend mode is restored');
  assert.equal(context.calls.alpha.at(-1), 1, 'alpha is restored for the next frame');
  assert.equal(context.calls.cap, 'round');
});

test('a fresh burst flashes once, and the flash is over well before the particles fade', () => {
  const entries = showsOf(1);
  const [shell] = entries[0].fireworks.shells;
  const atBurst = recordingContext();
  paintFireworks(atBurst, entries, NOW_MS + shell.burstMs, VIEWPORT, LOOK);
  assert.ok(atBurst.calls.fills > 0, 'flash');
  assert.ok(burstAt(shell, shell.burstMs).flash > 0);
  assert.equal(burstAt(shell, shell.burstMs + shell.lifeMs / 2).flash, 0);
});

test('at the named duration it only clears: nothing is left on screen', () => {
  const context = recordingContext();
  assert.equal(paintFireworks(context, showsOf(3), NOW_MS + FIREWORKS_DURATION_MS, VIEWPORT, LOOK), 0);
  assert.equal(context.calls.cleared, 1);
  assert.equal(context.calls.strokes + context.calls.fills, 0);
});

test('a show runs until its end; the frame loop stops itself there, and on unmount', () => {
  const entries = showsOf(1);
  assert.equal(showsRunning(entries, NOW_MS), true);
  assert.equal(showsRunning(entries, NOW_MS + FIREWORKS_DURATION_MS - 1), true);
  assert.equal(showsRunning(entries, NOW_MS + FIREWORKS_DURATION_MS), false);
  assert.equal(showsRunning([], NOW_MS), false);

  let clock = NOW_MS;
  let pending = null;
  const painted = [];
  const frames = { requestFrame: (callback) => { pending = callback; return painted.length + 1; }, cancelFrame: () => { pending = null; } };
  animateFireworks((now) => painted.push(now), (now) => showsRunning(entries, now), { ...frames, clock: () => clock });
  while (pending && painted.length < FIREWORKS_DURATION_MS) {
    const next = pending;
    pending = null;
    next();
    clock += FRAME_MS;
  }
  assert.equal(pending, null, 'no frame is requested after the end');
  assert.ok(painted.at(-1) >= NOW_MS + FIREWORKS_DURATION_MS, 'the last frame is painted after the end, clearing it');
  assert.ok(painted.at(-2) < NOW_MS + FIREWORKS_DURATION_MS);

  pending = null;
  clock = NOW_MS;
  const stop = animateFireworks(() => {}, () => true, { ...frames, clock: () => clock });
  assert.notEqual(pending, null);
  stop();
  assert.equal(pending, null, 'unmount cancels the pending frame');
});

test('the look is read from the theme tokens by name', () => {
  const values = { ...TOKENS.dark, [FIREWORKS_TOKENS.glowAlpha]: ' 0.3 ' };
  const look = fireworksLook((name) => values[name] ?? '');
  assert.equal(look.colours.length, FIREWORKS_PALETTE_SIZE);
  assert.deepEqual(look.colours, FIREWORKS_TOKENS.colours.map((name) => TOKENS.dark[name]));
  assert.equal(look.glitter, TOKENS.dark[FIREWORKS_TOKENS.glitter]);
  assert.equal(look.glowAlpha, 0.3);
  assert.equal(look.flashAlpha, Number(TOKENS.dark[FIREWORKS_TOKENS.flashAlpha]));
});

test('both themes define every fireworks colour, readable against their own board background', () => {
  for (const [mode, tokens] of Object.entries(TOKENS)) {
    for (const name of [...FIREWORKS_TOKENS.colours, FIREWORKS_TOKENS.glitter]) {
      assert.ok(Object.hasOwn(tokens, name), `${mode}: missing ${name}`);
      const ratio = contrastRatio(tokens[name], tokens['--bg']);
      assert.ok(ratio >= MIN_NON_TEXT_CONTRAST_RATIO, `${mode}: ${name} contrast ${ratio.toFixed(2)}`);
    }
    for (const name of [FIREWORKS_TOKENS.glowAlpha, FIREWORKS_TOKENS.flashAlpha]) {
      const alpha = Number(tokens[name]);
      assert.ok(alpha > 0 && alpha <= 1, `${mode}: ${name} = ${tokens[name]}`);
    }
  }
  assert.ok(Number(TOKENS.light[FIREWORKS_TOKENS.flashAlpha]) < Number(TOKENS.dark[FIREWORKS_TOKENS.flashAlpha]),
    'additive light washes out on the white board, so its flash is softer');
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
