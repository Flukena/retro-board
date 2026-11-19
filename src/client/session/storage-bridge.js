import { planImportBundle } from './bridge/import-plan.js';
import { voteKey as VOTE_KEY, commentKey as COMMENT_KEY, VOTE_PREFIX, COMMENT_PREFIX,
  parseStoredVoteKey as parseVoteKey, parseStoredCommentKey as parseCommentKey } from '../../domain/vote-comment-keys.js';
import { createUndoController } from './bridge/undo-controller.js';
import { createSnapshotDoc, boardItemWriteError, boardItemsWriteError, LEGACY_BOARD_KEY,
  META_INTERNAL_PREFIX, IMAGE_REPAIR_ORIGIN, originOf } from './bridge/snapshot-doc.js';
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

import { CLEARED_VOTE_RESULTS } from '../../domain/vote-session-lifecycle.js';
import { readCanonicalVotes } from '../../domain/canonical-votes.js';
import { planVoteFinalization } from '../../domain/vote-finalization.js';
import * as Y from 'yjs';
import { createDrawingPreviews } from './drawing-previews.js';
import { createReactionChannel } from '../reactions/reaction-channel.js';
import { createWritingTimerStore } from '../writing-timer/writing-timer-store.js';
import { attachClientSync } from './client-sync.js';
import { createPublicPermit } from './bridge/public-permit.js';
import { PublicCreationGuard } from './public-creation-guard.js';
import { attachPublicCreationBudget } from './public-creation-budget.js';
import { LOCAL_ONLY_KEYS, readLocalPreference, writeLocalPreference } from './local-preferences.js';
import { createRoomProvider, isEncryptedRoom } from './room-provider.js';
import { attachE2ERoom } from './e2e-room.js';
import { getRoomKey } from '../room-lock/lock-session.js';
import { uploadEncryptedImage } from '../room-lock/e2e-images.js';
import { repairOldEpochImages } from '../room-lock/e2e-image-repair.js';
import { listImageSources, rewriteImageSources } from './item-image-sources.js';
import { createMotionPublisher, sendOnlyLocalAwareness } from './awareness-transport.js';
import { parseRoute } from '../app/router.js';
import {
  getActiveRoomSession,
  getRelayHttpBaseUrl,
  getRoomWebSocketBaseUrl,
  refreshActiveRoomSession,
  roomFetch,
} from './room-session.js';
import { COMMENT_MAX_LEN, isSafeId, normalizeComment } from '../../domain/comment-schema.js';
import { normalizeRuntimeImageSource } from '../../domain/security-boundaries.js';
import { isMoodKey, moodKeys, readMoods } from './mood-store.js';
import { isMoodScore, moodKey } from '../../domain/mood-check.js';
import {
  isTemplateKey,
  putTemplate,
  readTemplates,
  removeTemplate,
  replaceTemplates,
} from '../../domain/template-store.js';
import {
  geometryErrorForItem,
  geometryErrorForPatch,
} from '../../domain/board-geometry.js';

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
const { permitPublicCreations, consumePublicCreationFailure } = publicPermit;
if (provider) provider.connect();
const motionPublisher = provider ? createMotionPublisher(provider.awareness) : null;
ydoc.on('destroy', () => motionPublisher?.destroy());

const userPreferences = createUserPreferences({ ydoc, ymap, provider, activeRoomSession, route });
const { clientId, localStorageKeyFor, readUserPreference, writeUserPreference } = userPreferences;

const emitter = new EventTarget();
const keyOf = (scope, key, cid) => `${scope}|${cid}|${key}`;

// Declared up front so the various ymap/yItems observers below can safely
// reference it in their closures even though it's instantiated later.
let undoManager = null;

// `boardState` now flows through yItems/yMeta. We delete the legacy ymap key
// during migration; this guard ensures any rogue write to it (e.g. from a
// stale client tab still running the old code) doesn't trample the granular
// React state.
const snapshot = createSnapshotDoc({ ydoc, yItems, yMeta, publicPermit });
const {
  readBoardSnapshot, readRemoteBoardSnapshot, writeBoardSnapshot,
  readItemSnapshot, createItem, patchExistingItem, patchProtectedItems, concealForAdditions, newSnapshotItems,
} = snapshot;
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
const isLiveSticky = (itemId) => {
  if (!isSafeId(itemId)) return false;
  const item = yItems.get(itemId);
  return item instanceof Y.Map && item.get('type') === 'sticky';
};

// Keep the flat persisted key format for existing rooms, but index its hot
// read path in memory. A single vote/comment event now touches one sticky;
// import/delete can still mutate many keys in one Yjs transaction.
const indexedVotes = new Map();
const indexedComments = new Map();
const commentSnapshots = new Map();

const voteEmitter = new EventTarget();
ymap.observe((event) => {
  let dirty = false;
  const changed = new Map();
  event.keysChanged.forEach((key) => {
    const parsed = parseVoteKey(key);
    if (!parsed || !isSafeId(parsed.itemId) || !isSafeId(parsed.userId)) return;
    dirty = true;
    let voters = changed.get(parsed.itemId);
    if (!voters) {
      voters = new Set(indexedVotes.get(parsed.itemId) || []);
      changed.set(parsed.itemId, voters);
    }
    if (ymap.get(key)) voters.add(parsed.userId);
    else voters.delete(parsed.userId);
  });
  changed.forEach((voters, itemId) => {
    if (voters.size) indexedVotes.set(itemId, voters);
    else indexedVotes.delete(itemId);
  });
  if (dirty) voteEmitter.dispatchEvent(new Event('change'));
});

const commentEmitter = new EventTarget();
ymap.observe((event) => {
  let dirty = false;
  const changedIds = new Set();
  event.keysChanged.forEach((key) => {
    const parsed = parseCommentKey(key);
    if (!parsed || !isSafeId(parsed.itemId) || !isSafeId(parsed.commentId)) return;
    dirty = true;
    changedIds.add(parsed.itemId);
    let comments = indexedComments.get(parsed.itemId);
    if (!comments) { comments = new Map(); indexedComments.set(parsed.itemId, comments); }
    const normalized = normalizeComment(ymap.get(key), parsed.commentId);
    if (normalized) comments.set(parsed.commentId, normalized);
    else comments.delete(parsed.commentId);
    if (!comments.size) indexedComments.delete(parsed.itemId);
  });
  changedIds.forEach((itemId) => {
    const comments = indexedComments.get(itemId);
    if (!comments) { commentSnapshots.delete(itemId); return; }
    commentSnapshots.set(itemId, [...comments.values()].sort((a, b) => (
      (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id)
    )));
  });
  if (dirty) commentEmitter.dispatchEvent(new Event('change'));
});

// Cache the validated, bounded snapshot; notify for local, remote, system,
// and undo/redo changes alike. React always reads canonical Yjs state.
const templateEmitter = new EventTarget();
let templateSnapshot = readTemplates(ymap);
ymap.observe((event) => {
  if (![...event.keysChanged].some(isTemplateKey)) return;
  templateSnapshot = readTemplates(ymap);
  templateEmitter.dispatchEvent(new Event('change'));
});

// Mood answers are few (one per person per round), so a full re-read is cheap.
const moodEmitter = new EventTarget();
let moodSnapshot = readMoods(ymap);
ymap.observe((event) => {
  if (![...event.keysChanged].some(isMoodKey)) return;
  moodSnapshot = readMoods(ymap);
  moodEmitter.dispatchEvent(new Event('change'));
});

// Keys that should never enter the undo stack even when written with shared=true.
const NEVER_UNDO_KEYS = new Set(['presence']);

const presence = createAwarenessPresence({ provider, motionPublisher, emitter });
const { readPresenceMap, writeLegacyPresence } = presence;

if (provider) {
  window.storage = {
    async get(key, shared) {
      if (!shared && LOCAL_ONLY_KEYS.has(key)) {
        return { value: readLocalPreference(localStorageKeyFor(key)) };
      }
      if (key === 'boardState' && shared) {
        return { value: readRemoteBoardSnapshot() };
      }
      if (key === 'presence' && shared) {
        return { value: readPresenceMap() };
      }
      if (!shared) return readUserPreference(key);
      const ck = keyOf('s', key, '');
      const v = ymap.get(ck);
      return { value: v ?? null };
    },
    async set(key, value, shared, opts) {
      if (!shared && LOCAL_ONLY_KEYS.has(key)) {
        writeLocalPreference(localStorageKeyFor(key), value);
        return;
      }
      // `opts.silent` forces origin='system' so the write skips the undo stack.
      // Use it for automatic/derived changes the user didn't explicitly trigger
      // (e.g. timer-end auto-sort of cards by vote count).
      const silent = !!(opts && opts.silent);
      if (key === 'presence' && shared && value && typeof value === 'object') {
        writeLegacyPresence(value);
        return;
      }
      // User-scope: dual-write. localStorage is the fast local cache; the Yjs
      // per-client key is the durable, server-persisted copy. See get() above.
      if (!shared) {
        writeUserPreference(key, value);
        return;
      }
      const ck = keyOf('s', key, '');
      // Presence heartbeats fire every ~8s — keep them off the undo stack.
      // Everything else on shared scope IS undoable
      // unless `silent` is set.
      const origin = silent || NEVER_UNDO_KEYS.has(key) ? 'system' : 'local';
      ydoc.transact(() => { ymap.set(ck, value); }, origin);
    },
    on(handler) { emitter.addEventListener('change', handler); },
    off(handler) { emitter.removeEventListener('change', handler); },
    ...presence.methods,

    // Uploads an image blob to the server and resolves to its served URL.
    async uploadImage(blob, { signal } = {}) {
      // An encrypted room never sends image bytes in the clear: encrypt here, the one boundary every upload path shares.
      const key = getRoomKey();
      if (isEncryptedRoom(key, activeRoomSession.roomHandle)) return uploadEncryptedImage(blob, { signal, key });
      const res = await roomFetch('upload', {
        signal,
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': blob.type },
      });
      if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
      const payload = await res.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).length !== 1 || typeof payload.url !== 'string') {
        throw new Error('invalid image upload response');
      }
      const url = normalizeRuntimeImageSource(payload.url, {
        pageOrigin: window.location.origin,
        relayBaseUrl: getRelayHttpBaseUrl(),
        roomHandle: activeRoomSession.roomHandle,
      });
      if (!url) throw new Error('invalid image upload URL');
      return url;
    },

    // Image sources of the live board, and the one local transaction that image repair rewrites them in.
    listImageSources() { return listImageSources(yItems); },
    rewriteImageSources(replacements) {
      if (!isEncryptedRoom(getRoomKey(), activeRoomSession.roomHandle)) throw new RangeError('image rewrite is for locked rooms');
      return rewriteImageSources(ydoc, yItems, replacements, IMAGE_REPAIR_ORIGIN, activeRoomSession.roomHandle);
    },

    // --- Granular board writes (delta-only; see helpers above) ---
    canCreateItems(items) { return Array.isArray(items) && permitPublicCreations(items); },
    consumePublicCreationFailure,
    addItem(item, opts) {
      if (boardItemWriteError(item) || geometryErrorForItem(item) || yItems.has(item.id)) return false;
      if (!permitPublicCreations([item])) return false;
      const concealed = concealForAdditions([item]);
      ydoc.transact(() => { createItem(item.id, item); patchProtectedItems(concealed); }, originOf(opts));
      return true;
    },
    addItems(items, opts) {
      if (!Array.isArray(items) || !items.length) return false;
      if (boardItemsWriteError(items) || items.some((item) => yItems.has(item.id))) return false;
      if (!permitPublicCreations(items)) return false;
      const concealed = concealForAdditions(items);
      ydoc.transact(() => {
        items.forEach((item) => createItem(item.id, item));
        patchProtectedItems(concealed);
      }, originOf(opts));
      return true;
    },
    updateItem(id, patch, opts) {
      if (!id || !patch || typeof patch !== 'object') return false;
      const current = readItemSnapshot(yItems.get(id), id);
      if (!current
        || ('type' in patch && patch.type !== current.type)
        || geometryErrorForPatch(current, patch)) return false;
      ydoc.transact(() => { patchProtectedItems([{ id, patch }]); }, originOf(opts));
      return true;
    },
    updateItems(entries, opts) {
      if (!Array.isArray(entries) || !entries.length) return false;
      const valid = entries.every((entry) => {
        if (!entry?.id || !entry.patch || typeof entry.patch !== 'object') return false;
        const current = readItemSnapshot(yItems.get(entry.id), entry.id);
        if (!current || ('type' in entry.patch && entry.patch.type !== current.type)) return false;
        return geometryErrorForPatch(current, entry.patch) == null;
      });
      if (!valid) return false;
      ydoc.transact(() => {
        patchProtectedItems(entries);
      }, originOf(opts));
      return true;
    },
    removeItem(id, opts) {
      if (!id) return;
      ydoc.transact(() => { if (yItems.has(id)) yItems.delete(id); }, originOf(opts));
    },
    setMeta(patch, opts) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
      ydoc.transact(() => {
        Object.entries(patch).forEach(([k, v]) => {
          if (k.startsWith(META_INTERNAL_PREFIX)) return;
          if (v === undefined || v === null) yMeta.delete(k);
          else yMeta.set(k, v);
        });
      }, originOf(opts));
      return true;
    },
    // Full board replace — for import / clear only. Reuses the proven
    // delete-missing + per-field upsert diff.
    replaceBoard(board, opts) {
      return writeBoardSnapshot(board, originOf(opts));
    },

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

    setVote(itemId, voterId, on) {
      // Strict id format so a `:` in the key never confuses parseVoteKey on
      // the read-back path. Both ids come from `uid()` (alphanumeric) in
      // practice; this guard also rejects malicious values smuggled through
      // import flows.
      if (!isLiveSticky(itemId) || !isSafeId(voterId)) return;
      const k = VOTE_KEY(itemId, voterId);
      ydoc.transact(() => {
        if (on) ymap.set(k, 1);
        else ymap.delete(k);
      }, 'local');
    },
    // Delete an item and its related flat keys in a single transaction so
    // Cmd+Z restores the complete item state together.
    deleteItemWithVotesAndComments(itemId) {
      if (!isSafeId(itemId)) return;
      const votePrefix = `${VOTE_PREFIX}${itemId}:`;
      const commentPrefix = `${COMMENT_PREFIX}${itemId}:`;
      const relatedKeys = [];
      ymap.forEach((_v, k) => {
        if (k.startsWith(votePrefix) || k.startsWith(commentPrefix)) relatedKeys.push(k);
      });
      ydoc.transact(() => {
        relatedKeys.forEach((k) => ymap.delete(k));
        if (yItems.has(itemId)) yItems.delete(itemId);
      }, 'local');
    },
    getRoomHandle() { return getActiveRoomSession()?.roomHandle || ''; },
    snapshotVotes() {
      const out = new Map();
      indexedVotes.forEach((voters, itemId) => {
        if (isLiveSticky(itemId)) out.set(itemId, voters);
      });
      return out;
    },
    clearAllVotes() {
      const keys = [];
      ymap.forEach((_v, k) => { if (k.startsWith(VOTE_PREFIX)) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    clearVotesFor(itemId) {
      if (!isSafeId(itemId)) return;
      const prefix = `${VOTE_PREFIX}${itemId}:`;
      const keys = [];
      ymap.forEach((_v, k) => { if (k.startsWith(prefix)) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    clearVotesForItems(itemIds) {
      if (!itemIds || !itemIds.length) return;
      const prefixes = itemIds.filter(isSafeId).map((id) => `${VOTE_PREFIX}${id}:`);
      if (!prefixes.length) return;
      const keys = [];
      ymap.forEach((_v, k) => { if (prefixes.some((p) => k.startsWith(p))) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    addComment(itemId, comment) {
      if (!isLiveSticky(itemId) || !comment) return false;
      const value = normalizeComment(comment, comment.id, Date.now());
      if (!value) return false;
      const key = COMMENT_KEY(itemId, value.id);
      if (ymap.has(key)) return false;
      ydoc.transact(() => ymap.set(key, value), 'local');
      return true;
    },
    editComment(itemId, commentId, text) {
      if (!isLiveSticky(itemId) || !isSafeId(commentId)) return false;
      const key = COMMENT_KEY(itemId, commentId);
      const existing = ymap.get(key);
      if (!existing) return false;
      const nextText = typeof text === 'string' ? text.trim().slice(0, COMMENT_MAX_LEN) : '';
      if (!nextText) return false;
      const normalized = normalizeComment(existing, commentId, Date.now());
      if (!normalized) return false;
      ydoc.transact(() => {
        ymap.set(key, { ...normalized, text: nextText, editedAt: Date.now() });
      }, 'local');
      return true;
    },
    deleteComment(itemId, commentId) {
      if (!isSafeId(itemId) || !isSafeId(commentId)) return false;
      const key = COMMENT_KEY(itemId, commentId);
      if (!ymap.has(key)) return false;
      ydoc.transact(() => ymap.delete(key), 'local');
      return true;
    },
    snapshotComments() {
      const out = new Map();
      commentSnapshots.forEach((comments, itemId) => {
        if (isLiveSticky(itemId)) out.set(itemId, comments);
      });
      return out;
    },
    clearCommentsForItems(itemIds) {
      if (!itemIds || !itemIds.length) return;
      const prefixes = itemIds.filter(isSafeId).map((id) => `${COMMENT_PREFIX}${id}:`);
      if (!prefixes.length) return;
      const keys = [];
      ymap.forEach((_v, k) => { if (prefixes.some((p) => k.startsWith(p))) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    clearAllComments() {
      const keys = [];
      ymap.forEach((_v, k) => { if (k.startsWith(COMMENT_PREFIX)) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    finalizeVoteSession(zoneId, expectedStartedAt, participants, atTime) {
      let finalized = null;
      ydoc.transact(() => {
        const timer = yItems.get(zoneId)?.get('voteTimer');
        if (!timer || timer.startedAt !== expectedStartedAt) return;
        const { items, allRevealed } = readBoardSnapshot();
        const votes = readCanonicalVotes(ymap);
        const plan = planVoteFinalization(items, votes, zoneId, atTime, participants, allRevealed);
        if (!plan || plan.entries.some(({ id, patch }) => geometryErrorForPatch(
          readItemSnapshot(yItems.get(id), id), patch,
        ))) return;
        plan.entries.forEach(({ id, patch }) => patchExistingItem(id, patch));
        finalized = plan;
      }, 'system');
      return finalized;
    },
    startVoteSession(rootZoneId, timerPatch, staleResultZoneIds, clearedItemIds) {
      const root = yItems.get(rootZoneId);
      if (!(root instanceof Y.Map) || root.get('type') !== 'zone'
          || root.get('voteTimer') || !timerPatch?.voteTimer
          || !Array.isArray(staleResultZoneIds) || !Array.isArray(clearedItemIds)) return false;
      ydoc.transact(() => {
        patchExistingItem(rootZoneId, { ...timerPatch, ...CLEARED_VOTE_RESULTS });
        staleResultZoneIds.forEach((id) => patchExistingItem(id, CLEARED_VOTE_RESULTS));
        if (clearedItemIds.length) {
          const prefixes = clearedItemIds.map((id) => `${VOTE_PREFIX}${id}:`);
          const keys = [];
          ymap.forEach((_v, k) => {
            if (prefixes.some((prefix) => k.startsWith(prefix))) keys.push(k);
          });
          keys.forEach((k) => ymap.delete(k));
        }
      }, 'local');
      return true;
    },
    onVotesChange(handler) { voteEmitter.addEventListener('change', handler); },
    offVotesChange(handler) { voteEmitter.removeEventListener('change', handler); },
    snapshotMoods() { return moodSnapshot; },
    // The person's own answer is a local (undoable) write.
    setMood(roundId, userId, score) {
      if (!isSafeId(roundId) || !isSafeId(userId) || !isMoodScore(score)) return false;
      ydoc.transact(() => { ymap.set(moodKey(roundId, userId), score); }, 'local');
      return true;
    },
    // Starting a new round drops the previous one's answers; not undoable.
    clearAllMoods() {
      const keys = moodKeys(ymap);
      if (keys.length) ydoc.transact(() => { keys.forEach((key) => ymap.delete(key)); }, 'system');
    },
    onMoodsChange(handler) { moodEmitter.addEventListener('change', handler); },
    offMoodsChange(handler) { moodEmitter.removeEventListener('change', handler); },
    onCommentsChange(handler) { commentEmitter.addEventListener('change', handler); },
    offCommentsChange(handler) { commentEmitter.removeEventListener('change', handler); },
    snapshotTemplates() { return templateSnapshot; },
    putTemplate(template) { return putTemplate(ydoc, ymap, template); },
    removeTemplate(id) { return removeTemplate(ydoc, ymap, id); },
    onTemplatesChange(handler) { templateEmitter.addEventListener('change', handler); },
    offTemplatesChange(handler) { templateEmitter.removeEventListener('change', handler); },

    // True once the WebSocket has finished its initial state exchange with
    // the server. RetroBoard gates admin election on this so a returning
    // client doesn't claim the role during cold start before learning who
    // the real current admin is — split-brain prevention.
    synced() { return !!(provider && provider.synced); },
    getSyncStatus: syncStatus.getSnapshot,
    onSyncStatus: syncStatus.subscribe,
    // Read the live admin userId straight from yMeta, bypassing the React
    // render queue. boardRef.current updates only after applyRemoteBoard
    // runs AND React re-renders — there's a tick of lag in between, and a
    // heartbeat firing inside that gap could see the stale DEFAULT_BOARD
    // null and try to re-claim admin even though the room already has one.
    getAdminUserId() { return yMeta.get('adminUserId') || null; },
    // Fire when the initial WebSocket exchange completes (idempotent — if
    // sync already happened, the callback fires immediately on next tick).
    onSynced(handler) {
      if (!provider) return () => {};
      if (provider.synced) {
        const t = setTimeout(handler, 0);
        return () => clearTimeout(t);
      }
      const wrapped = (isSynced) => { if (isSynced) handler(); };
      provider.on('sync', wrapped);
      return () => provider.off('sync', wrapped);
    },
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
