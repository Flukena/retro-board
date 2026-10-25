import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissResult, resultIsDismissed, readResultDismissals, MAX_RESULT_DISMISSALS, RESULT_DISMISSAL_STORAGE_KEY } from './vote-results-dismissal.js';

test('dismissal survives reload, is bounded, and isolates rooms and result ids', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(dismissResult(storage, 'room-a', 'zone:1'), true);
  assert.equal(resultIsDismissed({ ...storage }, 'room-a', 'zone:1'), true);
  assert.equal(resultIsDismissed(storage, 'room-b', 'zone:1'), false);
  assert.equal(resultIsDismissed(storage, 'room-a', 'zone:2'), false);
  for (let index = 0; index < MAX_RESULT_DISMISSALS; index += 1) dismissResult(storage, 'room-a', `zone:${index + 2}`);
  assert.equal(readResultDismissals(storage).length, MAX_RESULT_DISMISSALS);
  assert.equal(resultIsDismissed(storage, 'room-a', 'zone:1'), false);
  values.set(RESULT_DISMISSAL_STORAGE_KEY, '{');
  assert.deepEqual(readResultDismissals(storage), []);
});
test('unavailable or failing storage leaves results visible', () => {
  const storage = { getItem: () => { throw new Error('unavailable'); }, setItem: () => { throw new Error('quota'); } };
  for (const value of [null, storage]) {
    assert.equal(resultIsDismissed(value, 'room', 'zone:1'), false);
    assert.equal(dismissResult(value, 'room', 'zone:1'), false);
  }
});

test('visible results read dismissals once and order only undismissed room results', async () => {
  const { visibleVoteResultZones } = await import('./vote-results-dismissal.js');
  let reads = 0;
  const storage = { getItem: () => { reads += 1; return JSON.stringify([JSON.stringify(['room', 'hidden:1'])]); } };
  const zone = (id, finalizedAt) => ({ id, type: 'zone', voteResults: { resultId: `${id}:1`, finalizedAt } });
  const zones = visibleVoteResultZones([zone('old', 1), zone('hidden', 3), zone('new', 2)], storage, 'room');
  assert.deepEqual(zones.map((entry) => entry.id), ['new', 'old']);
  assert.equal(reads, 1);
});
