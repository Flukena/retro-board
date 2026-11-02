import test from 'node:test';
import assert from 'node:assert/strict';
import { POKER_REACTIONS, activeReactions, pokerReaction } from './poker-reactions.js';

const THUMBS = POKER_REACTIONS[0];
const PARTY = POKER_REACTIONS[1];
const state = (userId, reaction) => ({ user: { userId, name: userId }, reaction });

test('a reaction targets one seat with one emoji from the fixed set', () => {
  assert.deepEqual(pokerReaction('amy', THUMBS, 'r1'), { to: 'amy', emoji: THUMBS, id: 'r1' });
  assert.equal(pokerReaction('amy', '💩', 'r1'), null, 'emoji outside the set');
  assert.equal(pokerReaction('', THUMBS, 'r1'), null, 'no target');
  assert.equal(pokerReaction('amy', THUMBS, 'x'.repeat(33)), null, 'oversized id');
});

test('live reactions are grouped by target seat and keyed by sender and id', () => {
  const live = activeReactions([
    state('bob', { to: 'amy', emoji: THUMBS, id: 'r1' }),
    state('cat', { to: 'amy', emoji: PARTY, id: 'r9' }),
    state('amy', { to: 'bob', emoji: PARTY, id: 'r2' }),
    state('dan', null),
  ], new Set(['amy', 'bob', 'cat', 'dan']));
  assert.deepEqual(live.get('amy').map(({ key, emoji }) => [key, emoji]), [['bob:r1', THUMBS], ['cat:r9', PARTY]]);
  assert.deepEqual(live.get('bob').map(({ fromUserId }) => fromUserId), ['amy']);
  assert.equal(live.has('dan'), false);
});

test('untrusted presence is dropped: unknown emoji, unknown seat, or no sender', () => {
  const live = activeReactions([
    state('bob', { to: 'amy', emoji: '<img>', id: 'r1' }),
    state('bob', { to: 'ghost', emoji: THUMBS, id: 'r2' }),
    { reaction: { to: 'amy', emoji: THUMBS, id: 'r3' } },
    state('bob', 'not an object'),
  ], new Set(['amy', 'bob']));
  assert.equal(live.size, 0);
});
