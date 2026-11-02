import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

import { POKER_DECK_ID } from '../../domain/poker-deck.js';
import { MAX_STORIES_PER_ROOM, decodePokerRoom } from '../../domain/poker-schema.js';
import {
  addStories, castVote, clearVote, createStoryUndoManager, initPokerRoom, readPokerSnapshot,
  removeStory, renameStory, resetRound, revealStory, setActiveStory, setDeck, setFinalEstimate,
} from './poker-actions.js';

const NOW_MS = 1_700_000_000_000;

function connectedPair(context) {
  const alice = new Y.Doc();
  const bob = new Y.Doc();
  alice.on('update', (update, origin) => { if (origin !== 'peer') Y.applyUpdate(bob, update, 'peer'); });
  bob.on('update', (update, origin) => { if (origin !== 'peer') Y.applyUpdate(alice, update, 'peer'); });
  context.after(() => { alice.destroy(); bob.destroy(); });
  return { alice, bob };
}

const state = (doc) => decodePokerRoom(readPokerSnapshot(doc));
let idCounter = 0;
const createId = () => { idCounter += 1; return `story${idCounter}`; };
const addOne = (doc, title = 'Login page') => addStories(doc, [title], { now: NOW_MS, createId })[0];

test('the creator marks the room as poker once and peers see it', (context) => {
  const { alice, bob } = connectedPair(context);
  initPokerRoom(alice, POKER_DECK_ID.TSHIRT);
  initPokerRoom(alice, POKER_DECK_ID.FIBONACCI);
  assert.equal(state(bob).isPoker, true);
  assert.equal(state(bob).deckId, POKER_DECK_ID.TSHIRT);
});

test('added stories sync, keep paste order and the first becomes active', (context) => {
  const { alice, bob } = connectedPair(context);
  initPokerRoom(alice);
  const ids = addStories(alice, ['  First ', '', 'Second'], { now: NOW_MS, createId });
  assert.equal(ids.length, 2);
  assert.deepEqual(state(bob).stories.map((story) => story.title), ['First', 'Second']);
  assert.equal(state(bob).activeStoryId, ids[0]);
});

test('adding stops at the room story cap', (context) => {
  const { alice } = connectedPair(context);
  initPokerRoom(alice);
  addStories(alice, Array.from({ length: MAX_STORIES_PER_ROOM - 1 }, (_, index) => `s${index}`), { now: NOW_MS, createId });
  assert.equal(addStories(alice, ['a', 'b', 'c'], { now: NOW_MS, createId }).length, 1);
  assert.equal(state(alice).stories.length, MAX_STORIES_PER_ROOM);
});

test('votes from both participants reach each other and only deck cards are accepted', (context) => {
  const { alice, bob } = connectedPair(context);
  initPokerRoom(alice);
  const storyId = addOne(alice);
  assert.equal(castVote(alice, storyId, 'alice', '5'), true);
  assert.equal(castVote(bob, storyId, 'bob', '8'), true);
  assert.equal(castVote(bob, storyId, 'bob', 'XL'), false);
  assert.deepEqual(Object.fromEntries(state(alice).votesByStory.get(storyId)), { alice: '5', bob: '8' });
  clearVote(bob, storyId, 'bob');
  assert.deepEqual(Object.fromEntries(state(alice).votesByStory.get(storyId)), { alice: '5' });
});

test('after reveal, votes are frozen until the round is reset', (context) => {
  const { alice, bob } = connectedPair(context);
  initPokerRoom(alice);
  const storyId = addOne(alice);
  castVote(alice, storyId, 'alice', '3');
  revealStory(bob, storyId, NOW_MS);
  assert.equal(state(alice).stories[0].revealedAt, NOW_MS);
  assert.equal(castVote(alice, storyId, 'alice', '13'), false);
  clearVote(alice, storyId, 'alice');
  assert.equal(state(bob).votesByStory.get(storyId).get('alice'), '3');
  setFinalEstimate(alice, storyId, '3');
  resetRound(bob, storyId);
  const [story] = state(alice).stories;
  assert.deepEqual([story.revealedAt, story.finalEstimate, state(alice).votesByStory.has(storyId)], [null, null, false]);
  assert.equal(castVote(alice, storyId, 'alice', '13'), true);
});

test('a final estimate must be a card of the room deck or cleared', (context) => {
  const { alice } = connectedPair(context);
  initPokerRoom(alice);
  const storyId = addOne(alice);
  setFinalEstimate(alice, storyId, 'XXL');
  assert.equal(state(alice).stories[0].finalEstimate, null);
  setFinalEstimate(alice, storyId, '8');
  assert.equal(state(alice).stories[0].finalEstimate, '8');
  setFinalEstimate(alice, storyId, null);
  assert.equal(state(alice).stories[0].finalEstimate, null);
});

test('removing a story drops its votes and clears it as active', (context) => {
  const { alice, bob } = connectedPair(context);
  initPokerRoom(alice);
  const storyId = addOne(alice);
  castVote(bob, storyId, 'bob', '2');
  removeStory(bob, storyId);
  const decoded = state(alice);
  assert.deepEqual([decoded.stories.length, decoded.activeStoryId, alice.getMap('votes').size], [0, null, 0]);
});

test('the active story and deck only accept known values', (context) => {
  const { alice } = connectedPair(context);
  initPokerRoom(alice);
  const first = addOne(alice, 'A');
  const second = addOne(alice, 'B');
  setActiveStory(alice, 'missing');
  assert.equal(state(alice).activeStoryId, first);
  setActiveStory(alice, second);
  assert.equal(state(alice).activeStoryId, second);
  setDeck(alice, 'nope');
  setDeck(alice, POKER_DECK_ID.POWERS_OF_TWO);
  assert.equal(state(alice).deckId, POKER_DECK_ID.POWERS_OF_TWO);
});

test('story renames undo and redo, while votes and reveal are not undone', (context) => {
  const { alice, bob } = connectedPair(context);
  initPokerRoom(alice);
  const undo = createStoryUndoManager(alice);
  context.after(() => undo.destroy());
  const storyId = addOne(alice, 'Old title');
  undo.stopCapturing();
  renameStory(alice, storyId, '  New title ');
  castVote(alice, storyId, 'alice', '5');
  revealStory(alice, storyId, NOW_MS);
  assert.equal(state(bob).stories[0].title, 'New title');
  undo.undo();
  assert.equal(state(bob).stories[0].title, 'Old title');
  assert.equal(state(bob).stories[0].revealedAt, NOW_MS);
  assert.equal(state(bob).votesByStory.get(storyId).get('alice'), '5');
  undo.redo();
  assert.equal(state(bob).stories[0].title, 'New title');
});

test('blank renames are ignored', (context) => {
  const { alice } = connectedPair(context);
  initPokerRoom(alice);
  const storyId = addOne(alice, 'Keep');
  renameStory(alice, storyId, '   ');
  assert.equal(state(alice).stories[0].title, 'Keep');
});
