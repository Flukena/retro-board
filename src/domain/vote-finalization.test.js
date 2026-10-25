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
  const { voteResults, ...legacyPatch } = plan.entries.at(-1).patch;
  assert.deepEqual(legacyPatch, { voteTimer: null, lastResultsAt: 500 });
  assert.equal(voteResults.totalVotes, 3);
  assert.ok(plan.entries[0].patch.y < plan.entries[1].patch.y);
  const laterPlan = planVoteFinalization(items, votes, 'root', 2000);
  assert.equal(laterPlan.entries.at(-1).patch.voteResults.finalizedAt, 2000);
  laterPlan.entries.at(-1).patch.voteResults.finalizedAt = voteResults.finalizedAt;
  assert.deepEqual(laterPlan.entries, plan.entries);
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

test('finalized rows clear default and explicit titles; short zones retain overflow', () => {
  for (const [fontSize, height] of [[16, 600], [96, 600], [96, 40]]) {
    const zone = { id: 'zone', type: 'zone', x: 0, y: 10, w: 400, h: height, fontSize, voteTimer: { endsAt: 1 } };
    const note = { id: 'note', type: 'sticky', x: 0, y: 10, w: 20, h: 20, parentZoneId: 'zone' };
    const plan = planVoteFinalization([zone, note], new Map(), 'zone', 1);
    const row = plan.entries.find((entry) => entry.id === 'note').patch;
    assert.ok(row.y >= zone.y + 14 + 12 + fontSize * 1.35 + 8);
    if (height === 40) assert.ok(row.y > zone.y + zone.h);
    else assert.ok(row.y + note.h <= zone.y + zone.h);
  }
});

test('timer sorting cannot expose hidden cards when short owner zones overflow on a revealed board', () => {
  const ZONE_HEIGHT_PX = 40;
  const AT_TIME_MS = 100;
  const zone = { id: 'zone', type: 'zone', x: 0, y: 0, w: 400, h: ZONE_HEIGHT_PX,
    revealed: false, voteTimer: { endsAt: AT_TIME_MS } };
  const card = { id: 'private', type: 'sticky', x: 0, y: 0, w: 20, h: 20,
    private: true, parentZoneId: zone.id };
  const plan = planVoteFinalization([zone, card], new Map(), zone.id, AT_TIME_MS, [], true);
  assert.equal(plan.entries.find(entry => entry.id === card.id).patch.revealed, false);
});
