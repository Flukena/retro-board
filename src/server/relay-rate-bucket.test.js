import test from 'node:test';
import assert from 'node:assert/strict';
import { evictOldestBucket, refillTokens, refillTrafficBucket, takeTrafficTokens, takeTrafficBudget, trafficBucketFor, tokenWaitSeconds } from './relay-rate-bucket.js';

const LIMITS = { maxMessages: 4, messagesPerSecond: 2, maxBytes: 100, bytesPerSecond: 20 };
const AT_TIME_MS = 1_000;
const bucket = (messages = 0, bytes = 0) => ({ messages, bytes, last: AT_TIME_MS, lastSeen: 0 });

test('fractional refill caps only above, preserving backwards clock behavior', () => {
  assert.equal(refillTokens(0, 4, 250, 2, 1_000), 0.5);
  assert.equal(refillTokens(3, 4, 1_000, 2, 1_000), 4);
  assert.equal(refillTokens(0, 4, -250, 2, 1_000), -0.5);
});

test('refill updates last and lastSeen at exact fractional boundaries', () => {
  const value = bucket();
  refillTrafficBucket(value, LIMITS, 1_250);
  assert.deepEqual(value, { messages: 0.5, bytes: 5, last: 1_250, lastSeen: 1_250 });
});

test('sequential inbound budgets keep earlier deductions on later failure', () => {
  const connection = bucket(2, 100);
  const global = bucket(0, 0);
  const room = bucket(2, 100);
  const admitted = takeTrafficTokens(connection, 10, LIMITS, AT_TIME_MS)
    && takeTrafficTokens(global, 10, LIMITS, AT_TIME_MS)
    && takeTrafficTokens(room, 10, LIMITS, AT_TIME_MS);
  assert.equal(admitted, false);
  assert.equal(connection.messages, 1);
  assert.equal(connection.bytes, 90);
  assert.equal(global.lastSeen, AT_TIME_MS);
  assert.equal(room.lastSeen, 0);
});

test('atomic budgets refill every reservation but deduct none on later failure', () => {
  const first = bucket(2, 100);
  const last = bucket();
  assert.equal(takeTrafficBudget([
    { bucket: first, size: 10, limits: LIMITS },
    { bucket: last, size: 10, limits: LIMITS },
  ], AT_TIME_MS), false);
  assert.equal(first.messages, 2);
  assert.equal(first.bytes, 100);
  assert.equal(first.lastSeen, AT_TIME_MS);
  assert.equal(last.lastSeen, AT_TIME_MS);
});

test('exact token and byte boundaries pass; fractional shortages fail', () => {
  const exact = bucket(1, 10);
  assert.equal(takeTrafficTokens(exact, 10, LIMITS, AT_TIME_MS), true);
  assert.equal(exact.messages, 0);
  assert.equal(exact.bytes, 0);
  assert.equal(takeTrafficTokens(bucket(0.99, 10), 10, LIMITS, AT_TIME_MS), false);
  assert.equal(takeTrafficTokens(bucket(1, 9.99), 10, LIMITS, AT_TIME_MS), false);
});

test('eviction preserves insertion ties and removes one oldest only at MAX_BUCKETS', () => {
  const map = new Map([['new', { lastSeen: 3 }], ['first', { lastSeen: 1 }], ['tie', { lastSeen: 1 }]]);
  evictOldestBucket(map, 4);
  assert.equal(map.size, 3);
  evictOldestBucket(map, 3);
  assert.deepEqual([...map.keys()], ['new', 'tie']);
  evictOldestBucket(map, 1);
  assert.deepEqual([...map.keys()], ['new']);
  evictOldestBucket(new Map(), 0);
});

test('atomic reservations deduct exact boundaries on success', () => {
  const first = bucket(1, 10);
  const second = bucket(1, 20);
  assert.equal(takeTrafficBudget([
    { bucket: first, size: 10, limits: LIMITS },
    { bucket: second, size: 20, limits: LIMITS },
  ], AT_TIME_MS), true);
  assert.equal(first.messages, 0);
  assert.equal(first.bytes, 0);
  assert.equal(second.messages, 0);
  assert.equal(second.bytes, 0);
});

test('existing buckets are reused at capacity and new buckets evict before insertion', () => {
  const first = bucket();
  const map = new Map([['first', first]]);
  assert.equal(trafficBucketFor(map, 'first', LIMITS, 1), first);
  const created = trafficBucketFor(map, 'new', LIMITS, 1);
  assert.deepEqual([...map.keys()], ['new']);
  assert.equal(created.messages, LIMITS.maxMessages);
  assert.equal(created.bytes, LIMITS.maxBytes);
});

test('creation wait reflects fractional refill and is zero when a token is available', () => {
  assert.equal(tokenWaitSeconds(0, 60), 60);
  assert.equal(tokenWaitSeconds(0.5, 60), 30);
  assert.equal(tokenWaitSeconds(0, 1), 3600);
  assert.equal(tokenWaitSeconds(1, 60), 0);
});
