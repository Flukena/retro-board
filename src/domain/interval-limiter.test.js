import test from 'node:test';
import assert from 'node:assert/strict';
import { IntervalLimiter } from './interval-limiter.js';

const START_MS = 50_000;
const INTERVAL_MS = 1000;
const HALF_INTERVAL_MS = INTERVAL_MS / 2;
const CLOCK_STEP_BACK_MS = 60_000;

test('one take per interval: a second inside it is dropped, one at its end is allowed', () => {
  const limiter = new IntervalLimiter(INTERVAL_MS);
  assert.equal(limiter.tryTake(START_MS), true);
  assert.equal(limiter.tryTake(START_MS + 1), false);
  assert.equal(limiter.tryTake(START_MS + INTERVAL_MS - 1), false);
  assert.equal(limiter.tryTake(START_MS + INTERVAL_MS), true);
});

test('dropped attempts do not extend the wait', () => {
  const limiter = new IntervalLimiter(INTERVAL_MS);
  limiter.tryTake(START_MS);
  for (let offset = 1; offset < INTERVAL_MS; offset += 100) limiter.tryTake(START_MS + offset);
  assert.equal(limiter.tryTake(START_MS + INTERVAL_MS), true);
});

test('attempts every 50 ms over three intervals succeed once per interval', () => {
  const limiter = new IntervalLimiter(INTERVAL_MS);
  const ATTEMPT_EVERY_MS = 50;
  const SPAN_MS = 3 * INTERVAL_MS;
  let taken = 0;
  for (let offset = 0; offset < SPAN_MS; offset += ATTEMPT_EVERY_MS) if (limiter.tryTake(START_MS + offset)) taken += 1;
  assert.equal(taken, SPAN_MS / INTERVAL_MS);
});

test('the remaining wait counts down to zero and does not take', () => {
  const limiter = new IntervalLimiter(INTERVAL_MS);
  assert.equal(limiter.remainingMs(START_MS), 0, 'nothing taken yet');
  limiter.tryTake(START_MS);
  assert.equal(limiter.remainingMs(START_MS + HALF_INTERVAL_MS), HALF_INTERVAL_MS);
  assert.equal(limiter.remainingMs(START_MS + HALF_INTERVAL_MS), HALF_INTERVAL_MS, 'asking twice changes nothing');
  assert.equal(limiter.remainingMs(START_MS + INTERVAL_MS), 0);
});

test('a clock that steps backwards counts as elapsed, so a correction never locks anyone out', () => {
  const limiter = new IntervalLimiter(INTERVAL_MS);
  limiter.tryTake(START_MS);
  assert.equal(limiter.remainingMs(START_MS - CLOCK_STEP_BACK_MS), 0);
  assert.equal(limiter.tryTake(START_MS - CLOCK_STEP_BACK_MS), true);
  assert.equal(limiter.tryTake(START_MS - CLOCK_STEP_BACK_MS + 1), false, 'the interval restarts from the new time');
});

test('with a budget of several per interval, the window slides: a slot frees when its take is an interval old', () => {
  const BUDGET = 3;
  const limiter = new IntervalLimiter(INTERVAL_MS, BUDGET);
  for (let index = 0; index < BUDGET; index += 1) assert.equal(limiter.tryTake(START_MS + index), true, `take ${index}`);
  assert.equal(limiter.tryTake(START_MS + BUDGET), false, 'budget spent');
  assert.equal(limiter.remainingMs(START_MS + HALF_INTERVAL_MS), HALF_INTERVAL_MS, 'until the oldest take leaves');
  assert.equal(limiter.tryTake(START_MS + INTERVAL_MS), true, 'the oldest slot is free again');
  assert.equal(limiter.tryTake(START_MS + INTERVAL_MS), false, 'the next slot is still a millisecond from free');
  assert.equal(limiter.tryTake(START_MS + INTERVAL_MS + 1), true, 'and frees an interval after its own take');
});
