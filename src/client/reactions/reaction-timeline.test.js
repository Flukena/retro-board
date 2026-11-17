import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_REACTIONS, FIREWORKS_REACTION } from '../../domain/board-reactions.js';
import {
  FIREWORKS_DURATION_MS, FLOAT_DURATION_MS, REACTION_LOOK, STILL_DURATION_MS,
  floatPlacement, lookDurationMs, reactionLook, reactionSeed,
} from './reaction-timeline.js';

const SEEDS = Array.from({ length: 50 }, (_, index) => reactionSeed(index * 7919, index + 1));
// Fireworks are a 2.5 to 3 s show; floats and the still indicator stay brief.
const FIREWORKS_RANGE_MS = Object.freeze([2500, 3000]);
const FLOAT_MAX_MS = 3000;
const STILL_MAX_MS = 2000;

test('fireworks last about 2.5 to 3 s; floats and the still indicator are brief', () => {
  assert.ok(FIREWORKS_DURATION_MS >= FIREWORKS_RANGE_MS[0] && FIREWORKS_DURATION_MS <= FIREWORKS_RANGE_MS[1]);
  assert.ok(FLOAT_DURATION_MS <= FLOAT_MAX_MS);
  assert.ok(STILL_DURATION_MS <= STILL_MAX_MS);
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
