import test from 'node:test';
import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { DATA_VOLUME_ROOTS, prepareDataVolumeOutput, workspaceHeadingName } from './board-live-helpers.mjs';

test('live-check output is limited to the two data volumes', () => {
  assert.deepEqual(DATA_VOLUME_ROOTS, ['/Volumes/ssd-fluke/BaseData', '/Volumes/BaseDisk/Base']);
});

test('live-check output outside the data volumes is refused before anything is created', async () => {
  // A relative path is resolved against the working directory, which may itself be on a data volume.
  const relativeOutside = relative(process.cwd(), '/tmp/account-live-relative');
  for (const out of ['/tmp/account-live', relativeOutside, '/Volumes/BaseDisk/Base/../escape', '/Volumes/ssd-fluke/BaseDataX/run']) {
    await assert.rejects(prepareDataVolumeOutput(out), /must be under/, out);
  }
});

test('the workspace heading is found in Thai and English, with or without its room count', () => {
  const name = workspaceHeadingName();
  for (const heading of ['My boards', 'My boards 3', 'บอร์ดของฉัน', 'บอร์ดของฉัน 12']) assert.match(heading, name, heading);
  for (const other of ['My boards list', 'My boards 3 4', 'Boards', 'my boards']) assert.doesNotMatch(other, name, other);
});
