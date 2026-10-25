import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyResourceBudget } from './check-resource-budget.mjs';

const REQUESTED_MAX_MEMORY_BYTES = 3_000_000_000;
const REQUESTED_CPU_SET = '0,1';
const SERVICE_MEMORY_BYTES = 1_000_000_000;
const OVER_BUDGET_MEMORY_BYTES = REQUESTED_MAX_MEMORY_BYTES + 1;
const service = memoryBytes => ({ cpuset: REQUESTED_CPU_SET, mem_limit: memoryBytes });

test('multiple services share the same two cores and sum memory in bytes', () => {
  const result = verifyResourceBudget({ relay: service(SERVICE_MEMORY_BYTES), web: service(String(SERVICE_MEMORY_BYTES)) });
  assert.equal(result.sharedCpuCores, 2);
  assert.equal(result.cpuSet, REQUESTED_CPU_SET);
  assert.equal(result.maxMemoryBytes, REQUESTED_MAX_MEMORY_BYTES);
  assert.equal(result.totalMemoryBytes, SERVICE_MEMORY_BYTES + SERVICE_MEMORY_BYTES);
});

test('a service outside the shared core pair rejects the stack even with a small CPU quota', () => {
  assert.throws(() => verifyResourceBudget({ relay: service(SERVICE_MEMORY_BYTES), tunnel: { cpuset: '2,3', cpus: 0.1, mem_limit: SERVICE_MEMORY_BYTES } }), /tunnel must share CPU set/);
  assert.throws(() => verifyResourceBudget({ relay: { cpus: 0.1, mem_limit: SERVICE_MEMORY_BYTES } }), /relay must share CPU set/);
});

test('all services together must stay within the requested memory ceiling', () => {
  assert.equal(verifyResourceBudget({ relay: service(REQUESTED_MAX_MEMORY_BYTES) }).totalMemoryBytes, REQUESTED_MAX_MEMORY_BYTES);
  assert.throws(() => verifyResourceBudget({ relay: service(OVER_BUDGET_MEMORY_BYTES) }), /Combined service memory/);
  assert.throws(() => verifyResourceBudget({ relay: service(SERVICE_MEMORY_BYTES), web: service(REQUESTED_MAX_MEMORY_BYTES) }), /Combined service memory/);
});

test('unlimited, missing, fractional or invalid per-service memory is rejected', () => {
  for (const mem_limit of [0, -1, undefined, Infinity, NaN, 'unlimited', 0.5]) {
    assert.throws(() => verifyResourceBudget({ relay: service(mem_limit) }), /finite positive memory limit/);
  }
  assert.throws(() => verifyResourceBudget({}), /must define production services/);
});
