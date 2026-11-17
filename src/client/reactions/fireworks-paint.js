// Paints fireworks shows onto a transparent 2D canvas over the board. Motion comes from the pure physics module;
// colours and glow strength come from theme tokens, so the show suits both the light and the dark board.
import {
  FIREWORKS_PALETTE_SIZE, FULL_TURN_RAD, burstAt, burstCentre, burstMotion, litParticles, particlePoint, rocketAt,
} from './fireworks-physics.js';

// Trails are soft streaks: a 3x retina backing store would cost more than it shows.
export const MAX_CANVAS_PIXEL_RATIO = 2;
// Theme tokens (theme.js) the painter reads: one colour per palette slot, the willow and rocket glitter, and how
// strongly the glow and the burst flash add up on this theme's board.
export const FIREWORKS_TOKENS = Object.freeze({
  colours: Object.freeze(Array.from({ length: FIREWORKS_PALETTE_SIZE }, (_, index) => `--fireworks-${index + 1}`)),
  glitter: '--fireworks-glitter',
  glowAlpha: '--fireworks-glow-alpha',
  flashAlpha: '--fireworks-flash-alpha',
});
// Overlapping light adds up, so dense trails glow; everything else goes back to normal painting.
const ADDITIVE = 'lighter';
const SOURCE_OVER = 'source-over';
const ROUND_CAP = 'round';
const OPAQUE = 1;
const DIAMETER_PER_RADIUS = 2;
// The glow pass under the brightest part of each trail is this many times wider than its core.
const GLOW_WIDTH_RATIO = 3;
// Trails fade from head to tail: a short bright head, then longer and fainter steps (shares of the trail length).
// Each step is one batched path for every particle of a shell.
const TRAIL_STEPS = Object.freeze([
  Object.freeze({ share: 0.2, alpha: 1 }),
  Object.freeze({ share: 0.35, alpha: 0.45 }),
  Object.freeze({ share: 0.45, alpha: 0.15 }),
]);
const HEAD_STEP = 0;
const ROCKET_RADIUS_PX = 1.3;
const ROCKET_TRAIL_MS = 180;
// The flash is a stack of ever smaller discs added together, so it is brightest in the middle and soft at the edge.
// Its radius is a fraction of the viewport's shorter side.
const FLASH_RADIUS_SHARE = 0.05;
const FLASH_DISC_COUNT = 6;
const NO_PARTICLES = 0;
const ROCKET_COUNT = 1;

/** Sizes the backing store to the viewport (only when it changed) and returns the drawing size in CSS pixels. */
export function fitCanvas(canvas, context, { innerWidth, innerHeight, devicePixelRatio = 1 }) {
  const ratio = Math.min(devicePixelRatio, MAX_CANVAS_PIXEL_RATIO);
  const width = Math.round(innerWidth * ratio);
  const height = Math.round(innerHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width: innerWidth, height: innerHeight };
}

/** The theme's fireworks look, read through `readToken(name)` (a CSS variable reader on the page). */
export function fireworksLook(readToken) {
  const read = (name) => readToken(name).trim();
  return Object.freeze({
    colours: Object.freeze(FIREWORKS_TOKENS.colours.map(read)),
    glitter: read(FIREWORKS_TOKENS.glitter),
    glowAlpha: Number(read(FIREWORKS_TOKENS.glowAlpha)),
    flashAlpha: Number(read(FIREWORKS_TOKENS.flashAlpha)),
  });
}

/** Strokes the current path: under the head step a faint wide glow first, then the core. */
function strokeStep(context, step, alpha, radiusPx, glowAlpha) {
  const width = radiusPx * DIAMETER_PER_RADIUS;
  if (step === HEAD_STEP) {
    context.globalAlpha = alpha * glowAlpha;
    context.lineWidth = width * GLOW_WIDTH_RATIO;
    context.stroke();
  }
  context.globalAlpha = alpha * TRAIL_STEPS[step].alpha;
  context.lineWidth = width;
  context.stroke();
}

/**
 * Paints a trail of `trailMs` behind each of `count` points, from `startMs` (the trail never reaches back before it) to
 * `nowMs`: one path per fading step, each holding that step of every point's trail. `momentAt(ms)` is what the points
 * share at a time (computed once per step end, and each step's tail is the next step's head); `pointOf(moment, index)`
 * places one point from it.
 */
function paintTrails(context, { count, momentAt, pointOf, startMs, nowMs, trailMs }, paint) {
  context.strokeStyle = paint.colour;
  let headMs = nowMs;
  let head = momentAt(headMs);
  for (let step = 0; step < TRAIL_STEPS.length; step += 1) {
    const tailMs = Math.max(startMs, headMs - TRAIL_STEPS[step].share * trailMs);
    if (step !== HEAD_STEP && headMs === tailMs) break;
    const tail = momentAt(tailMs);
    context.beginPath();
    for (let index = 0; index < count; index += 1) {
      const from = pointOf(tail, index);
      const to = pointOf(head, index);
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
    }
    strokeStep(context, step, paint.alpha, paint.radiusPx, paint.glowAlpha);
    headMs = tailMs;
    head = tail;
  }
}

const rocketPointOf = (point) => point;

function paintRocket(context, shell, elapsedMs, viewport, look) {
  const trail = {
    count: ROCKET_COUNT, momentAt: (ms) => rocketAt(shell, ms, viewport), pointOf: rocketPointOf,
    startMs: shell.launchMs, nowMs: elapsedMs, trailMs: ROCKET_TRAIL_MS,
  };
  const paint = { colour: look.glitter, alpha: OPAQUE, radiusPx: ROCKET_RADIUS_PX, glowAlpha: look.glowAlpha };
  paintTrails(context, trail, paint);
}

function paintFlash(context, shell, flash, viewport, look) {
  const { x, y } = burstCentre(shell, viewport);
  const radius = FLASH_RADIUS_SHARE * Math.min(viewport.width, viewport.height);
  context.fillStyle = look.glitter;
  context.globalAlpha = (flash * look.flashAlpha) / FLASH_DISC_COUNT;
  for (let disc = 0; disc < FLASH_DISC_COUNT; disc += 1) {
    context.beginPath();
    context.arc(x, y, radius * (1 - disc / FLASH_DISC_COUNT), 0, FULL_TURN_RAD);
    context.fill();
  }
}

/** Paints one shell (its rocket or its burst) and returns how many particles and rockets it drew. */
function paintShell(context, shell, elapsedMs, viewport, look) {
  if (rocketAt(shell, elapsedMs, viewport)) {
    paintRocket(context, shell, elapsedMs, viewport, look);
    return ROCKET_COUNT;
  }
  const burst = burstAt(shell, elapsedMs);
  if (!burst) return NO_PARTICLES;
  if (burst.flash > 0) paintFlash(context, shell, burst.flash, viewport, look);
  const lit = litParticles(shell, burst);
  const trail = {
    count: lit.length, momentAt: (ageMs) => burstMotion(shell, ageMs, viewport),
    pointOf: (motion, index) => particlePoint(motion, lit[index]),
    startMs: 0, nowMs: burst.ageMs, trailMs: shell.trailMs,
  };
  const colour = shell.glitter ? look.glitter : look.colours[shell.colour];
  paintTrails(context, trail, { colour, alpha: burst.alpha, radiusPx: burst.radiusPx, glowAlpha: look.glowAlpha });
  return lit.length;
}

/** Clears the canvas and paints every running shell of `shows` at `now`; returns how many particles it drew. */
export function paintFireworks(context, shows, now, viewport, look) {
  context.clearRect(0, 0, viewport.width, viewport.height);
  context.globalCompositeOperation = ADDITIVE;
  context.lineCap = ROUND_CAP;
  let drawn = 0;
  for (const show of shows) {
    const elapsedMs = now - show.startedAt;
    for (const shell of show.fireworks.shells) drawn += paintShell(context, shell, elapsedMs, viewport, look);
  }
  context.globalAlpha = OPAQUE;
  context.globalCompositeOperation = SOURCE_OVER;
  return drawn;
}

/** True while any of `shows` has not reached its end. */
export const showsRunning = (shows, now) => shows.some((show) => now < show.endsAt);

/**
 * Paints a frame on every animation frame while `isRunning(now)`, then stops by itself after painting the first frame
 * past the end (which clears the canvas). Returns a stop function for unmount.
 */
export function animateFireworks(paintFrame, isRunning, { requestFrame, cancelFrame, clock }) {
  let frame = null;
  const tick = () => {
    const now = clock();
    paintFrame(now);
    frame = isRunning(now) ? requestFrame(tick) : null;
  };
  frame = requestFrame(tick);
  return () => {
    if (frame !== null) cancelFrame(frame);
  };
}
