// Geometry and timing of reaction effects: pure functions of a seed and elapsed time, so every peer draws the same
// show for one send and the renderer only paints what these return.
import { FIREWORKS_REACTION } from '../../domain/board-reactions.js';
import { PALETTE } from '../ui/palette.js';

export const REACTION_LOOK = Object.freeze({ FIREWORKS: 'fireworks', FLOAT: 'float', STILL: 'still' });
export const FIREWORKS_DURATION_MS = 2000;
export const FLOAT_DURATION_MS = 2400;
// prefers-reduced-motion: a brief indicator that neither moves nor flashes.
export const STILL_DURATION_MS = 1600;
const LOOK_DURATION_MS = Object.freeze({
  [REACTION_LOOK.FIREWORKS]: FIREWORKS_DURATION_MS,
  [REACTION_LOOK.FLOAT]: FLOAT_DURATION_MS,
  [REACTION_LOOK.STILL]: STILL_DURATION_MS,
});

export const FIREWORKS_BURST_COUNT = 5;
export const SPARKS_PER_BURST = 24;
export const MAX_SPARKS_PER_SHOW = FIREWORKS_BURST_COUNT * SPARKS_PER_BURST;
const BURST_STAGGER_MS = 200;
const BURST_JITTER_MS = 80;
// The last burst starts by (count - 1) * stagger + jitter = 880 ms and its sparks live 1000 ms, inside the 2 s show.
const SPARK_LIFETIME_MS = 1000;
// Burst centres, as fractions of the viewport width and height.
const BURST_X_RANGE = Object.freeze([0.15, 0.85]);
const BURST_Y_RANGE = Object.freeze([0.15, 0.55]);
// How far a spark travels, and how far gravity pulls it, as fractions of the viewport's shorter side.
const SPARK_REACH_RANGE = Object.freeze([0.18, 0.32]);
const SPARK_SAG = 0.08;
const SPARK_ANGLE_JITTER_RAD = 0.2;
const SPARK_RADIUS_RANGE_PX = Object.freeze([2.5, 4.5]);
const SPARK_END_RADIUS_RATIO = 0.5;
const FULL_TURN_RAD = 2 * Math.PI;
const CENTRED_OFFSET = 0.5;

const FLOAT_LEFT_RANGE_PERCENT = Object.freeze([20, 80]);
const FLOAT_DRIFT_RANGE_PX = Object.freeze([-32, 32]);

// mulberry32 (public-domain PRNG by Tommy Ettinger): small, fast and seedable.
const MULBERRY_INCREMENT = 0x6d2b79f5;
const MULBERRY_SHIFT_A = 15;
const MULBERRY_SHIFT_B = 7;
const MULBERRY_SHIFT_C = 14;
const MULBERRY_MIX = 61;
const UINT32_RANGE = 2 ** 32;
const SEED_MULTIPLIER = 0x9e3779b1;

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let mixed = Math.imul(state ^ (state >>> MULBERRY_SHIFT_A), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> MULBERRY_SHIFT_B), mixed | MULBERRY_MIX);
    return ((mixed ^ (mixed >>> MULBERRY_SHIFT_C)) >>> 0) / UINT32_RANGE;
  };
}

/** One seed per send, identical on every peer: the sender's awareness id and its seq. */
export const reactionSeed = (clientId, seq) => (Math.imul(clientId >>> 0, SEED_MULTIPLIER) ^ seq) >>> 0;

export function reactionLook(emoji, reducedMotion) {
  if (reducedMotion) return REACTION_LOOK.STILL;
  return emoji === FIREWORKS_REACTION ? REACTION_LOOK.FIREWORKS : REACTION_LOOK.FLOAT;
}

export const lookDurationMs = (look) => LOOK_DURATION_MS[look];

const between = (random, [low, high]) => low + random() * (high - low);

/** The sparks of one fireworks show: a few bursts, each a ring of sparks in one palette colour. */
export function fireworksShow(seed) {
  const random = seededRandom(seed);
  const sparks = [];
  for (let burst = 0; burst < FIREWORKS_BURST_COUNT; burst += 1) {
    const originX = between(random, BURST_X_RANGE);
    const originY = between(random, BURST_Y_RANGE);
    const delayMs = burst * BURST_STAGGER_MS + random() * BURST_JITTER_MS;
    const colour = Math.floor(random() * PALETTE.length);
    for (let index = 0; index < SPARKS_PER_BURST; index += 1) {
      const angle = (index / SPARKS_PER_BURST) * FULL_TURN_RAD + (random() - CENTRED_OFFSET) * SPARK_ANGLE_JITTER_RAD;
      sparks.push(Object.freeze({
        originX, originY, delayMs, angle, colour,
        reach: between(random, SPARK_REACH_RANGE), radiusPx: between(random, SPARK_RADIUS_RANGE_PX),
      }));
    }
  }
  return Object.freeze(sparks);
}

/** Where one spark is `elapsedMs` into its show, in viewport pixels, or null while it is not visible. */
export function sparkAt(spark, elapsedMs, { width, height }) {
  const age = elapsedMs - spark.delayMs;
  if (age < 0 || age >= SPARK_LIFETIME_MS) return null;
  const progress = age / SPARK_LIFETIME_MS;
  const scale = Math.min(width, height);
  // Fast out, slowing down: ease-out on distance, with gravity adding a growing sag.
  const distance = spark.reach * scale * (1 - (1 - progress) ** 2);
  return {
    x: spark.originX * width + Math.cos(spark.angle) * distance,
    y: spark.originY * height + Math.sin(spark.angle) * distance + SPARK_SAG * scale * progress ** 2,
    alpha: 1 - progress ** 2,
    radiusPx: spark.radiusPx * (1 - SPARK_END_RADIUS_RATIO * progress),
  };
}

/** The lane a floating (or still) reaction uses: a horizontal position and a sideways drift. */
export function floatPlacement(seed) {
  const random = seededRandom(seed);
  return Object.freeze({
    leftPercent: between(random, FLOAT_LEFT_RANGE_PERCENT),
    driftPx: between(random, FLOAT_DRIFT_RANGE_PX),
  });
}
