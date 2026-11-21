import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestThrottle } from './latest-throttle.js';
import { createFakeClock } from '../../test-support/fake-clock.js';

const INTERVAL_MS = 24;
test('24ms throttle sends immediately after idle and trails only the latest pending value', () => {
  const clock = createFakeClock(100);
  const sent = [];
  const throttle = createLatestThrottle({ intervalMs: INTERVAL_MS, clock, publish: value => sent.push([clock.now(), value]) });
  throttle.push({ x: 1 });
  assert.deepEqual(sent, [[100, { x: 1 }]]);
  clock.advance(10);
  throttle.push({ x: 2 }); throttle.push({ x: 3 });
  assert.equal(clock.pendingCount(), 1);
  clock.advance(13);
  assert.equal(sent.length, 1);
  clock.advance(1);
  assert.deepEqual(sent, [[100, { x: 1 }], [124, { x: 3 }]]);
  assert.equal(clock.pendingCount(), 0);
});

test('early first input waits until 24ms; clear/dispose cancel trailing data and publish null without resetting time', () => {
  const clock = createFakeClock();
  const sent = [];
  const throttle = createLatestThrottle({ intervalMs: INTERVAL_MS, clock, publish: value => sent.push(value) });
  throttle.push({ x: 1 });
  clock.advance(23);
  assert.deepEqual(sent, []);
  clock.advance(1);
  assert.deepEqual(sent, [{ x: 1 }]);
  throttle.push({ x: 2 });
  throttle.clear();
  clock.advance(1);
  throttle.push({ x: 3 });
  clock.advance(22);
  assert.deepEqual(sent, [{ x: 1 }, null]);
  clock.advance(1);
  assert.deepEqual(sent, [{ x: 1 }, null, { x: 3 }]);
  throttle.push({ x: 4 });
  throttle.dispose();
  clock.advance(100);
  assert.deepEqual(sent, [{ x: 1 }, null, { x: 3 }, null]);
  assert.equal(clock.pendingCount(), 0);
});

test('default throttle clock calls performance and timer hosts with native receivers', () => {
  const originalNow = globalThis.performance.now;
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const scheduled = [];
  const cancelled = [];
  const timerId = Symbol('timer');
  const sent = [];
  try {
    globalThis.performance.now = function () { assert.equal(this, globalThis.performance); return 0; };
    globalThis.setTimeout = function (run, delayMs) { assert.equal(this, globalThis); scheduled.push({ run, delayMs }); return timerId; };
    globalThis.clearTimeout = function (id) { assert.equal(this, globalThis); cancelled.push(id); };
    const throttle = createLatestThrottle({ intervalMs: INTERVAL_MS, publish: value => sent.push(value) });
    throttle.push({ x: 1 });
    assert.equal(scheduled[0].delayMs, INTERVAL_MS);
    throttle.dispose();
    assert.deepEqual(cancelled, [timerId]);
    assert.deepEqual(sent, [null]);
  } finally {
    globalThis.performance.now = originalNow;
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
