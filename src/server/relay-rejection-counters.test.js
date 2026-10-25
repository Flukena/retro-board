import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRejectionCounters } from './relay-rejection-counters.js';

test('summary contains cumulative counts and emits only when counts change', () => {
  const summaries = [];
  const counters = createRejectionCounters((message, counts) => summaries.push(counts));
  counters.flush();
  assert.equal(summaries.length, 0);
  counters.increment('upgrade', 403);
  counters.increment('upgrade', 403);
  counters.increment('storage-backlog', 1008);
  counters.flush();
  assert.deepEqual(summaries, [{ 'upgrade:403': 2, 'storage-backlog:1008': 1 }]);
  counters.flush();
  assert.equal(summaries.length, 1);
  counters.increment('upgrade', 429);
  counters.flush();
  assert.equal(summaries[1]['upgrade:403'], 2);
  assert.equal(summaries[1]['upgrade:429'], 1);
});

test('HTTP completion counts only 429, 503, and 507, including dynamic status selection', () => {
  const summaries = [];
  const counters = createRejectionCounters((message, counts) => summaries.push(counts));
  for (const status of [200, 400, 429, 503, 507]) {
    const response = new EventEmitter();
    counters.observeResponse(response);
    response.statusCode = status;
    response.emit('finish');
    response.emit('finish');
  }
  counters.flush();
  assert.deepEqual(summaries, [{ 'http:429': 1, 'http:503': 1, 'http:507': 1 }]);
});

test('backlog counters distinguish traffic closes from storage pressure', () => {
  const MAX_OPS_COUNT = 2;
  const MAX_PENDING_BYTES = 20;
  const summaries = [];
  const counters = createRejectionCounters((message, counts) => summaries.push(counts));
  counters.observeBacklog(0, 0, MAX_OPS_COUNT, MAX_PENDING_BYTES);
  counters.flush();
  assert.equal(summaries.length, 0);
  counters.observeBacklog(MAX_OPS_COUNT, 0, MAX_OPS_COUNT, MAX_PENDING_BYTES);
  counters.observeBacklog(0, MAX_PENDING_BYTES, MAX_OPS_COUNT, MAX_PENDING_BYTES);
  counters.storageBacklog();
  counters.upgrade(503);
  counters.flush();
  assert.deepEqual(summaries, [{ 'storage-backlog:1008': 3, 'upgrade:503': 1 }]);
});
