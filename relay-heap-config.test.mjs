import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MAX_HEAP_BUDGET_MIB = 432;
const YOUNG_GENERATION_SEMI_SPACE_COUNT = 3;

test('relay image explicitly bounds old and young heap within the measured budget', async () => {
  const dockerfile = await readFile(new URL('./Dockerfile.yjs', import.meta.url), 'utf8');
  const oldHeapMiB = Number(dockerfile.match(/ENV YJS_HEAP_LIMIT_MIB=(\d+)/)?.[1]);
  const semiSpaceMiB = Number(dockerfile.match(/ENV YJS_SEMI_SPACE_LIMIT_MIB=(\d+)/)?.[1]);
  assert.ok(oldHeapMiB > 0 && semiSpaceMiB > 0, 'explicit heap bounds are required');
  assert.ok(oldHeapMiB + semiSpaceMiB * YOUNG_GENERATION_SEMI_SPACE_COUNT <= MAX_HEAP_BUDGET_MIB);
  assert.ok(dockerfile.includes('--max-old-space-size=${YJS_HEAP_LIMIT_MIB}'));
  assert.ok(dockerfile.includes('--max-semi-space-size=${YJS_SEMI_SPACE_LIMIT_MIB}'));
});
