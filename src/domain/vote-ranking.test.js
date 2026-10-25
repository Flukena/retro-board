import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVoteRank, RESULT_TOP_SIZE } from './vote-ranking.js';

test('rank is descending by votes with a stable id tie-break and a three-place podium', () => {
  const rows = [{ id: 'z', votes: 1 }, { id: 'b', votes: 2 }, { id: 'a', votes: 2 }];
  rows.sort((a, b) => compareVoteRank(a.votes, b.votes, a.id, b.id));
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'z']);
  assert.equal(RESULT_TOP_SIZE, 3);
});
