// Decoder for the Planning Poker room doc: the Yjs doc is canonical and
// written by any link holder, so every field is checked before it is shown.
import { isSafeId } from './comment-schema.js';
import { DEFAULT_POKER_DECK_ID, deckById, isCardInDeck, isPokerDeckId } from './poker-deck.js';

export const POKER_ROOM_KIND = 'poker';
export const POKER_DOC_KEY = Object.freeze({ ROOM: 'poker', STORIES: 'stories', VOTES: 'votes' });
export const MAX_STORY_TITLE_CHARS = 300;
export const MAX_STORIES_PER_ROOM = 200;
// ECMAScript Date range, so stored timestamps are always renderable.
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const VOTE_KEY_SEPARATOR = ':';
const LINE_BREAK_PATTERN = /\r?\n/;

const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP_MS;
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const entriesOf = (value) => (isPlainObject(value) ? Object.entries(value) : []);

export const pokerVoteKey = (storyId, userId) => `${storyId}${VOTE_KEY_SEPARATOR}${userId}`;

export function parsePokerVoteKey(key) {
  const parts = typeof key === 'string' ? key.split(VOTE_KEY_SEPARATOR) : [];
  if (parts.length !== 2 || !parts.every(isSafeId)) return null;
  return { storyId: parts[0], userId: parts[1] };
}

export function normalizeStoryTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim().slice(0, MAX_STORY_TITLE_CHARS);
  return title || null;
}

// One story per non-empty pasted line, limited to the room's free slots.
export function storyTitlesFromText(text, existingCount = 0) {
  const freeSlots = Math.max(0, MAX_STORIES_PER_ROOM - existingCount);
  if (typeof text !== 'string') return [];
  return text.split(LINE_BREAK_PATTERN).map(normalizeStoryTitle).filter(Boolean).slice(0, freeSlots);
}

function decodeStory(id, value, deckEntry) {
  const title = normalizeStoryTitle(value?.title);
  if (!isSafeId(id) || !title) return null;
  return {
    id,
    title,
    order: Number.isFinite(value.order) ? value.order : 0,
    createdAt: isTimestamp(value.createdAt) ? value.createdAt : 0,
    revealedAt: isTimestamp(value.revealedAt) ? value.revealedAt : null,
    finalEstimate: isCardInDeck(deckEntry, value.finalEstimate) ? value.finalEstimate : null,
  };
}

const compareStories = (a, b) => a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

function decodeStories(raw, deckEntry) {
  return entriesOf(raw)
    .map(([id, value]) => decodeStory(id, value, deckEntry))
    .filter(Boolean)
    .sort(compareStories)
    .slice(0, MAX_STORIES_PER_ROOM);
}

function decodeVotes(raw, storyIds, deckEntry) {
  const votesByStory = new Map();
  for (const [key, cardId] of entriesOf(raw)) {
    const parsed = parsePokerVoteKey(key);
    if (!parsed || !storyIds.has(parsed.storyId) || !isCardInDeck(deckEntry, cardId)) continue;
    if (!votesByStory.has(parsed.storyId)) votesByStory.set(parsed.storyId, new Map());
    votesByStory.get(parsed.storyId).set(parsed.userId, cardId);
  }
  return votesByStory;
}

// raw = { poker, stories, votes } as returned by Y.Map#toJSON().
export function decodePokerRoom(raw) {
  const room = isPlainObject(raw?.[POKER_DOC_KEY.ROOM]) ? raw[POKER_DOC_KEY.ROOM] : {};
  const deckId = isPokerDeckId(room.deckId) ? room.deckId : DEFAULT_POKER_DECK_ID;
  const deck = deckById(deckId);
  const stories = decodeStories(raw?.[POKER_DOC_KEY.STORIES], deck);
  const storyIds = new Set(stories.map((story) => story.id));
  return {
    isPoker: room.kind === POKER_ROOM_KIND,
    deckId,
    deck,
    activeStoryId: storyIds.has(room.activeStoryId) ? room.activeStoryId : null,
    stories,
    votesByStory: decodeVotes(raw?.[POKER_DOC_KEY.VOTES], storyIds, deck),
  };
}

// The story after the active one that still needs an estimate; wraps to the
// start so skipped stories are not lost. Null when every story is estimated.
export function nextStoryId(stories, activeStoryId) {
  const start = stories.findIndex((story) => story.id === activeStoryId);
  for (let step = 1; step <= stories.length; step += 1) {
    const candidate = stories[(start + step + stories.length) % stories.length];
    if (candidate.id !== activeStoryId && candidate.finalEstimate === null) return candidate.id;
  }
  return null;
}

// Switching decks would orphan stored cards, so it is only offered before any
// vote or final estimate exists.
export const canChangeDeck = (state) => (
  state.votesByStory.size === 0 && state.stories.every((story) => story.finalEstimate === null)
);
