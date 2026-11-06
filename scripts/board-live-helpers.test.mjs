import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_VOLUME_ROOTS, prepareDataVolumeOutput } from './board-live-helpers.mjs';

test('live-check output is limited to the two data volumes', () => {
  assert.deepEqual(DATA_VOLUME_ROOTS, ['/Volumes/ssd-fluke/BaseData', '/Volumes/BaseDisk/Base']);
});

test('live-check output outside the data volumes is refused before anything is created', async () => {
  for (const out of ['/tmp/account-live', 'relative/run', '/Volumes/BaseDisk/Base/../escape', '/Volumes/ssd-fluke/BaseDataX/run']) {
    await assert.rejects(prepareDataVolumeOutput(out), /must be under/, out);
  }
});
