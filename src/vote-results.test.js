import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVoteResults, MAX_RESULT_PARTICIPANTS, isVoteResults } from './vote-results.js';

const root = { id: 'zone', voteTimer: { startedAt: 10, endsAt: 100, voteLimit: 2, showNonVoters: true } };
const rankedItems = [{ id: 'b' }, { id: 'a' }, { id: 'empty' }];
const votes = new Map([['a', new Set(['u'])], ['b', new Set(['u', 'v'])]]);
const build = (participants = [], zone = root) => buildVoteResults(zone, rankedItems, votes, participants, 200);
test('results snapshot aggregates canonical votes, ranks by count/id and deduplicates presence', () => {
  const participants = [{ userId: 'p', name: 'Pat' }, { userId: 'p', name: 'Zed' }, { userId: 'u', name: 'Uma' }];
  const result = build(participants);
  assert.equal(result.totalVotes, 3);
  assert.equal(result.voterCount, 2);
  assert.equal(result.presentCount, 2);
  assert.equal(result.resultId, 'zone:10');
  assert.equal(result.finalizedAt, 200);
  assert.equal(result.scheduledEndsAt, 100);
  assert.deepEqual(result.top, [{ itemId: 'b', votes: 2 }, { itemId: 'a', votes: 1 }]);
  assert.deepEqual(result.participants.map((p) => [p.userId, p.votes]), [['p', 0], ['v', 1], ['u', 2]]);
  assert.deepEqual(build([...participants].reverse()), result);
  assert.equal(isVoteResults(result, 'zone'), true);
});
test('presence is bounded, unsafe identities dropped, names truncated, aggregates never capped', () => {
  const participants = Array.from({ length: MAX_RESULT_PARTICIPANTS + 1 }, (_, i) => ({ userId: `p${i}`, name: 'a'.repeat(200) }));
  participants.push({ userId: '__proto__', name: 'bad' });
  const result = build(participants);
  assert.equal(result.participants.length, MAX_RESULT_PARTICIPANTS);
  assert.equal(result.omittedCount, 3);
  assert.equal(result.presentCount, MAX_RESULT_PARTICIPANTS + 1);
  assert.equal(result.totalVotes, 3);
  assert.ok(result.participants.every((p) => p.name.length <= 120));
});
test('private roster is absent when showNonVoters is false; malformed results fail validation', () => {
  const result = build([], { ...root, voteTimer: { ...root.voteTimer, showNonVoters: false } });
  assert.equal(Object.hasOwn(result, 'participants'), false);
  for (const patch of [{ v: 2 }, { totalVotes: -1 }, { resultId: 'other:10' }, { top: [{ itemId: '__proto__', votes: 1 }] }, { participants: [] }]) {
    assert.equal(isVoteResults({ ...result, ...patch }, 'zone'), false);
  }
});

test('tied results use the same stable id ranking independent of input order', () => {
  const tied = new Map([['b', new Set(['u'])], ['a', new Set(['v'])]]);
  const result = buildVoteResults(root, [...rankedItems].reverse(), tied, [], 200);
  assert.deepEqual(result.top, [{ itemId: 'a', votes: 1 }, { itemId: 'b', votes: 1 }]);
});

test('aggregate counts use actual votes while unsafe voter identities never enter the roster', () => {
  const result = buildVoteResults(root, [{ id: 'a' }], new Map([['a', new Set(['__proto__', 'u'])]]), [], 200);
  assert.equal(result.totalVotes, 2);
  assert.equal(result.voterCount, 2);
  assert.deepEqual(result.participants.map((person) => person.userId), ['u']);
  assert.equal(isVoteResults(result, 'zone'), true);
});
