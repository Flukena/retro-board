import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MINUTE_MS, TIMER_MAX_MINUTES, TIMER_MIN_MINUTES, clampTimerMinutes, clampToRange, countdownLabel, extendedDeadline,
} from './countdown.js';

const NOW_MS = 1_000_000;
const SECOND_MS = 1000;

test('the label is mm:ss and counts a started second as a whole one, so 00:00 shows only at the end', () => {
  assert.equal(countdownLabel(0), '00:00');
  assert.equal(countdownLabel(1), '00:01');
  assert.equal(countdownLabel(SECOND_MS), '00:01');
  assert.equal(countdownLabel(MINUTE_MS - SECOND_MS + 1), '01:00');
  assert.equal(countdownLabel(3 * MINUTE_MS), '03:00');
  assert.equal(countdownLabel(TIMER_MAX_MINUTES * MINUTE_MS), '120:00');
});

test('extending a running countdown adds to its deadline', () => {
  const endsAt = NOW_MS + 30 * SECOND_MS;
  assert.equal(extendedDeadline(endsAt, NOW_MS, 1), endsAt + MINUTE_MS);
});

test('extending a countdown that has already ended, or has no deadline, starts from now', () => {
  assert.equal(extendedDeadline(NOW_MS - SECOND_MS, NOW_MS, 2), NOW_MS + 2 * MINUTE_MS);
  assert.equal(extendedDeadline(null, NOW_MS, 1), NOW_MS + MINUTE_MS);
});

test('minutes clamp to the timer range, and anything non-numeric becomes the minimum', () => {
  assert.equal(clampTimerMinutes(0), TIMER_MIN_MINUTES);
  assert.equal(clampTimerMinutes(TIMER_MAX_MINUTES + 1), TIMER_MAX_MINUTES);
  assert.equal(clampTimerMinutes('7'), 7);
  assert.equal(clampTimerMinutes('abc'), TIMER_MIN_MINUTES);
  assert.equal(clampToRange(Number.NaN, 2, 9), 2);
});
