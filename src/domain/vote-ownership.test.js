import test from 'node:test';
import assert from 'node:assert/strict';
import { activeVoteZone, zoneHasActiveGovernor } from './vote-ownership.js';

const DEADLINE_MS = 2000;
test('vote ownership finds the active ancestor and distinguishes unfinalized expired governance', () => {
  const root = { id: 'root', type: 'zone', x: 0, y: 0, w: 1000, h: 1000, voteTimer: { startedAt: 1, endsAt: DEADLINE_MS } };
  const child = { id: 'child', type: 'zone', x: 100, y: 100, w: 500, h: 500, parentZoneId: root.id };
  const card = { id: 'card', type: 'sticky', x: 200, y: 200, w: 20, h: 20, parentZoneId: child.id };
  const items = [root, child, card];
  assert.equal(activeVoteZone(card, items, DEADLINE_MS - 1), root);
  assert.equal(activeVoteZone(card, items, DEADLINE_MS), null);
  assert.equal(zoneHasActiveGovernor(child, items), true);
  assert.equal(zoneHasActiveGovernor({ ...root, voteTimer: null }, []), false);
});
