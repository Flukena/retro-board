import test from 'node:test';
import assert from 'node:assert/strict';
import { voteSessionScope, resetVoteSessionEntries } from './vote-session-lifecycle.js';

const root = { id: 'root', type: 'zone', x: 0, y: 0, w: 800, h: 800 };
const child = { id: 'child', type: 'zone', x: 10, y: 10, w: 400, h: 400, parentZoneId: 'root', voteResults: { resultId: 'child:1' } };
const sticky = { id: 'card', type: 'sticky', x: 20, y: 20, parentZoneId: 'child' };
test('start scope includes stale descendant results, owned cards and expired-but-unfinalized related sessions', () => {
  assert.deepEqual(voteSessionScope(root, [root, child, sticky]), {
    relatedActive: false, capturedIds: ['card'], staleResultZoneIds: ['child'],
  });
  assert.equal(voteSessionScope(root, [root, { ...child, voteTimer: { endsAt: 1 } }]).relatedActive, true);
  assert.equal(voteSessionScope(child, [{ ...root, voteTimer: { endsAt: 1 } }, child]).relatedActive, true);
});
test('reset selects result-only zones and clears every runtime session field', () => {
  const entries = resetVoteSessionEntries([root, child, sticky]);
  assert.deepEqual(entries, [{ id: 'child', patch: { voteTimer: null, lastResultsAt: null, voteResults: null } }]);
});
