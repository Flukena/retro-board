import { MILLISECONDS_PER_SECOND } from './relay-config.js';

export const evictOldestBucket = (map, maxBuckets) => {
  if (map.size < maxBuckets) return;
  let oldestKey;
  let oldest = Infinity;
  for (const [key, value] of map) {
    if (value.lastSeen < oldest) { oldest = value.lastSeen; oldestKey = key; }
  }
  if (oldestKey !== undefined) map.delete(oldestKey);
};

export const refillTokens = (tokens, maximum, elapsedMs, rate, periodMs) => (
  Math.min(maximum, tokens + elapsedMs * rate / periodMs)
);

export const refillTrafficBucket = (bucket, limits, now) => {
  const elapsedMs = now - bucket.last;
  bucket.messages = refillTokens(bucket.messages, limits.maxMessages, elapsedMs, limits.messagesPerSecond, MILLISECONDS_PER_SECOND);
  bucket.bytes = refillTokens(bucket.bytes, limits.maxBytes, elapsedMs, limits.bytesPerSecond, MILLISECONDS_PER_SECOND);
  bucket.last = now;
  bucket.lastSeen = now;
};

export const takeTrafficTokens = (bucket, size, limits, now = Date.now()) => {
  refillTrafficBucket(bucket, limits, now);
  if (bucket.messages < 1 || bucket.bytes < size) return false;
  bucket.messages -= 1;
  bucket.bytes -= size;
  return true;
};

export const takeTrafficBudget = (reservations, now = Date.now()) => {
  for (const { bucket, limits } of reservations) refillTrafficBucket(bucket, limits, now);
  if (reservations.some(({ bucket, size }) => bucket.messages < 1 || bucket.bytes < size)) return false;
  for (const { bucket, size } of reservations) {
    bucket.messages -= 1;
    bucket.bytes -= size;
  }
  return true;
};

export const createTrafficBucket = (messages, bytes) => ({
  messages,
  bytes,
  last: Date.now(),
  lastSeen: Date.now(),
});

export const trafficBucketFor = (map, key, limits, maxBuckets) => {
  let bucket = map.get(key);
  if (bucket) return bucket;
  evictOldestBucket(map, maxBuckets);
  bucket = createTrafficBucket(limits.maxMessages, limits.maxBytes);
  map.set(key, bucket);
  return bucket;
};
