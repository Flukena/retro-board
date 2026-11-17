// Fireworks motion: pure functions of a send's seed and the time since it started, so every peer draws the same show
// and the painter only draws what these return. Speeds are fractions of the viewport's shorter side per second, so a
// show keeps its shape on a phone and on a desktop.
import { between, seededRandom } from './reaction-timeline.js';

export const FIREWORKS_SHAPE = Object.freeze({ SPHERE: 'sphere', RING: 'ring', WILLOW: 'willow' });
export const SHELL_COUNT_RANGE = Object.freeze([3, 5]);
// Shells go up one after another over this window; the first goes up at once.
export const LAUNCH_WINDOW_MS = 800;
// Every particle and rocket one show may draw. Shows overlap (see reaction-feed.js), so this keeps a low-end phone
// within a few hundred trail segments a frame.
export const MAX_PARTICLES_PER_SHOW = 240;
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
// Per shape: particle count, life, launch speed, drag (1/s), gravity, trail length and size. A sphere is filled (its
// particles fly at the projected speeds of points on a sphere); a ring is one tilted circle; a willow is slow, heavy,
// gold glitter with long drooping trails.
const SHAPE_PHYSICS = Object.freeze({
  [FIREWORKS_SHAPE.SPHERE]: Object.freeze({
    particles: [56, 80], lifeMs: [1000, 1150], speed: [0.62, 0.78], drag: 2.4, gravity: 0.3, trailMs: 170,
    radiusPx: [1.3, 1.7], tilt: [1, 1], filled: true, glitter: false,
  }),
  [FIREWORKS_SHAPE.RING]: Object.freeze({
    particles: [40, 56], lifeMs: [950, 1100], speed: [0.6, 0.72], drag: 2.4, gravity: 0.26, trailMs: 130,
    radiusPx: [1.2, 1.6], tilt: [0.45, 1], filled: false, glitter: false,
  }),
  [FIREWORKS_SHAPE.WILLOW]: Object.freeze({
    particles: [44, 60], lifeMs: [1150, 1250], speed: [0.5, 0.62], drag: 3, gravity: 0.55, trailMs: 320,
    radiusPx: [1, 1.3], tilt: [1, 1], filled: true, glitter: true,
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
const FULL_TURN_RAD = 2 * Math.PI;
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
  const speed = between(random, physics.speed);
  const tilt = between(random, physics.tilt);
  const step = FULL_TURN_RAD / count;
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const angle = (index + random() - CENTRED_OFFSET) * step;
    const depth = physics.filled ? Math.sqrt(1 - (UNIT_SPAN * random() - 1) ** 2) : 1;
    const reach = speed * depth * between(random, PARTICLE_SPEED_JITTER);
    return Object.freeze({
      vx: Math.cos(angle) * reach,
      vy: Math.sin(angle) * reach * tilt,
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
    drag: physics.drag,
    gravity: physics.gravity,
    trailMs: physics.trailMs,
    radiusPx: between(random, physics.radiusPx),
    particles: burstParticles(random, physics, Math.min(budget, randomInt(random, physics.particles))),
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
 * Where a particle is `ageMs` after its shell burst, in viewport pixels. Linear drag slows it towards a falling
 * terminal speed, so it flies out, slows down and droops: the closed form of dv/dt = gravity - drag * v.
 */
export function particleAt(shell, particle, ageMs, viewport) {
  const scale = scaleOf(viewport);
  const seconds = ageMs / MS_PER_SECOND;
  const travelled = (1 - Math.exp(-shell.drag * seconds)) / shell.drag;
  const terminal = shell.gravity / shell.drag;
  return {
    x: shell.apexX * viewport.width + particle.vx * travelled * scale,
    y: shell.apexY * viewport.height + (particle.vy * travelled + terminal * (seconds - travelled)) * scale,
  };
}

/** The burst's centre in viewport pixels. */
export const burstCentre = (shell, viewport) => ({ x: shell.apexX * viewport.width, y: shell.apexY * viewport.height });
