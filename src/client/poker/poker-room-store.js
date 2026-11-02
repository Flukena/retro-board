// Framework-free view of an open poker room: decoded document state, online
// participant names and undo availability, published as immutable snapshots
// for useSyncExternalStore.
import { normalizeResultParticipants } from '../../domain/vote-results.js';
import { readVoteResultParticipants } from '../../domain/vote-result-participants.js';
import { decodePokerRoom, nextStoryId } from '../../domain/poker-schema.js';
import {
  POKER_REACTION_COOLDOWN_MS, POKER_REACTION_FIELD, POKER_REACTION_TTL_MS, activeReactions, pokerReaction,
} from '../../domain/poker-reactions.js';
import * as actions from './poker-actions.js';

// storage-bridge.js keeps board items in `items` and marks `meta.__migrated`
// the first time any board client opens the room, even an empty board. Such a
// room is a retro board and must not be turned into a poker room.
const BOARD_ITEMS_MAP_NAME = 'items';
const BOARD_META_MAP_NAME = 'meta';
const BOARD_OPENED_META_KEY = '__migrated';
const isBoardRoom = (doc) => doc.getMap(BOARD_ITEMS_MAP_NAME).size > 0 || doc.getMap(BOARD_META_MAP_NAME).has(BOARD_OPENED_META_KEY);

export function createPokerRoomStore({ doc, awareness, undoManager }, { userId, userName }, {
  now = Date.now, createId, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const listeners = new Set();
  let snapshot = null;

  const build = () => {
    const names = normalizeResultParticipants(readVoteResultParticipants(awareness, now()));
    return Object.freeze({
      room: decodePokerRoom(actions.readPokerSnapshot(doc)),
      names,
      reactions: activeReactions(awareness.getStates().values(), new Set(names.keys())),
      userId,
      canUndo: undoManager.canUndo(),
      canRedo: undoManager.canRedo(),
      hasBoardContent: isBoardRoom(doc),
    });
  };
  const publish = () => {
    snapshot = build();
    listeners.forEach((listener) => listener());
  };
  const announce = (name) => awareness.setLocalStateField('user', { userId, name, lastSeen: now() });

  snapshot = build();
  doc.on('update', publish);
  awareness.on('change', publish);
  undoManager.on('stack-item-added', publish);
  undoManager.on('stack-item-popped', publish);
  if (userName) announce(userName);

  // One reaction at a time per participant: a new one replaces the old, and
  // the sender clears it after the TTL so peers never keep a stale emoji.
  let reactionCount = 0;
  let lastReactionAt = -Infinity;
  let clearReactionTimer = null;
  const react = (toUserId, emoji) => {
    const at = now();
    if (at - lastReactionAt < POKER_REACTION_COOLDOWN_MS) return;
    reactionCount += 1;
    const reaction = pokerReaction(toUserId, emoji, String(reactionCount));
    if (!reaction) return;
    lastReactionAt = at;
    clearTimer(clearReactionTimer);
    awareness.setLocalStateField(POKER_REACTION_FIELD, reaction);
    clearReactionTimer = setTimer(() => awareness.setLocalStateField(POKER_REACTION_FIELD, null), POKER_REACTION_TTL_MS);
  };

  const activeId = () => snapshot.room.activeStoryId;
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setName: announce,
    react,
    vote: (cardId) => actions.castVote(doc, activeId(), userId, cardId),
    clearVote: () => actions.clearVote(doc, activeId(), userId),
    reveal: () => actions.revealStory(doc, activeId(), now()),
    resetRound: () => actions.resetRound(doc, activeId()),
    acceptEstimate: (cardId) => actions.setFinalEstimate(doc, activeId(), cardId),
    nextStory: () => {
      const next = nextStoryId(snapshot.room.stories, activeId());
      if (next) actions.setActiveStory(doc, next);
    },
    selectStory: (storyId) => actions.setActiveStory(doc, storyId),
    addStories: (titles) => actions.addStories(doc, titles, { now: now(), createId }),
    renameStory: (storyId, title) => actions.renameStory(doc, storyId, title),
    removeStory: (storyId) => actions.removeStory(doc, storyId),
    setDeck: (deckId) => actions.setDeck(doc, deckId),
    claimRoom: () => actions.initPokerRoom(doc),
    undo: () => undoManager.undo(),
    redo: () => undoManager.redo(),
    destroy() {
      clearTimer(clearReactionTimer);
      doc.off('update', publish);
      awareness.off('change', publish);
      undoManager.off('stack-item-added', publish);
      undoManager.off('stack-item-popped', publish);
      listeners.clear();
    },
  };
}
