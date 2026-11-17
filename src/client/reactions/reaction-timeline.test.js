import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_REACTIONS, FIREWORKS_REACTION } from '../../domain/board-reactions.js';
import { PALETTE } from '../ui/palette.js';
import {
  FIREWORKS_DURATION_MS, FLOAT_DURATION_MS, MAX_SPARKS_PER_SHOW, REACTION_LOOK, STILL_DURATION_MS,
  fireworksShow, floatPlacement, lookDurationMs, reactionLook, reactionSeed, sparkAt,
} from './reaction-timeline.js';

const SEEDS = Array.from({ length: 50 }, (_, index) => reactionSeed(index * 7919, index + 1));
const DESKTOP = Object.freeze({ width: 1440, height: 900 });
const PHONE = Object.freeze({ width: 390, height: 844 });
const FRAME_MS = 16;
const ABOUT_TWO_SECONDS_MS = 2000;

test('fireworks are about two seconds; floats and the still indicator are brief', () => {
  assert.equal(FIREWORKS_DURATION_MS, ABOUT_TWO_SECONDS_MS);
  assert.ok(FLOAT_DURATION_MS <= ABOUT_TWO_SECONDS_MS * 1.5);
  assert.ok(STILL_DURATION_MS <= ABOUT_TWO_SECONDS_MS);
});

test('🎆 is fireworks, every other emoji floats, and reduced motion is always the still indicator', () => {
  for (const emoji of BOARD_REACTIONS) {
    assert.equal(reactionLook(emoji, false), emoji === FIREWORKS_REACTION ? REACTION_LOOK.FIREWORKS : REACTION_LOOK.FLOAT);
    assert.equal(reactionLook(emoji, true), REACTION_LOOK.STILL);
  }
  assert.equal(lookDurationMs(REACTION_LOOK.FIREWORKS), FIREWORKS_DURATION_MS);
  assert.equal(lookDurationMs(REACTION_LOOK.FLOAT), FLOAT_DURATION_MS);
  assert.equal(lookDurationMs(REACTION_LOOK.STILL), STILL_DURATION_MS);
});

test('a show has a bounded spark count with palette colours, and is the same on every screen for one seed', () => {
  for (const seed of SEEDS) {
    const sparks = fireworksShow(seed);
    assert.ok(sparks.length > 0 && sparks.length <= MAX_SPARKS_PER_SHOW, `${sparks.length} sparks`);
    assert.ok(sparks.every((spark) => Number.isInteger(spark.colour) && spark.colour >= 0 && spark.colour < PALETTE.length));
    assert.deepEqual(fireworksShow(seed), sparks, 'deterministic');
  }
  assert.notDeepEqual(fireworksShow(SEEDS[0]), fireworksShow(SEEDS[1]), 'different sends look different');
});

test('every spark has finished by the named duration, on desktop and phone', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    for (const seed of SEEDS) {
      const sparks = fireworksShow(seed);
      assert.ok(sparks.every((spark) => sparkAt(spark, FIREWORKS_DURATION_MS, viewport) === null));
    }
  }
});

test('sparks are visible mid-show, fade out, and start inside the viewport', () => {
  const sparks = fireworksShow(SEEDS[3]);
  let visible = 0;
  for (let elapsed = 0; elapsed < FIREWORKS_DURATION_MS; elapsed += FRAME_MS) {
    for (const spark of sparks) {
      const point = sparkAt(spark, elapsed, DESKTOP);
      if (!point) continue;
      visible += 1;
      assert.ok(point.alpha > 0 && point.alpha <= 1 && point.radiusPx > 0);
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  }
  assert.ok(visible > 0);
  for (const spark of sparks) {
    const start = sparkAt(spark, spark.delayMs, DESKTOP);
    assert.ok(start.x > 0 && start.x < DESKTOP.width && start.y > 0 && start.y < DESKTOP.height);
    assert.equal(sparkAt(spark, spark.delayMs - 1, DESKTOP), null, 'not before its burst');
  }
});

test('a spark is a pure function of seed and time', () => {
  const [spark] = fireworksShow(SEEDS[5]);
  const at = spark.delayMs + FRAME_MS * 10;
  assert.deepEqual(sparkAt(spark, at, PHONE), sparkAt(spark, at, PHONE));
});

test('float lanes stay clear of the screen edges and differ between sends', () => {
  const placements = SEEDS.map(floatPlacement);
  for (const { leftPercent, driftPx } of placements) {
    assert.ok(leftPercent >= 20 && leftPercent <= 80, `${leftPercent}%`);
    assert.ok(Number.isFinite(driftPx));
  }
  assert.ok(new Set(placements.map(({ leftPercent }) => Math.round(leftPercent))).size > 1);
});

test('the seed is the same for one (sender, seq) on every peer and differs per send', () => {
  assert.equal(reactionSeed(123456, 7), reactionSeed(123456, 7));
  assert.notEqual(reactionSeed(123456, 7), reactionSeed(123456, 8));
  assert.notEqual(reactionSeed(123456, 7), reactionSeed(654321, 7));
});
