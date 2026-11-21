import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './live-check-all.mjs';

// AGENTS.md §Data location: run output lives only on a mounted data volume, with no fallback.
test('live-check-all refuses an --out-root off the data volumes before starting anything', async () => {
  const offVolume = join(tmpdir(), `live-check-all-refused-${process.pid}`);
  for (const outRoot of [offVolume, '/Volumes/ssd-fluke/BaseData/../escape']) {
    await assert.rejects(main(['--out-root', outRoot], { manifest: { entries: [] } }), /must be under/, outRoot);
  }
  assert.equal(existsSync(offVolume), false);
});
