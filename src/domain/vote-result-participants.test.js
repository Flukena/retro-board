import test from 'node:test';
import assert from 'node:assert/strict';
import { readVoteResultParticipants } from './vote-result-participants.js';
import { normalizeResultParticipants, RESULT_GUEST_NAME } from './vote-results.js';
import { DISPLAY_NAME_MAX_LENGTH } from './security-boundaries.js';
import { PLAYER_PRESENCE_STALE_MS } from './awareness-liveness.js';

const NOW_MS = PLAYER_PRESENCE_STALE_MS * 2;
test('participant extraction validates only identity fields, preserves duplicate candidates and filters expired slots', () => {
  const entries = [
    [1, { user: { userId: 'same', name: 'Zed', lastSeen: NOW_MS } }],
    [2, { user: { userId: 'same', name: ' Ada ', lastSeen: NOW_MS } }],
    [3, { user: { userId: '__proto__', name: 'Rejected' } }],
    [4, { user: { userId: 'stale', name: 'Expired' } }],
    [5, { user: { userId: 'long', name: 'a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1) } }],
    [6, { user: { userId: 'guest', name: { toString: null, valueOf: null } } }],
  ];
  const metadata = new Map(entries.map(([id]) => [id, { lastUpdated: NOW_MS }]));
  metadata.set(4, { lastUpdated: NOW_MS - PLAYER_PRESENCE_STALE_MS });
  const extract = (states) => readVoteResultParticipants({ getStates: () => new Map(states), meta: metadata }, NOW_MS);
  const forward = extract(entries);
  assert.deepEqual(forward.filter((candidate) => candidate.userId === 'same'), [
    { userId: 'same', name: 'Zed' }, { userId: 'same', name: 'Ada' },
  ]);
  assert.equal(normalizeResultParticipants(extract([...entries].reverse())).get('same'), 'Ada');
  assert.equal(normalizeResultParticipants(forward).get('same'), 'Ada');
  assert.equal(forward.some((candidate) => candidate.userId === 'stale'), false);
  assert.equal(forward.some((candidate) => candidate.userId === '__proto__'), false);
  assert.equal(forward.find((candidate) => candidate.userId === 'long').name.length, DISPLAY_NAME_MAX_LENGTH);
  assert.equal(forward.find((candidate) => candidate.userId === 'guest').name, RESULT_GUEST_NAME);
  assert.deepEqual(readVoteResultParticipants(undefined, NOW_MS), []);
});
