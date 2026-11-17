import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpRequestSlots } from './relay-http-slots.js';

const IP = '203.0.113.1';
const OTHER_IP = '203.0.113.2';

test('each IP gets at most its own share of slots, and a released slot is reusable', () => {
  const reserve = createHttpRequestSlots({ maxRequests: 10, maxRequestsPerIp: 2 });
  const first = reserve(IP);
  const second = reserve(IP);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(reserve(IP).status, 429);
  assert.equal(reserve(OTHER_IP).status, 0);
  first.release();
  first.release();
  assert.equal(reserve(IP).status, 0, 'a double release frees one slot only');
  assert.equal(reserve(IP).status, 429);
});

test('the relay-wide cap answers 503 before the per-IP cap', () => {
  const reserve = createHttpRequestSlots({ maxRequests: 2, maxRequestsPerIp: 2 });
  const held = [reserve(IP), reserve(OTHER_IP)];
  assert.equal(reserve('203.0.113.3').status, 503);
  held[0].release();
  assert.equal(reserve('203.0.113.3').status, 0);
});
