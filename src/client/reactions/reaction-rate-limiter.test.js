import test from 'node:test';
import assert from 'node:assert/strict';
import { REACTION_SEND_INTERVAL_MS, ReactionRateLimiter } from './reaction-rate-limiter.js';

const START_MS = 50_000;
const HALF_INTERVAL_MS = REACTION_SEND_INTERVAL_MS / 2;

test('about one send per second per person: the owner asked for ~1/s', () => {
  assert.equal(REACTION_SEND_INTERVAL_MS, 1000);
});

test('a second send inside the interval is dropped; one after it is allowed', () => {
  const limiter = new ReactionRateLimiter();
  assert.equal(limiter.tryTake(START_MS), true);
  assert.equal(limiter.tryTake(START_MS + 1), false);
  assert.equal(limiter.tryTake(START_MS + REACTION_SEND_INTERVAL_MS - 1), false);
  assert.equal(limiter.tryTake(START_MS + REACTION_SEND_INTERVAL_MS), true);
});

test('dropped clicks do not extend the wait', () => {
  const limiter = new ReactionRateLimiter();
  limiter.tryTake(START_MS);
  for (let offset = 1; offset < REACTION_SEND_INTERVAL_MS; offset += 100) limiter.tryTake(START_MS + offset);
  assert.equal(limiter.tryTake(START_MS + REACTION_SEND_INTERVAL_MS), true);
});

test('spam clicks over three seconds send at most one per interval', () => {
  const limiter = new ReactionRateLimiter();
  const CLICK_EVERY_MS = 50;
  const SPAM_MS = 3 * REACTION_SEND_INTERVAL_MS;
  let sent = 0;
  for (let offset = 0; offset < SPAM_MS; offset += CLICK_EVERY_MS) if (limiter.tryTake(START_MS + offset)) sent += 1;
  assert.equal(sent, SPAM_MS / REACTION_SEND_INTERVAL_MS);
});

test('the remaining cooldown counts down to zero', () => {
  const limiter = new ReactionRateLimiter();
  assert.equal(limiter.remainingMs(START_MS), 0, 'nothing sent yet');
  limiter.tryTake(START_MS);
  assert.equal(limiter.remainingMs(START_MS + HALF_INTERVAL_MS), HALF_INTERVAL_MS);
  assert.equal(limiter.remainingMs(START_MS + REACTION_SEND_INTERVAL_MS + 1), 0);
});

test('a clock that steps backwards does not lock sending until it catches up', () => {
  const limiter = new ReactionRateLimiter();
  limiter.tryTake(START_MS);
  const CLOCK_STEP_BACK_MS = 60_000;
  assert.equal(limiter.remainingMs(START_MS - CLOCK_STEP_BACK_MS), 0);
  assert.equal(limiter.tryTake(START_MS - CLOCK_STEP_BACK_MS), true);
});
