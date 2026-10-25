import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTopVotedRanks } from './voting-results.js';

test('awards one top three across the largest finished zone and all nested zones', () => {
  const items = [
    { id: 'root', type: 'zone', lastResultsAt: 100 },
    { id: 'child-a', type: 'zone', parentZoneId: 'root' },
    { id: 'child-b', type: 'zone', parentZoneId: 'root' },
    { id: 'a-first', type: 'sticky', parentZoneId: 'child-a' },
    { id: 'a-second', type: 'sticky', parentZoneId: 'child-a' },
    { id: 'b-first', type: 'sticky', parentZoneId: 'child-b' },
    { id: 'b-second', type: 'sticky', parentZoneId: 'child-b' },
  ];
  const votes = new Map([
    ['a-first', 10],
    ['a-second', 7],
    ['b-first', 8],
    ['b-second', 3],
  ]);

  const ranks = buildTopVotedRanks({
    items,
    voteCountOf: (id) => votes.get(id) || 0,
    groupIdsForZone: () => new Set(items.map((item) => item.id)),
    ownerZoneForItem: (item) => items.find((candidate) => candidate.id === item.parentZoneId),
    zoneHasActiveGovernor: () => false,
  });

  assert.deepEqual([...ranks], [
    ['a-first', 1],
    ['b-first', 2],
    ['a-second', 3],
  ]);
  assert.equal(ranks.has('b-second'), false);
});
