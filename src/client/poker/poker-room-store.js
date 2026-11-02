// Framework-free view of an open poker room: decoded document state, online
// participant names and undo availability, published as immutable snapshots
// for useSyncExternalStore.
import { normalizeResultParticipants } from '../../domain/vote-results.js';
import { readVoteResultParticipants } from '../../domain/vote-result-participants.js';
import { decodePokerRoom, nextStoryId } from '../../domain/poker-schema.js';
import * as actions from './poker-actions.js';

// storage-bridge.js keeps board items in `items` and marks `meta.__migrated`
// the first time any board client opens the room, even an empty board. Such a
// room is a retro board and must not be turned into a poker room.
const BOARD_ITEMS_MAP_NAME = 'items';
const BOARD_META_MAP_NAME = 'meta';
const BOARD_OPENED_META_KEY = '__migrated';
const isBoardRoom = (doc) => doc.getMap(BOARD_ITEMS_MAP_NAME).size > 0 || doc.getMap(BOARD_META_MAP_NAME).has(BOARD_OPENED_META_KEY);

export function createPokerRoomStore({ doc, awareness, undoManager }, { userId, userName }, { now = Date.now, createId }) {
  const listeners = new Set();
  let snapshot = null;

  const build = () => Object.freeze({
    room: decodePokerRoom(actions.readPokerSnapshot(doc)),
    names: normalizeResultParticipants(readVoteResultParticipants(awareness, now())),
    userId,
    canUndo: undoManager.canUndo(),
    canRedo: undoManager.canRedo(),
    hasBoardContent: isBoardRoom(doc),
  });
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

  const activeId = () => snapshot.room.activeStoryId;
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setName: announce,
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
      doc.off('update', publish);
      awareness.off('change', publish);
      undoManager.off('stack-item-added', publish);
      undoManager.off('stack-item-popped', publish);
      listeners.clear();
    },
  };
}
