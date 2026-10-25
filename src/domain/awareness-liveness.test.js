import test from 'node:test';
import assert from 'node:assert/strict';
import { outdatedTimeout } from 'y-protocols/awareness';
import { isAwarenessSlotFresh, PLAYER_PRESENCE_STALE_MS } from './awareness-liveness.js';

const NOW_MS = PLAYER_PRESENCE_STALE_MS * 2;
const CLIENT_ID = 1;
test('awareness liveness shares the protocol bound and excludes the exact expiry boundary', () => {
  assert.equal(PLAYER_PRESENCE_STALE_MS, outdatedTimeout);
  assert.equal(isAwarenessSlotFresh(undefined, CLIENT_ID, NOW_MS), true);
  for (const [ageMs, expected] of [[PLAYER_PRESENCE_STALE_MS - 1, true], [PLAYER_PRESENCE_STALE_MS, false]]) {
    const metadata = new Map([[CLIENT_ID, { lastUpdated: NOW_MS - ageMs }]]);
    assert.equal(isAwarenessSlotFresh(metadata, CLIENT_ID, NOW_MS), expected);
  }
});
