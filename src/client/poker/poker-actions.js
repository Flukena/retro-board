// Writes to a Planning Poker room document. Every change is one transaction;
// inputs are validated with the same domain rules the decoder uses.
import * as Y from 'yjs';
import { isSafeId } from '../../domain/comment-schema.js';
import { deckById, isCardInDeck, isPokerDeckId } from '../../domain/poker-deck.js';
import {
  MAX_STORIES_PER_ROOM, POKER_DOC_KEY, POKER_ROOM_KIND,
  normalizeStoryTitle, parsePokerVoteKey, pokerVoteKey,
} from '../../domain/poker-schema.js';

// Story edits (add, rename, remove) are undoable; round actions (votes,
// reveal, final estimate) are not, so undo never resurrects a hidden vote.
export const POKER_ORIGIN = Object.freeze({ STORY_EDIT: 'local', ROUND: 'poker-round' });
export const POKER_SHARED_MAP_NAMES = Object.freeze(Object.values(POKER_DOC_KEY));

const roomMap = (doc) => doc.getMap(POKER_DOC_KEY.ROOM);
const storiesMap = (doc) => doc.getMap(POKER_DOC_KEY.STORIES);
const votesMap = (doc) => doc.getMap(POKER_DOC_KEY.VOTES);
const roomDeck = (doc) => deckById(roomMap(doc).get('deckId'));
const storyOf = (doc, storyId) => (isSafeId(storyId) ? storiesMap(doc).get(storyId) ?? null : null);

export function initPokerRoom(doc, deckId) {
  const room = roomMap(doc);
  if (room.get('kind') === POKER_ROOM_KIND) return;
  doc.transact(() => {
    room.set('kind', POKER_ROOM_KIND);
    room.set('deckId', isPokerDeckId(deckId) ? deckId : deckById(null).id);
  }, POKER_ORIGIN.ROUND);
}

export function castVote(doc, storyId, userId, cardId) {
  const story = storyOf(doc, storyId);
  if (!story || !isSafeId(userId) || story.get('revealedAt') != null || !isCardInDeck(roomDeck(doc), cardId)) return false;
  doc.transact(() => votesMap(doc).set(pokerVoteKey(storyId, userId), cardId), POKER_ORIGIN.ROUND);
  return true;
}

export function clearVote(doc, storyId, userId) {
  const story = storyOf(doc, storyId);
  if (!story || story.get('revealedAt') != null) return;
  doc.transact(() => votesMap(doc).delete(pokerVoteKey(storyId, userId)), POKER_ORIGIN.ROUND);
}

export function revealStory(doc, storyId, now) {
  const story = storyOf(doc, storyId);
  if (!story || story.get('revealedAt') != null) return;
  doc.transact(() => story.set('revealedAt', now), POKER_ORIGIN.ROUND);
}

function deleteStoryVotes(doc, storyId) {
  const votes = votesMap(doc);
  for (const key of [...votes.keys()]) {
    if (parsePokerVoteKey(key)?.storyId === storyId) votes.delete(key);
  }
}

export function resetRound(doc, storyId) {
  const story = storyOf(doc, storyId);
  if (!story) return;
  doc.transact(() => {
    deleteStoryVotes(doc, storyId);
    story.set('revealedAt', null);
    story.set('finalEstimate', null);
  }, POKER_ORIGIN.ROUND);
}

export function setFinalEstimate(doc, storyId, cardId) {
  const story = storyOf(doc, storyId);
  if (!story || (cardId !== null && !isCardInDeck(roomDeck(doc), cardId))) return;
  doc.transact(() => story.set('finalEstimate', cardId), POKER_ORIGIN.ROUND);
}

export function setActiveStory(doc, storyId) {
  if (storyId !== null && !storyOf(doc, storyId)) return;
  doc.transact(() => roomMap(doc).set('activeStoryId', storyId), POKER_ORIGIN.ROUND);
}

export function setDeck(doc, deckId) {
  if (!isPokerDeckId(deckId)) return;
  doc.transact(() => roomMap(doc).set('deckId', deckId), POKER_ORIGIN.ROUND);
}

function nextOrder(stories) {
  let highest = 0;
  stories.forEach((story) => { highest = Math.max(highest, Number(story.get('order')) || 0); });
  return highest + 1;
}

// Returns the ids it created, in order. Titles past the room cap are dropped.
export function addStories(doc, titles, { now, createId }) {
  const stories = storiesMap(doc);
  const clean = titles.map(normalizeStoryTitle).filter(Boolean).slice(0, Math.max(0, MAX_STORIES_PER_ROOM - stories.size));
  if (!clean.length) return [];
  const ids = [];
  doc.transact(() => {
    let order = nextOrder(stories);
    for (const title of clean) {
      const id = createId();
      const story = new Y.Map();
      stories.set(id, story);
      story.set('title', title);
      story.set('order', order);
      story.set('createdAt', now);
      story.set('revealedAt', null);
      story.set('finalEstimate', null);
      ids.push(id);
      order += 1;
    }
  }, POKER_ORIGIN.STORY_EDIT);
  if (!storyOf(doc, roomMap(doc).get('activeStoryId'))) setActiveStory(doc, ids[0]);
  return ids;
}

export function renameStory(doc, storyId, title) {
  const story = storyOf(doc, storyId);
  const clean = normalizeStoryTitle(title);
  if (!story || !clean || story.get('title') === clean) return;
  doc.transact(() => story.set('title', clean), POKER_ORIGIN.STORY_EDIT);
}

export function removeStory(doc, storyId) {
  if (!storyOf(doc, storyId)) return;
  doc.transact(() => {
    storiesMap(doc).delete(storyId);
    deleteStoryVotes(doc, storyId);
    if (roomMap(doc).get('activeStoryId') === storyId) roomMap(doc).set('activeStoryId', null);
  }, POKER_ORIGIN.STORY_EDIT);
}

// Snapshot in the shape decodePokerRoom expects.
export const readPokerSnapshot = (doc) => ({
  [POKER_DOC_KEY.ROOM]: roomMap(doc).toJSON(),
  [POKER_DOC_KEY.STORIES]: storiesMap(doc).toJSON(),
  [POKER_DOC_KEY.VOTES]: votesMap(doc).toJSON(),
});

export const createStoryUndoManager = (doc) => new Y.UndoManager(storiesMap(doc), {
  trackedOrigins: new Set([POKER_ORIGIN.STORY_EDIT]),
});
