import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEVELOPMENT_VOLUME_ROOT = '/Volumes/ssd-fluke/BaseData';

test('public dev reports a missing data volume before starting a relay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wall-dev-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missingRoot = join(root, 'missing-volume');
  const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  const command = packageJson.scripts['yjs:public:dev'].replaceAll(DEVELOPMENT_VOLUME_ROOT, missingRoot);
  await assert.rejects(promisify(execFile)('/bin/sh', ['-c', command]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Public Wall.*(?:missing|unavailable)/);
    assert.ok(error.stderr.includes(missingRoot));
    return true;
  });
});
