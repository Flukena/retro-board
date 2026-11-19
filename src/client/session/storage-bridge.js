import { createContributionStore } from './bridge/contribution-store.js';
import { createBoardMethods } from './bridge/board-methods.js';
import { createStorageAccess } from './bridge/storage-access.js';
import { createRoomMethods } from './bridge/room-methods.js';
import { planImportBundle } from './bridge/import-plan.js';
import { VOTE_PREFIX, COMMENT_PREFIX } from '../../domain/vote-comment-keys.js';
import { createUndoController } from './bridge/undo-controller.js';
import { createSnapshotDoc, LEGACY_BOARD_KEY, META_INTERNAL_PREFIX } from './bridge/snapshot-doc.js';
import { createAwarenessPresence } from './bridge/awareness-presence.js';
import { createUserPreferences } from './bridge/user-prefs.js';
// window.storage polyfill backed by Yjs over WebSocket.
//
// Two storage layers live on the same Y.Doc:
//
//   1. ymap  ('kv')    — flat Y.Map for client-scoped keys (userId,
//                        presence heartbeats) plus the per-vote keys
//                        `s||vote:<itemId>:<userId>`. Each value is a CRDT-safe
//                        scalar/blob LWW write, but since keys are independent
//                        no two writes ever trample each other.
//
//   2. yItems ('items') + yMeta ('meta') — the board.
//        - yItems : Y.Map<itemId, Y.Map<fieldName, value>>.  Each item is its
//                   own Y.Map, each field its own key. Concurrent edits to
//                   different items, or to different fields of the same item,
//                   merge cleanly instead of LWW-trampling each other.
//                   Editable `text` / `title` fields are nested Y.Text values,
//                   so simultaneous edits inside the same field also merge at
//                   character level.
//        - yMeta  : Y.Map of board-level fields (timer, editingLocked,
//                   allRevealed, lastResultsAt, adminUserId).
//
//   This split is what makes multi-device undo/redo safe. The old design
//   stored the whole board as one JSON blob at `s||boardState`; undoing a
//   single sticky edit reverted the entire blob, wiping any concurrent
//   peer changes. With per-field Yjs ops, undo only inverts the exact
//   operations the local user made.
//
//   RetroBoard still calls storage.set('boardState', fullBoard, true) and
//   storage.get('boardState', true) — those are intercepted here and
//   translated into a granular field-level diff against the current Yjs
//   state, so the UI code stays unchanged.




import * as Y from 'yjs';
import { createDrawingPreviews } from './drawing-previews.js';
import { createReactionChannel } from '../reactions/reaction-channel.js';
import { createWritingTimerStore } from '../writing-timer/writing-timer-store.js';
import { attachClientSync } from './client-sync.js';
import { createPublicPermit } from './bridge/public-permit.js';
import { PublicCreationGuard } from './public-creation-guard.js';
import { attachPublicCreationBudget } from './public-creation-budget.js';

import { createRoomProvider, isEncryptedRoom } from './room-provider.js';
import { attachE2ERoom } from './e2e-room.js';
import { getRoomKey } from '../room-lock/lock-session.js';

import { repairOldEpochImages } from '../room-lock/e2e-image-repair.js';

import { createMotionPublisher, sendOnlyLocalAwareness } from './awareness-transport.js';
import { parseRoute } from '../app/router.js';
import { getActiveRoomSession, getRoomWebSocketBaseUrl, refreshActiveRoomSession } from './room-session.js';


import { isMoodKey } from './mood-store.js';

import { replaceTemplates } from '../../domain/template-store.js';


const route = parseRoute();
if (!['board', 'public'].includes(route.kind)) {
  window.storage = {
    async get() { return null; },
    async set() { /* noop */ },
    snapshotTemplates() { return []; },
    putTemplate() { return false; },
    removeTemplate() { return false; },
    onTemplatesChange() { /* noop */ },
    offTemplatesChange() { /* noop */ },
    on() { /* noop */ },
    off() { /* noop */ },
    setLocalBusyItems() { /* noop */ },
    findRemoteBusyItem() { return null; },
    getRemoteBusyItems() { return new Map(); },
    onBusyChange() { return () => {}; },
    offBusyChange() { /* noop */ },
    getRemoteEditingItems() { return new Map(); },
    onEditingChange() { return () => {}; },
    offEditingChange() { /* noop */ },
    setLocalSelectedItems() { /* noop */ },
    getRemoteSelectedItems() { return new Map(); },
    onSelectionChange() { return () => {}; },
    offSelectionChange() { /* noop */ },
    getPresenceSnapshot() { return {}; },
    onPresenceChange() { return () => {}; },
    offPresenceChange() { /* noop */ },
    setLocalCursor() { /* noop */ },
    setLocalView() { /* noop */ },
  };
}

// main.jsx imports this bridge only after exchanging the fragment capability
// for an HttpOnly room cookie. The provider room is an opaque, non-secret
// handle, so neither the WebSocket URL nor its BroadcastChannel name contains
// the bearer token or the canonical LevelDB document name.
const activeRoomSession = ['board', 'public'].includes(route.kind) ? getActiveRoomSession() : null;
if (['board', 'public'].includes(route.kind) && !activeRoomSession) {
  throw new Error('room session has not been established');
}
const ROOM = activeRoomSession?.roomHandle || `landing-${route.code || 'unused'}`;

const WS_URL = getRoomWebSocketBaseUrl();

const ydoc = new Y.Doc();
const ymap = ydoc.getMap('kv');
const yItems = ydoc.getMap('items');
const yMeta = ydoc.getMap('meta');

const publicCreationGuard = route.kind === 'public' ? new PublicCreationGuard() : null;
const roomKey = getRoomKey();
let provider = null;
if (['board', 'public'].includes(route.kind)) {
  provider = createRoomProvider({
    wsBaseUrl: WS_URL, roomHandle: ROOM, ydoc, roomKey,
    // The Public Wall keeps its own recovery; only a private board checks for deletion after refused upgrades.
    probeSession: route.kind === 'board' ? refreshActiveRoomSession : null,
    // Bind the relay connection to this one Yjs awareness identity. The ID is
    // not a credential; it lets the server distinguish our own state from
    // y-websocket's legitimate BroadcastChannel/snapshot echoes.
    params: { awarenessId: String(ydoc.clientID), ...(publicCreationGuard ? { quota: '1' } : {}) },
  });
  if (publicCreationGuard) attachPublicCreationBudget(provider, publicCreationGuard);
  sendOnlyLocalAwareness(provider);
}
const syncStatus = provider ? attachClientSync(provider, ydoc, window) : null;
if (publicCreationGuard) {
  const observeCreations = (event, transaction) => {
    if (!transaction.local) return;
    const created = [];
    for (const [id, change] of event.changes.keys) {
      if (change.action !== 'delete') created.push({ id, type: yItems.get(id)?.get?.('type') });
    }
    publicCreationGuard.record(created);
  };
  yItems.observe(observeCreations);
  ydoc.on('destroy', () => yItems.unobserve(observeCreations));
}
const publicPermit = createPublicPermit({
  publicCreationGuard, syncStatus, eventTarget: window,
});
const { permitPublicCreations } = publicPermit;
if (provider) provider.connect();
const motionPublisher = provider ? createMotionPublisher(provider.awareness) : null;
ydoc.on('destroy', () => motionPublisher?.destroy());

const userPreferences = createUserPreferences({ ydoc, ymap, provider, activeRoomSession, route });
const { clientId } = userPreferences;

const emitter = new EventTarget();

// Declared up front so the various ymap/yItems observers below can safely
// reference it in their closures even though it's instantiated later.
let undoManager = null;

// `boardState` now flows through yItems/yMeta. We delete the legacy ymap key
// during migration; this guard ensures any rogue write to it (e.g. from a
// stale client tab still running the old code) doesn't trample the granular
// React state.
const snapshot = createSnapshotDoc({ ydoc, yItems, yMeta, publicPermit });
const { readRemoteBoardSnapshot, writeBoardSnapshot, newSnapshotItems } = snapshot;
snapshot.attachMaintenance({ provider, ymap });

// ---------------------------------------------------------------------------
// Event dispatch — fan changes out to RetroBoard's storage.on('change') handler.
// ---------------------------------------------------------------------------
const dispatchKey = (mapKey) => {
  if (mapKey === LEGACY_BOARD_KEY) return; // owned by yItems/yMeta now
  const sep1 = mapKey.indexOf('|');
  const sep2 = mapKey.indexOf('|', sep1 + 1);
  if (sep1 < 0 || sep2 < 0) return;
  const scope = mapKey.slice(0, sep1);
  const cid = mapKey.slice(sep1 + 1, sep2);
  const key = mapKey.slice(sep2 + 1);
  if (scope === 'u' && cid !== clientId) return;
  const value = ymap.get(mapKey) ?? null;
  emitter.dispatchEvent(new CustomEvent('change', {
    detail: { scope, key, value },
  }));
};

ymap.observe((event) => {
  // Skip echoes from our own writes — React state is already in sync.
  // Exception: undo/redo transactions are also "local" from Yjs's perspective,
  // but they revert state behind React's back, so they DO need to dispatch.
  const isUndoRedo = undoManager && event.transaction.origin === undoManager;
  if (event.transaction.local && !isUndoRedo) return;
  event.keysChanged.forEach((mapKey) => dispatchKey(mapKey));
});

// Board changes flow through yItems / yMeta. Emit a synthetic boardState
// change event so RetroBoard's existing applyRemoteBoard handler keeps working.
const fireBoardChange = (origin, deletedItemIds = []) => {
  const isUndoRedo = undoManager && origin === undoManager;
  // 'local' = our own write that's already reflected in React state.
  // 'system' = migration seed; we DO want React to pick it up.
  // remote (provider as origin) and undoRedo: dispatch.
  if (origin === 'local' && !isUndoRedo) return;
  emitter.dispatchEvent(new CustomEvent('change', {
    detail: { scope: 's', key: 'boardState', value: readRemoteBoardSnapshot(), isUndoRedo, deletedItemIds },
  }));
};

const deletedRootItemIds = (events) => {
  const deletedIds = [];
  for (const event of events) {
    if (event.target !== yItems) continue;
    for (const [id, change] of event.changes.keys) {
      if (change.action === 'delete') deletedIds.push(id);
    }
  }
  return deletedIds;
};

yItems.observeDeep((events) => {
  if (!events.length) return;
  fireBoardChange(events[0].transaction.origin, deletedRootItemIds(events));
});
yMeta.observe((event) => {
  // Ignore changes to internal flags (e.g. __migrated).
  let hasPublic = false;
  event.keysChanged.forEach((k) => {
    if (!k.startsWith(META_INTERNAL_PREFIX)) hasPublic = true;
  });
  if (!hasPublic) return;
  fireBoardChange(event.transaction.origin);
});

// ---------------------------------------------------------------------------
// Votes and comments live at independent keys in `ymap`, so concurrent writes
// never trample-overwrite another user's contribution.
// ---------------------------------------------------------------------------
const contributions = createContributionStore({ ydoc, ymap, yItems, snapshot });

const presence = createAwarenessPresence({ provider, motionPublisher, emitter });

if (provider) {
  const roomMethods = createRoomMethods({ provider, syncStatus, activeRoomSession, ydoc, yItems, yMeta });
  window.storage = {
    ...createStorageAccess({ ydoc, ymap, userPreferences, presence, snapshot, emitter }),
    ...presence.methods,

    ...roomMethods.images,

    ...createBoardMethods({ ydoc, yItems, yMeta, snapshot, publicPermit }),

    // Restore a fully preflighted backup as one Yjs transaction. Keeping the
    // board, votes, comments, and shared templates together avoids partial
    // imports and prevents one WebSocket update / O(N) snapshot rebuild per
    // comment. Validate again here because window.storage is a public seam.
    importBundle(board, voteEntries, commentEntries, customTemplates, moodEntries = []) {
      const plan = planImportBundle(board, voteEntries, commentEntries, customTemplates, moodEntries);
      if (!plan) return false;
      const { moodWrites, normalizedTemplates, normalizedVotes, normalizedComments } = plan;

      if (!permitPublicCreations(newSnapshotItems(board.items))) return false;
      const relatedKeys = [];
      ymap.forEach((_value, key) => {
        if (key.startsWith(VOTE_PREFIX) || key.startsWith(COMMENT_PREFIX) || isMoodKey(key)) relatedKeys.push(key);
      });
      ydoc.transact(() => {
        // writeBoardSnapshot's nested transaction joins this active outer
        // transaction in Yjs, so peers and UndoManager observe one command.
        writeBoardSnapshot(board, 'local');
        relatedKeys.forEach((key) => ymap.delete(key));
        normalizedVotes.forEach((key) => ymap.set(key, 1));
        normalizedComments.forEach(({ key, comment }) => ymap.set(key, comment));
        moodWrites.forEach(({ key, score }) => ymap.set(key, score));
        if (normalizedTemplates) replaceTemplates(ymap, normalizedTemplates);
      }, 'local');
      return true;
    },

    ...contributions.methods,

    ...roomMethods.sync,
  };
}

// ---------------------------------------------------------------------------
// Undo / Redo via Y.UndoManager.
//
// Tracks operations on yItems, yMeta, and ymap (per-vote, comment, and template keys).
// `trackedOrigins: ['local']` means:
//   - Local board edits, vote/comment changes, template puts/removes → tracked.
//   - Remote peer writes (origin = WebsocketProvider) → ignored, so undo
//     never reverses another user's work.
//   - Per-device settings + presence (origin = 'system') → ignored.
//   - Migration (origin = 'system') → ignored.
//
// Because yItems is tracked as a parent type, Y.UndoManager auto-tracks ops
// on the nested per-item Y.Maps too — so a sticky-text edit and a sticky drag
// produce independent stack entries that can be undone individually without
// touching any peer's concurrent changes.
// ---------------------------------------------------------------------------
if (provider) {
  const undoController = createUndoController({ yItems, yMeta, ymap });
  undoManager = undoController.undoManager;
  Object.assign(window.storage, undoController.methods);
}

if (provider && isEncryptedRoom(roomKey, ROOM)) {
  const e2eRoom = attachE2ERoom({
    provider, ydoc, eventTarget: window, getRoomKey, clearUndo: () => undoManager?.clear(),
    repairImages: () => repairOldEpochImages({ storage: window.storage }),
  });
  window.storage.rotationSource = e2eRoom.rotationSource;
}

// Use the visible board code in diagnostics. The actual provider room handle
// is non-secret, but omitting it keeps logs stable and easy to correlate.
const ROOM_LABEL = `board-${route.code || 'unused'}`;

if (provider) {
  provider.on('status', (ev) => {
    // eslint-disable-next-line no-console
    console.debug('[yjs]', ROOM_LABEL, ev.status);
  });
}

// Debug handles are dev-only — exposing them in prod prints the room name
// (with token) into any extension that reads `window`.
if (import.meta.env && import.meta.env.DEV) {
  window.__rbYDoc = ydoc;
  window.__rbClientId = clientId;
  window.__rbRoom = ROOM;
  window.__rbYItems = yItems;
  window.__rbYMeta = yMeta;
  window.__rbProvider = provider;
  window.__rbDebug = () => ({
    room: ROOM,
    clientId,
    yClientID: ydoc.clientID,
    synced: !!provider?.synced,
    yMetaAdminUserId: yMeta.get('adminUserId') || null,
    yMetaAdminName: yMeta.get('adminName') || null,
    yMetaAll: Array.from(yMeta.entries()).filter(([k]) => !k.startsWith('__')),
    uScopeKeys: Array.from(ymap.entries()).filter(([k]) => k.startsWith(`u|${clientId}|`)),
    awareness: Array.from((provider?.awareness?.getStates?.() || new Map()).entries()),
    yItemsCount: yItems.size,
  });
}

if (provider) {
  const previews = createDrawingPreviews(ydoc, provider.awareness);
  window.storage.drawingPreviews = previews;
  ydoc.on('destroy', () => previews.destroy());
}

// Emoji reactions and the card-writing timer are for retro boards only: the Public Wall gets neither.
if (provider && route.kind === 'board') {
  const reactions = createReactionChannel(provider.awareness);
  window.storage.boardReactions = reactions;
  ydoc.on('destroy', () => reactions.destroy());
  const writingTimer = createWritingTimerStore({ doc: ydoc, isLive: () => provider.synced });
  window.storage.writingTimer = writingTimer;
  ydoc.on('destroy', () => writingTimer.destroy());
}
