import test from 'node:test';
import assert from 'node:assert/strict';
import { FIREWORKS_DURATION_MS, reactionSeed } from './reaction-timeline.js';
import {
  FIREWORKS_LATEST_END_MS, FIREWORKS_PALETTE_SIZE, FIRST_BURST_BY_MS, FIREWORKS_SHAPE, LAUNCH_WINDOW_MS, MAX_PARTICLES_PER_SHOW,
  SHELL_COUNT_RANGE, burstAt, fireworksShow, litParticles, particleAt, particleCount, rocketAt,
} from './fireworks-physics.js';

const SEEDS = Array.from({ length: 200 }, (_, index) => reactionSeed(index * 7919, index + 1));
const DESKTOP = Object.freeze({ width: 1440, height: 900 });
const PHONE = Object.freeze({ width: 390, height: 844 });
const FRAME_MS = 16;
// The task asks for a show of about 2.5 to 3 seconds, with launches staggered over the first ~0.8 s.
const SHOW_RANGE_MS = Object.freeze([2500, 3000]);
const ABOUT_LAUNCH_WINDOW_MS = 800;
// Near the end of its life a particle is almost transparent rather than cut off at full brightness.
const END_OF_LIFE_SHARE = 0.97;
const FADED_ALPHA = 0.1;
const TWINKLE_SAMPLES = 40;

const shellsOf = (seed) => fireworksShow(seed).shells;
const everyShell = (check) => SEEDS.forEach((seed) => shellsOf(seed).forEach((shell) => check(shell, seed)));

test('a show is 3 to 5 shells, and different sends get different counts', () => {
  const counts = new Set();
  for (const seed of SEEDS) {
    const { length } = shellsOf(seed);
    assert.ok(length >= SHELL_COUNT_RANGE[0] && length <= SHELL_COUNT_RANGE[1], `${length} shells`);
    counts.add(length);
  }
  assert.deepEqual(SHELL_COUNT_RANGE, [3, 5]);
  assert.equal(counts.size, SHELL_COUNT_RANGE[1] - SHELL_COUNT_RANGE[0] + 1, 'every count in the range occurs');
});

test('the show lasts about 2.5 to 3 s and every shell has burst and faded inside it', () => {
  assert.ok(FIREWORKS_DURATION_MS >= SHOW_RANGE_MS[0] && FIREWORKS_DURATION_MS <= SHOW_RANGE_MS[1]);
  assert.ok(LAUNCH_WINDOW_MS <= ABOUT_LAUNCH_WINDOW_MS);
  assert.ok(FIREWORKS_LATEST_END_MS <= FIREWORKS_DURATION_MS, 'the slowest possible shell still ends in time');
  everyShell((shell) => {
    assert.ok(shell.launchMs >= 0 && shell.launchMs < LAUNCH_WINDOW_MS, `launch ${shell.launchMs}`);
    assert.ok(shell.burstMs > shell.launchMs, 'it rises before it bursts');
    assert.ok(shell.burstMs + shell.lifeMs <= FIREWORKS_DURATION_MS, `ends at ${shell.burstMs + shell.lifeMs}`);
  });
});

test('the first shell launches at once, the rest are staggered in launch order', () => {
  for (const seed of SEEDS) {
    const launches = shellsOf(seed).map((shell) => shell.launchMs);
    assert.equal(launches[0], 0);
    assert.ok(shellsOf(seed)[0].burstMs <= FIRST_BURST_BY_MS, 'a burst shows early in every show');
    assert.deepEqual([...launches].sort((one, other) => one - other), launches);
    assert.equal(new Set(launches).size, launches.length, 'no two shells launch together');
  }
});

test('particles plus rockets never exceed the per-show cap', () => {
  for (const seed of SEEDS) {
    const show = fireworksShow(seed);
    const counted = show.shells.reduce((sum, shell) => sum + shell.particles.length + 1, 0);
    assert.equal(particleCount(show), counted);
    assert.ok(counted <= MAX_PARTICLES_PER_SHOW, `${counted} > ${MAX_PARTICLES_PER_SHOW}`);
    assert.ok(show.shells.every((shell) => shell.particles.length > 0));
  }
});

test('a rocket rises from the bottom edge to its apex, then the burst takes over', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    everyShell((shell) => {
      const start = rocketAt(shell, shell.launchMs, viewport);
      assert.equal(start.y, viewport.height, 'launched from the bottom');
      assert.ok(start.x > 0 && start.x < viewport.width);
      const midMs = (shell.launchMs + shell.burstMs) / 2;
      const rising = rocketAt(shell, midMs, viewport);
      assert.ok(rising.y < start.y && rocketAt(shell, midMs - FRAME_MS, viewport).y > rising.y, 'it climbs');
      assert.equal(rocketAt(shell, shell.launchMs - 1, viewport), null, 'not before launch');
      assert.equal(rocketAt(shell, shell.burstMs, viewport), null, 'gone once it bursts');
      assert.notEqual(burstAt(shell, shell.burstMs), null);
      const apex = particleAt(shell, shell.particles[0], 0, viewport);
      assert.deepEqual(apex, { x: shell.apexX * viewport.width, y: shell.apexY * viewport.height });
      assert.ok(apex.y < viewport.height / 2, 'bursts in the upper half');
    });
  }
});

test('gravity: after its highest point every particle only falls, and it ends below that point', () => {
  everyShell((shell) => {
    for (const particle of shell.particles) {
      const ys = [];
      for (let age = 0; age < shell.lifeMs; age += FRAME_MS) ys.push(particleAt(shell, particle, age, DESKTOP).y);
      const apexIndex = ys.indexOf(Math.min(...ys));
      for (let index = apexIndex + 1; index < ys.length; index += 1) assert.ok(ys[index] >= ys[index - 1]);
      assert.ok(ys.at(-1) > ys[apexIndex], 'it droops');
    }
  });
});

test('drag: particles slow down as they fly', () => {
  everyShell((shell) => {
    const sideways = (particle, age) => Math.abs(particleAt(shell, particle, age + FRAME_MS, DESKTOP).x
      - particleAt(shell, particle, age, DESKTOP).x);
    const fastest = shell.particles.reduce((best, particle) => (sideways(particle, 0) > sideways(best, 0) ? particle : best));
    assert.ok(sideways(fastest, 0) > sideways(fastest, shell.lifeMs / 2), 'sideways speed falls');
  });
});

test('a burst fades to nearly nothing and is gone at the end of its life; all are gone by the duration', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    everyShell((shell) => {
      const late = burstAt(shell, shell.burstMs + shell.lifeMs * END_OF_LIFE_SHARE);
      assert.ok(late.alpha > 0 && late.alpha < FADED_ALPHA, `alpha ${late.alpha}`);
      assert.ok(burstAt(shell, shell.burstMs).alpha > late.alpha);
      assert.equal(burstAt(shell, shell.burstMs + shell.lifeMs), null);
      assert.equal(burstAt(shell, FIREWORKS_DURATION_MS), null);
      assert.equal(rocketAt(shell, FIREWORKS_DURATION_MS, viewport), null);
    });
  }
});

test('twinkling particles flicker on and off late in life; steady ones stay lit', () => {
  let flickered = 0;
  everyShell((shell) => {
    const early = burstAt(shell, shell.burstMs + 1);
    assert.equal(litParticles(shell, early).length, shell.particles.length, 'all lit after the burst');
    for (let sample = 0; sample < TWINKLE_SAMPLES; sample += 1) {
      const age = shell.lifeMs * (END_OF_LIFE_SHARE - sample / (TWINKLE_SAMPLES * 2));
      const shown = litParticles(shell, burstAt(shell, shell.burstMs + age));
      assert.ok(shell.particles.filter((particle) => !particle.twinkle).every((particle) => shown.includes(particle)));
      if (shown.length < shell.particles.length) flickered += 1;
    }
  });
  assert.ok(flickered > 0, 'some particles go dark late in life');
});

test('one seed gives the same show and positions everywhere; different seeds differ', () => {
  for (const seed of SEEDS.slice(0, 20)) {
    assert.deepEqual(fireworksShow(seed), fireworksShow(seed));
    assert.ok(Object.isFrozen(fireworksShow(seed).shells));
  }
  assert.notDeepEqual(fireworksShow(SEEDS[0]), fireworksShow(SEEDS[1]));
  const [shell] = shellsOf(SEEDS[5]);
  const age = FRAME_MS * 10;
  assert.deepEqual(particleAt(shell, shell.particles[3], age, PHONE), particleAt(shell, shell.particles[3], age, PHONE));
});

test('shells use palette slots and shapes from the named sets, and the shapes vary between sends', () => {
  const shapes = new Set();
  everyShell((shell) => {
    assert.ok(Number.isInteger(shell.colour) && shell.colour >= 0 && shell.colour < FIREWORKS_PALETTE_SIZE);
    assert.ok(Object.values(FIREWORKS_SHAPE).includes(shell.shape));
    shapes.add(shell.shape);
  });
  assert.equal(shapes.size, Object.values(FIREWORKS_SHAPE).length);
  for (const seed of SEEDS) {
    const colours = shellsOf(seed).map((shell) => shell.colour);
    colours.slice(1).forEach((colour, index) => assert.notEqual(colour, colours[index], 'neighbours differ in colour'));
  }
});
