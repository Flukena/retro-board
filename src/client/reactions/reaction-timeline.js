// Geometry and timing of reaction effects: pure functions of a seed and elapsed time, so every peer draws the same
// show for one send and the renderer only paints what these return.
import { FIREWORKS_REACTION } from '../../domain/board-reactions.js';

export const REACTION_LOOK = Object.freeze({ FIREWORKS: 'fireworks', FLOAT: 'float', STILL: 'still' });
// Long enough for staggered shells to rise, burst and fade (fireworks-physics.js fits every shell inside it).
export const FIREWORKS_DURATION_MS = 2800;
export const FLOAT_DURATION_MS = 2400;
// prefers-reduced-motion: a brief indicator that neither moves nor flashes.
export const STILL_DURATION_MS = 1600;
const LOOK_DURATION_MS = Object.freeze({
  [REACTION_LOOK.FIREWORKS]: FIREWORKS_DURATION_MS,
  [REACTION_LOOK.FLOAT]: FLOAT_DURATION_MS,
  [REACTION_LOOK.STILL]: STILL_DURATION_MS,
});

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

/** A value drawn evenly from `[low, high)` with the seeded `random`. */
export const between = (random, [low, high]) => low + random() * (high - low);

/** The lane a floating (or still) reaction uses: a horizontal position and a sideways drift. */
export function floatPlacement(seed) {
  const random = seededRandom(seed);
  return Object.freeze({
    leftPercent: between(random, FLOAT_LEFT_RANGE_PERCENT),
    driftPx: between(random, FLOAT_DRIFT_RANGE_PX),
  });
}
