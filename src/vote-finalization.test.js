import test from 'node:test';
import assert from 'node:assert/strict';
import { planVoteFinalization } from './vote-finalization.js';

test('expired vote finalization is deterministic without an admin client', () => {
  const items = [
    { id: 'root', type: 'zone', x: 0, y: 0, w: 800, h: 600, voteTimer: { endsAt: 500 }, createdAt: 1 },
    { id: 'child', type: 'zone', x: 20, y: 50, w: 350, h: 400, parentZoneId: 'root', createdAt: 2 },
    { id: 'one', type: 'sticky', x: 40, y: 100, w: 200, h: 180, parentZoneId: 'child', createdAt: 3 },
    { id: 'two', type: 'sticky', x: 50, y: 120, w: 200, h: 180, parentZoneId: 'child', createdAt: 4 },
  ];
  const votes = new Map([['two', new Set(['alice', 'bob'])], ['one', new Set(['alice'])]]);
  const plan = planVoteFinalization(items, votes, 'root', 999);
  assert.equal(plan.finalizedAt, 500);
  assert.deepEqual([...plan.zoneIds].sort(), ['child', 'root']);
  assert.deepEqual(plan.entries.map((entry) => entry.id), ['two', 'one', 'root']);
  assert.deepEqual(plan.entries.at(-1).patch, { voteTimer: null, lastResultsAt: 500 });
  assert.ok(plan.entries[0].patch.y < plan.entries[1].patch.y);
  assert.deepEqual(planVoteFinalization(items, votes, 'root', 2000).entries, plan.entries);
});

test('another active nested session is not sorted by its ancestor', () => {
  const items = [
    { id: 'root', type: 'zone', x: 0, y: 0, w: 1000, h: 800, voteTimer: { endsAt: 500 } },
    { id: 'child', type: 'zone', x: 50, y: 50, w: 500, h: 500, parentZoneId: 'root', voteTimer: { endsAt: 700 } },
    { id: 'note', type: 'sticky', x: 100, y: 100, w: 200, h: 180, parentZoneId: 'child' },
  ];
  const plan = planVoteFinalization(items, new Map(), 'root', 600);
  assert.deepEqual(plan.entries.map((entry) => entry.id), ['root']);
});
