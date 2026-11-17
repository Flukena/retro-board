// Fireworks motion: pure functions of a send's seed and the time since it started, so every peer draws the same show
// and the painter only draws what these return. Speeds are fractions of the viewport's shorter side per second, so a
// show keeps its shape on a phone and on a desktop.
import { between, seededRandom } from './reaction-timeline.js';

export const FIREWORKS_SHAPE = Object.freeze({ SPHERE: 'sphere', RING: 'ring', WILLOW: 'willow' });
export const SHELL_COUNT_RANGE = Object.freeze([3, 5]);
// Shells go up one after another over this window; the first goes up at once.
export const LAUNCH_WINDOW_MS = 800;
// Every particle and rocket one show may draw. Per frame the painter strokes each of them once per trail step plus once
// more for the glow under the head step (fireworks-paint.js: 3 steps + 1 glow = 4 segments), in about 4 stroke calls
// per shell, plus a 6-disc flash for each burst in its first 140 ms. With 4 shows overlapping (MAX_ACTIVE_BY_LOOK in
// reaction-feed.js) the worst case is 4 shows x 180 x 4 = 2880 segments a frame. On a 4x CPU-throttled emulated phone
// 4 x 180 kept the median frame at 16.7 ms; 4 x 240 doubled it.
export const MAX_PARTICLES_PER_SHOW = 180;
// Slots in the theme's fireworks palette (fireworks-paint.js reads one token per slot).
export const FIREWORKS_PALETTE_SIZE = 6;
const ROCKETS_PER_SHELL = 1;
const RISE_MS_RANGE = Object.freeze([520, 700]);
// Later shells launch in their own slot of the window, up to this share of the way into it.
const LAUNCH_JITTER_SHARE = 0.6;
// Launch points and apexes, as fractions of the viewport width and height (the bottom edge is 1).
const LAUNCH_X_RANGE = Object.freeze([0.12, 0.88]);
const APEX_DRIFT_RANGE = Object.freeze([-0.05, 0.05]);
const APEX_Y_RANGE = Object.freeze([0.16, 0.42]);
const BOTTOM_EDGE = 1;
// Three sphere shells for each ring and willow.
const SHAPE_ROLL = Object.freeze([
  FIREWORKS_SHAPE.SPHERE, FIREWORKS_SHAPE.SPHERE, FIREWORKS_SHAPE.SPHERE, FIREWORKS_SHAPE.RING, FIREWORKS_SHAPE.WILLOW,
]);
// Per shape: particle count, life, launch speed, drag, gravity, trail length, size and tilt (vertical squash of the
// burst). Speeds are viewport scales (the shorter side) per second. A sphere is filled (its particles fly at the
// projected speeds of points on a sphere); a ring is one tilted circle; a willow is slow, heavy, gold glitter with long
// drooping trails.
const SHAPE_PHYSICS = Object.freeze({
  [FIREWORKS_SHAPE.SPHERE]: Object.freeze({
    particleCount: [56, 80], lifeMs: [1000, 1150], speedScalePerS: [0.62, 0.78], dragPerS: 2.4,
    gravityScalePerS2: 0.3, trailMs: 170, radiusPx: [1.3, 1.7], tiltRatio: [1, 1], filled: true, glitter: false,
  }),
  [FIREWORKS_SHAPE.RING]: Object.freeze({
    particleCount: [40, 56], lifeMs: [950, 1100], speedScalePerS: [0.6, 0.72], dragPerS: 2.4,
    gravityScalePerS2: 0.26, trailMs: 130, radiusPx: [1.2, 1.6], tiltRatio: [0.45, 1], filled: false, glitter: false,
  }),
  [FIREWORKS_SHAPE.WILLOW]: Object.freeze({
    particleCount: [44, 60], lifeMs: [1150, 1250], speedScalePerS: [0.5, 0.62], dragPerS: 3,
    gravityScalePerS2: 0.55, trailMs: 320, radiusPx: [1, 1.3], tiltRatio: [1, 1], filled: true, glitter: true,
  }),
});
// The first shell launches at once, so a burst is on screen by this point of every show.
export const FIRST_BURST_BY_MS = RISE_MS_RANGE[1];
// The slowest shell: last launch, slowest rise and longest life. Tests hold it inside FIREWORKS_DURATION_MS.
export const FIREWORKS_LATEST_END_MS = LAUNCH_WINDOW_MS + RISE_MS_RANGE[1]
  + Math.max(...Object.values(SHAPE_PHYSICS).map(({ lifeMs }) => lifeMs[1]));
// Each particle's speed varies a little within its shell.
const PARTICLE_SPEED_JITTER = Object.freeze([0.92, 1]);
// Late in life about half the particles strobe on and off.
const TWINKLE_SHARE = 0.5;
const TWINKLE_FROM_PROGRESS = 0.55;
const TWINKLE_HZ = 14;
// Bright for most of its life, then a quick fade; trails thin out as they go.
const FADE_POWER = 2.5;
const END_RADIUS_SHRINK = 0.5;
// The burst's flash lasts this long.
const FLASH_MS = 140;
const MS_PER_SECOND = 1000;
export const FULL_TURN_RAD = 2 * Math.PI;
const TWINKLE_RAD_PER_MS = (FULL_TURN_RAD * TWINKLE_HZ) / MS_PER_SECOND;
const CENTRED_OFFSET = 0.5;
const UNIT_SPAN = 2;

const randomInt = (random, [low, high]) => Math.floor(between(random, [low, high + 1]));
const scaleOf = ({ width, height }) => Math.min(width, height);

/** The next palette slot, never the same as the previous shell's. */
function nextColour(random, previous) {
  if (previous === null) return Math.floor(random() * FIREWORKS_PALETTE_SIZE);
  return (previous + 1 + Math.floor(random() * (FIREWORKS_PALETTE_SIZE - 1))) % FIREWORKS_PALETTE_SIZE;
}

/** Velocities of `count` particles spread round the burst, in viewport scales per second. */
function burstParticles(random, physics, count) {
  const speed = between(random, physics.speedScalePerS);
  const tilt = between(random, physics.tiltRatio);
  const step = FULL_TURN_RAD / count;
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const angle = (index + random() - CENTRED_OFFSET) * step;
    const depth = physics.filled ? Math.sqrt(1 - (UNIT_SPAN * random() - 1) ** 2) : 1;
    const reach = speed * depth * between(random, PARTICLE_SPEED_JITTER);
    return Object.freeze({
      vxScalePerS: Math.cos(angle) * reach,
      vyScalePerS: Math.sin(angle) * reach * tilt,
      twinkle: random() < TWINKLE_SHARE,
      phase: random() * FULL_TURN_RAD,
    });
  }));
}

function shellAt(random, index, count, colour) {
  const slotMs = LAUNCH_WINDOW_MS / count;
  const launchMs = index === 0 ? 0 : (index + random() * LAUNCH_JITTER_SHARE) * slotMs;
  const shape = SHAPE_ROLL[Math.floor(random() * SHAPE_ROLL.length)];
  const physics = SHAPE_PHYSICS[shape];
  const launchX = between(random, LAUNCH_X_RANGE);
  const budget = Math.floor(MAX_PARTICLES_PER_SHOW / count) - ROCKETS_PER_SHELL;
  return Object.freeze({
    shape,
    colour,
    glitter: physics.glitter,
    launchMs,
    burstMs: launchMs + between(random, RISE_MS_RANGE),
    lifeMs: between(random, physics.lifeMs),
    launchX,
    apexX: launchX + between(random, APEX_DRIFT_RANGE),
    apexY: between(random, APEX_Y_RANGE),
    dragPerS: physics.dragPerS,
    gravityScalePerS2: physics.gravityScalePerS2,
    trailMs: physics.trailMs,
    radiusPx: between(random, physics.radiusPx),
    particles: burstParticles(random, physics, Math.min(budget, randomInt(random, physics.particleCount))),
  });
}

/** One send's show: 3 to 5 shells, launched from the bottom over the first LAUNCH_WINDOW_MS. */
export function fireworksShow(seed) {
  const random = seededRandom(seed);
  const count = randomInt(random, SHELL_COUNT_RANGE);
  const shells = [];
  let colour = null;
  for (let index = 0; index < count; index += 1) {
    colour = nextColour(random, colour);
    shells.push(shellAt(random, index, count, colour));
  }
  return Object.freeze({ shells: Object.freeze(shells) });
}

/** Particles plus one rocket per shell: everything the show can draw at once. */
export const particleCount = (show) => show.shells
  .reduce((sum, shell) => sum + shell.particles.length + ROCKETS_PER_SHELL, 0);

function rocketPoint(shell, elapsedMs, { width, height }) {
  const progress = (elapsedMs - shell.launchMs) / (shell.burstMs - shell.launchMs);
  // Decelerating like a thrown ball: fast off the ground, still at the apex.
  const climb = 1 - (1 - progress) ** 2;
  return {
    x: width * (shell.launchX + (shell.apexX - shell.launchX) * progress),
    y: height * (BOTTOM_EDGE + (shell.apexY - BOTTOM_EDGE) * climb),
  };
}

/** Where the rising rocket is, in viewport pixels, or null unless it is rising (launched and not yet burst). */
export function rocketAt(shell, elapsedMs, viewport) {
  if (elapsedMs < shell.launchMs || elapsedMs >= shell.burstMs) return null;
  return rocketPoint(shell, elapsedMs, viewport);
}

/** How a burst looks `elapsedMs` into the show (age, fade, size and flash), or null before it or once it is over. */
export function burstAt(shell, elapsedMs) {
  const ageMs = elapsedMs - shell.burstMs;
  if (ageMs < 0 || ageMs >= shell.lifeMs) return null;
  const progress = ageMs / shell.lifeMs;
  return {
    ageMs,
    progress,
    alpha: 1 - progress ** FADE_POWER,
    radiusPx: shell.radiusPx * (1 - END_RADIUS_SHRINK * progress),
    flash: Math.max(0, 1 - ageMs / FLASH_MS),
  };
}

/** The particles lit at this moment of `burst`: all of them, less the twinkling ones in an off beat late in life. */
export function litParticles(shell, burst) {
  if (burst.progress < TWINKLE_FROM_PROGRESS) return shell.particles;
  return shell.particles.filter((particle) => !particle.twinkle
    || Math.sin(burst.ageMs * TWINKLE_RAD_PER_MS + particle.phase) > 0);
}

/**
 * What every particle of a burst shares `ageMs` after it, in viewport pixels: the burst centre sagged by gravity, and
 * how far a particle at one scale per second has flown. Linear drag slows the particles towards a falling terminal
 * speed, so they fly out, slow down and droop: the closed form of dv/dt = gravity - drag * v.
 */
export function burstMotion(shell, ageMs, viewport) {
  const scale = scaleOf(viewport);
  const seconds = ageMs / MS_PER_SECOND;
  const travelledS = (1 - Math.exp(-shell.dragPerS * seconds)) / shell.dragPerS;
  const terminalScalePerS = shell.gravityScalePerS2 / shell.dragPerS;
  return {
    x: shell.apexX * viewport.width,
    y: shell.apexY * viewport.height + terminalScalePerS * (seconds - travelledS) * scale,
    reachPx: travelledS * scale,
  };
}

/** Where one particle is at the moment `motion` describes, in viewport pixels. */
export const particlePoint = (motion, particle) => ({
  x: motion.x + particle.vxScalePerS * motion.reachPx,
  y: motion.y + particle.vyScalePerS * motion.reachPx,
});

/** Where a particle is `ageMs` after its shell burst, in viewport pixels. */
export const particleAt = (shell, particle, ageMs, viewport) => particlePoint(
  burstMotion(shell, ageMs, viewport), particle,
);

/** The burst's centre in viewport pixels. */
export const burstCentre = (shell, viewport) => ({ x: shell.apexX * viewport.width, y: shell.apexY * viewport.height });
