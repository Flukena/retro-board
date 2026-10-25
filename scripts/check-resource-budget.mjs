#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_CPU_SET = '0,1';
export const SHARED_CPU_CORE_COUNT = 2;
export const MAX_STACK_MEMORY_BYTES = 3_000_000_000;

export function verifyResourceBudget(services) {
  const entries = Object.entries(services ?? {});
  assert.ok(entries.length, 'Compose must define production services');
  const memoryByServiceBytes = {};
  let totalMemoryBytes = 0;
  for (const [name, service] of entries) {
    assert.equal(service.cpuset, SHARED_CPU_SET, `${name} must share CPU set ${SHARED_CPU_SET}`);
    const memoryBytes = Number(service.mem_limit);
    assert.ok(Number.isSafeInteger(memoryBytes) && memoryBytes > 0, `${name} must have a finite positive memory limit in bytes`);
    totalMemoryBytes += memoryBytes;
    memoryByServiceBytes[name] = memoryBytes;
  }
  assert.ok(totalMemoryBytes <= MAX_STACK_MEMORY_BYTES, `Combined service memory ${totalMemoryBytes} exceeds ${MAX_STACK_MEMORY_BYTES} bytes`);
  return { cpuSet: SHARED_CPU_SET, sharedCpuCores: SHARED_CPU_CORE_COUNT, memoryByServiceBytes, totalMemoryBytes, maxMemoryBytes: MAX_STACK_MEMORY_BYTES };
}

function main() {
  const composeFile = resolve(process.argv[2] ?? fileURLToPath(new URL('../docker-compose.prod.yml', import.meta.url)));
  const raw = execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', composeFile,
    'config', '--format', 'json', '--no-env-resolution'], { encoding: 'utf8' });
  const budget = verifyResourceBudget(JSON.parse(raw).services);
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...budget }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
