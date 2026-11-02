import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_POKER_DECK_ID, POKER_DECK_ID } from './poker-deck.js';
import {
  MAX_STORIES_PER_ROOM, MAX_STORY_TITLE_CHARS, POKER_ROOM_KIND,
  canChangeDeck, decodePokerRoom, nextStoryId, parsePokerVoteKey, pokerVoteKey, storyTitlesFromText,
} from './poker-schema.js';

const story = (overrides = {}) => ({ title: 'Login page', order: 1, createdAt: 10, revealedAt: null, finalEstimate: null, ...overrides });

test('a document is a poker room only when its kind says so', () => {
  assert.equal(decodePokerRoom({ poker: { kind: POKER_ROOM_KIND } }).isPoker, true);
  assert.equal(decodePokerRoom({ poker: { kind: 'board' } }).isPoker, false);
  assert.equal(decodePokerRoom({}).isPoker, false);
  assert.equal(decodePokerRoom(null).isPoker, false);
});

test('an unknown deck id falls back to the default deck', () => {
  assert.equal(decodePokerRoom({ poker: { deckId: 'evil' } }).deckId, DEFAULT_POKER_DECK_ID);
  assert.equal(decodePokerRoom({ poker: { deckId: POKER_DECK_ID.TSHIRT } }).deckId, POKER_DECK_ID.TSHIRT);
});

test('stories are ordered by order, then creation time, then id', () => {
  const { stories } = decodePokerRoom({ stories: {
    c: story({ title: 'C', order: 2 }), b: story({ title: 'B', order: 1, createdAt: 20 }), a: story({ title: 'A', order: 1, createdAt: 20 }),
  } });
  assert.deepEqual(stories.map((entry) => entry.id), ['a', 'b', 'c']);
});

test('stories with unsafe ids or empty titles are dropped, long titles are cut', () => {
  const { stories } = decodePokerRoom({ stories: {
    'bad id': story(), blank: story({ title: '   ' }), numeric: story({ title: 5 }),
    long: story({ title: 'x'.repeat(MAX_STORY_TITLE_CHARS + 50) }),
  } });
  assert.deepEqual(stories.map((entry) => entry.id), ['long']);
  assert.equal(stories[0].title.length, MAX_STORY_TITLE_CHARS);
});

test('invalid timestamps and final estimates outside the deck read as empty', () => {
  const [decoded] = decodePokerRoom({ stories: { s: story({ revealedAt: -1, createdAt: 'x', finalEstimate: 'XL' }) } }).stories;
  assert.deepEqual([decoded.revealedAt, decoded.createdAt, decoded.finalEstimate], [null, 0, null]);
});

test('the room keeps at most the story cap', () => {
  const stories = Object.fromEntries(Array.from({ length: MAX_STORIES_PER_ROOM + 5 }, (_, index) => [`s${index}`, story({ order: index })]));
  assert.equal(decodePokerRoom({ stories }).stories.length, MAX_STORIES_PER_ROOM);
});

test('votes are grouped per story and invalid keys, cards or stories are ignored', () => {
  const { votesByStory } = decodePokerRoom({
    stories: { s1: story() },
    votes: {
      [pokerVoteKey('s1', 'u1')]: '5',
      [pokerVoteKey('s1', 'u2')]: 'XL',
      [pokerVoteKey('ghost', 'u1')]: '3',
      's1:u3:extra': '8',
    },
  });
  assert.deepEqual([...votesByStory.keys()], ['s1']);
  assert.deepEqual(Object.fromEntries(votesByStory.get('s1')), { u1: '5' });
});

test('the active story must exist', () => {
  assert.equal(decodePokerRoom({ poker: { activeStoryId: 's1' }, stories: { s1: story() } }).activeStoryId, 's1');
  assert.equal(decodePokerRoom({ poker: { activeStoryId: 'gone' }, stories: { s1: story() } }).activeStoryId, null);
});

test('vote keys round-trip and reject malformed ids', () => {
  assert.deepEqual(parsePokerVoteKey(pokerVoteKey('story-1', 'user_2')), { storyId: 'story-1', userId: 'user_2' });
  assert.equal(parsePokerVoteKey('only-one-part'), null);
  assert.equal(parsePokerVoteKey('a:b c'), null);
  assert.equal(parsePokerVoteKey(42), null);
});

test('pasted text becomes one story per non-empty line within free slots', () => {
  assert.deepEqual(storyTitlesFromText('  Login \r\n\nSignup\n  '), ['Login', 'Signup']);
  assert.deepEqual(storyTitlesFromText('a\nb\nc', MAX_STORIES_PER_ROOM - 2), ['a', 'b']);
  assert.deepEqual(storyTitlesFromText('a', MAX_STORIES_PER_ROOM), []);
  assert.deepEqual(storyTitlesFromText(null), []);
});

test('next story skips estimated stories and wraps around to skipped ones', () => {
  const stories = [
    { id: 'a', finalEstimate: null }, { id: 'b', finalEstimate: '5' }, { id: 'c', finalEstimate: null }, { id: 'd', finalEstimate: '3' },
  ];
  assert.equal(nextStoryId(stories, 'a'), 'c');
  assert.equal(nextStoryId(stories, 'c'), 'a');
  assert.equal(nextStoryId(stories, null), 'a');
  assert.equal(nextStoryId([{ id: 'a', finalEstimate: '1' }], 'a'), null);
  assert.equal(nextStoryId([], null), null);
});

test('the deck can change only before any vote or final estimate', () => {
  assert.equal(canChangeDeck(decodePokerRoom({ stories: { s1: story() } })), true);
  assert.equal(canChangeDeck(decodePokerRoom({ stories: { s1: story({ finalEstimate: '5' }) } })), false);
  assert.equal(canChangeDeck(decodePokerRoom({ stories: { s1: story() }, votes: { [pokerVoteKey('s1', 'u1')]: '3' } })), false);
});
