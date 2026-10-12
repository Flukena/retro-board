// window.storage polyfill backed by Yjs over WebSocket.
//
// Two storage layers live on the same Y.Doc:
//
//   1. ymap  ('kv')    — flat Y.Map for client-scoped keys (userId, viewport,
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
import { WebsocketProvider } from 'y-websocket';
import { createMotionPublisher, sendOnlyLocalAwareness } from './awareness-transport.js';
import { parseRoute } from './router.js';
import {
  getActiveRoomSession,
  getRoomWebSocketBaseUrl,
  roomFetch,
} from './room-session.js';
import { COMMENT_MAX_LEN, isSafeId, normalizeComment } from './comment-schema.js';
import {
  readPlayerPresence,
  normalizePlayerCursor,
  normalizePlayerView,
} from './player-cursors.js';
import {
  collaborativeTextToString,
  isCollaborativeTextField,
  setCollaborativeTextField,
} from './collaborative-text.js';
import { normalizeRuntimeImageSource } from './security-boundaries.js';
import { repairStoredBoardGeometry } from './stored-geometry-repair.js';
import {
  isTemplateKey,
  migrateLegacyTemplates,
  normalizeTemplateEntries,
  putTemplate,
  readTemplates,
  removeTemplate,
  replaceTemplates,
} from './template-store.js';
import {
  geometryErrorForBoard,
  geometryErrorForItem,
  geometryErrorForPatch,
} from './board-geometry.js';

const route = parseRoute();
if (route.kind !== 'board') {
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
const activeRoomSession = route.kind === 'board' ? getActiveRoomSession() : null;
if (route.kind === 'board' && !activeRoomSession) {
  throw new Error('room session has not been established');
}
const ROOM = activeRoomSession?.roomHandle || `landing-${route.code || 'unused'}`;

// Some per-device prefs (display name) are scoped per-board so identity
// doesn't leak across rooms — moving from board A (where you're admin "Alice")
// to board B starts you as a fresh participant who picks a name for B. Other
// per-device prefs (userId) stay global so the
// browser still recognises itself across rooms.
// `viewport` is per-board because pan/zoom coordinates are meaningless across
// boards — landing on a brand-new board at the far corner of board A's last
// view is jarring (often looks like an empty page).
const PER_BOARD_LOCAL_KEYS = new Set(['userName', 'viewport']);
const localStorageKeyFor = (key) => {
  if (PER_BOARD_LOCAL_KEYS.has(key) && route.code) {
    // Scope with the non-secret server handle. Older builds embedded the
    // bearer token in localStorage key names, which needlessly exposed it to
    // diagnostics and storage snapshots.
    const scope = activeRoomSession?.roomHandle || route.code;
    return `rb_local_${key}__${scope}`;
  }
  return `rb_local_${key}`;
};

// In production (https) the relay is reverse-proxied at /yjs (cloudflared
// rule). For local http access the port comes from VITE_YJS_PORT so docker
// compose can host the relay on a non-default port without colliding with a
// host-side `npm run yjs` someone may have running.
const YJS_LOCAL_PORT = import.meta.env.VITE_YJS_PORT || '1234';
const WS_URL = getRoomWebSocketBaseUrl();

// Same origin-resolution rule as WS_URL above, for the image upload/serve
// HTTP routes that live on the same yjs-server process (reachable at /yjs/*
// in prod via the cloudflared tunnel rule, at the bare path in dev).
const resolveServerUrl = (path) => (window.location.protocol === 'https:'
  ? `${window.location.origin}/yjs${path}`
  : `http://${window.location.hostname}:${YJS_LOCAL_PORT}${path}`);
const ydoc = new Y.Doc();
const ymap = ydoc.getMap('kv');
const yItems = ydoc.getMap('items');
const yMeta = ydoc.getMap('meta');

let provider = null;
if (route.kind === 'board') {
  provider = new WebsocketProvider(WS_URL, ROOM, ydoc, {
    connect: false,
    // Bind the relay connection to this one Yjs awareness identity. The ID is
    // not a credential; it lets the server distinguish our own state from
    // y-websocket's legitimate BroadcastChannel/snapshot echoes.
    params: { awarenessId: String(ydoc.clientID) },
  });
  sendOnlyLocalAwareness(provider);
  provider.connect();
}
const motionPublisher = provider ? createMotionPublisher(provider.awareness) : null;
ydoc.on('destroy', () => motionPublisher?.destroy());

const CLIENT_ID_KEY = 'rb_clientId';
let clientId;
try {
  clientId = localStorage.getItem(CLIENT_ID_KEY) || '';
  if (!clientId) {
    clientId = Math.random().toString(36).slice(2, 14) + Date.now().toString(36).slice(-4);
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }
} catch {
  clientId = Math.random().toString(36).slice(2, 14);
}

const emitter = new EventTarget();
const keyOf = (scope, key, cid) => `${scope}|${cid}|${key}`;

// Declared up front so the various ymap/yItems observers below can safely
// reference it in their closures even though it's instantiated later.
let undoManager = null;

// `boardState` now flows through yItems/yMeta. We delete the legacy ymap key
// during migration; this guard ensures any rogue write to it (e.g. from a
// stale client tab still running the old code) doesn't trample the granular
// React state.
const LEGACY_BOARD_KEY = 's||boardState';
const BOARD_ITEM_TYPES = new Set(['sticky', 'zone', 'text', 'image']);

const boardItemWriteError = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'item must be an object';
  if (!isSafeId(item.id)) return 'item has an invalid id';
  if (!BOARD_ITEM_TYPES.has(item.type)) return `item ${item.id} has an invalid type`;
  return null;
};

const boardItemsWriteError = (items) => {
  if (!Array.isArray(items)) return 'board items must be an array';
  const ids = new Set();
  for (const item of items) {
    const error = boardItemWriteError(item);
    if (error) return error;
    if (ids.has(item.id)) return `duplicate item id: ${item.id}`;
    ids.add(item.id);
  }
  return geometryErrorForBoard(items);
};

// ---------------------------------------------------------------------------
// Board snapshot helpers — convert between the React-friendly flat shape and
// the nested Y.Map representation.
// ---------------------------------------------------------------------------
const META_INTERNAL_PREFIX = '__';

const valuesEqual = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  // JSON-equality is sufficient for board fields (primitives + small arrays).
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

const setItemField = (yItem, field, value) => {
  if (value === undefined) {
    yItem.delete(field);
    return;
  }
  if (isCollaborativeTextField(field) && typeof value === 'string') {
    setCollaborativeTextField(yItem, field, value);
    return;
  }
  yItem.set(field, value);
};

const readItemSnapshot = (yItem, id) => {
  if (!(yItem instanceof Y.Map)) return null;
  const item = Object.assign(Object.create(null), { id });
  yItem.forEach((value, key) => { item[key] = collaborativeTextToString(value); });
  return item;
};

const readBoardSnapshot = () => {
  const items = [];
  // Y.Map iterates in insertion order, which matches the order items were
  // added across the doc's history — deterministic on all peers.
  yItems.forEach((yItem, id) => {
    const item = readItemSnapshot(yItem, id);
    if (item) items.push(item);
  });
  const meta = Object.create(null);
  yMeta.forEach((val, key) => {
    if (key.startsWith(META_INTERNAL_PREFIX)) return;
    meta[key] = val;
  });
  return { items, ...meta };
};

const writeBoardSnapshot = (newBoard, origin = 'local') => {
  if (!newBoard || typeof newBoard !== 'object' || !Array.isArray(newBoard.items)) return false;
  if (boardItemsWriteError(newBoard.items)) return false;
  const cur = readBoardSnapshot();
  const curById = new Map();
  cur.items.forEach((it) => curById.set(it.id, it));
  const newById = new Map();
  (newBoard.items || []).forEach((it) => {
    if (it && it.id) newById.set(it.id, it);
  });

  ydoc.transact(() => {
    // Deletions
    curById.forEach((_oldItem, id) => {
      if (!newById.has(id)) yItems.delete(id);
    });
    // Upserts + per-field diffs
    newById.forEach((nItem, id) => {
      const oItem = curById.get(id);
      let yItem = yItems.get(id);
      if (!(yItem instanceof Y.Map)) {
        // Brand-new item — seed a fresh Y.Map with all fields.
        yItem = new Y.Map();
        Object.entries(nItem).forEach(([k, v]) => {
          if (k === 'id' || v === undefined) return;
          setItemField(yItem, k, v);
        });
        yItems.set(id, yItem);
        return;
      }
      const allFields = new Set([
        ...Object.keys(oItem || {}),
        ...Object.keys(nItem),
      ]);
      allFields.forEach((field) => {
        if (field === 'id') return;
        const ov = oItem ? oItem[field] : undefined;
        const nv = nItem[field];
        if (valuesEqual(ov, nv)) return;
        setItemField(yItem, field, nv);
      });
    });
    // Board-level meta diff (everything except `items`)
    const allMetaKeys = new Set([
      ...Object.keys(cur).filter((k) => k !== 'items'),
      ...Object.keys(newBoard).filter((k) => k !== 'items'),
    ]);
    allMetaKeys.forEach((key) => {
      if (key.startsWith(META_INTERNAL_PREFIX)) return;
      const ov = cur[key];
      const nv = newBoard[key];
      if (valuesEqual(ov, nv)) return;
      if (nv === undefined || nv === null) yMeta.delete(key);
      else yMeta.set(key, nv);
    });
  }, origin);
  return true;
};

// ---------------------------------------------------------------------------
// Granular board writes. The UI sends only the delta it changed instead of the
// whole board, so a single text edit or a per-frame drag no longer pays the
// O(items × fields) cost of reading + diffing the entire board. Each runs in
// one transaction; `origin` decides undo-stack membership, exactly as
// writeBoardSnapshot did — 'local' = user action (undoable), 'system' = derived
// / automatic change (skipped by the UndoManager).
// ---------------------------------------------------------------------------
const originOf = (opts) => (opts && opts.silent ? 'system' : 'local');

// Seed a brand-new item as its own Y.Map (mirrors writeBoardSnapshot's
// create branch). Populated before attaching so peers see it complete.
const seedItem = (id, fields) => {
  const yItem = new Y.Map();
  Object.entries(fields).forEach(([k, v]) => {
    if (k === 'id' || v === undefined) return;
    setItemField(yItem, k, v);
  });
  yItems.set(id, yItem);
};

const createItem = (id, fields) => {
  if (yItems.has(id) || geometryErrorForItem({ ...fields, id })) return false;
  seedItem(id, fields);
  return true;
};

const patchExistingItem = (id, patch) => {
  const yItem = yItems.get(id);
  if (!(yItem instanceof Y.Map)) return false;
  const current = readItemSnapshot(yItem, id);
  if (!current || geometryErrorForPatch(current, patch)) return false;
  Object.entries(patch).forEach(([k, v]) => {
    if (k === 'id') return;
    setItemField(yItem, k, v);
  });
  return true;
};

// ---------------------------------------------------------------------------
// One-time migration of the legacy `s||boardState` JSON blob into yItems/yMeta.
// Idempotent — guarded by a `__migrated` flag in yMeta. Runs as origin 'system'
// so the migration itself never appears on the undo stack.
// ---------------------------------------------------------------------------
let migrationDone = false;
const tryMigrate = () => {
  if (migrationDone) return;
  if (yMeta.get('__migrated')) { migrationDone = true; return; }
  const legacy = ymap.get(LEGACY_BOARD_KEY);
  if (!legacy || typeof legacy !== 'object') {
    ydoc.transact(() => { yMeta.set('__migrated', true); }, 'system');
    migrationDone = true;
    return;
  }
  if (yItems.size > 0) {
    // Another tab already migrated — just mark.
    ydoc.transact(() => { yMeta.set('__migrated', true); }, 'system');
    migrationDone = true;
    return;
  }
  ydoc.transact(() => {
    (legacy.items || []).forEach((it) => {
      if (!it || !it.id) return;
      seedItem(it.id, it);
    });
    Object.entries(legacy).forEach(([k, v]) => {
      if (k === 'items' || v === undefined || v === null) return;
      yMeta.set(k, v);
    });
    yMeta.set('__migrated', true);
    // Drop the legacy blob so it can't drift out of sync with yItems.
    ymap.delete(LEGACY_BOARD_KEY);
  }, 'system');
  migrationDone = true;
};

// Existing boards stored editable fields as scalar strings. Upgrade them
// after every sync (a no-op once upgraded) so both old boards and items added
// by a stale client gain character-level CRDT merging without a manual reset.
const ensureCollaborativeTextFields = () => {
  ydoc.transact(() => {
    yItems.forEach((yItem) => {
      if (!(yItem instanceof Y.Map)) return;
      const type = yItem.get('type');
      const fields = type === 'zone' ? ['title'] : (type === 'sticky' || type === 'text' ? ['text'] : []);
      fields.forEach((field) => {
        const value = yItem.get(field);
        if (typeof value === 'string') setItemField(yItem, field, value);
      });
    });
  }, 'system');
};

if (provider) {
  provider.on('sync', (isSynced) => {
    if (isSynced) {
      tryMigrate();
      repairStoredBoardGeometry(ydoc, yItems);
      ensureCollaborativeTextFields();
      migrateLegacyTemplates(ydoc, ymap);
    }
  });
  if (provider.synced) {
    tryMigrate();
    repairStoredBoardGeometry(ydoc, yItems);
    ensureCollaborativeTextFields();
    migrateLegacyTemplates(ydoc, ymap);
  }
}

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
const fireBoardChange = (origin) => {
  const isUndoRedo = undoManager && origin === undoManager;
  // 'local' = our own write that's already reflected in React state.
  // 'system' = migration seed; we DO want React to pick it up.
  // remote (provider as origin) and undoRedo: dispatch.
  if (origin === 'local' && !isUndoRedo) return;
  emitter.dispatchEvent(new CustomEvent('change', {
    detail: { scope: 's', key: 'boardState', value: readBoardSnapshot(), isUndoRedo },
  }));
};

yItems.observeDeep((events) => {
  if (!events.length) return;
  fireBoardChange(events[0].transaction.origin);
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
const VOTE_KEY = (itemId, userId) => keyOf('s', `vote:${itemId}:${userId}`, '');
const VOTE_PREFIX = 's||vote:';
const COMMENT_KEY = (itemId, commentId) => keyOf('s', `comment:${itemId}:${commentId}`, '');
const COMMENT_PREFIX = 's||comment:';

const isLiveSticky = (itemId) => {
  if (!isSafeId(itemId)) return false;
  const item = yItems.get(itemId);
  return item instanceof Y.Map && item.get('type') === 'sticky';
};

const parseVoteKey = (mapKey) => {
  if (!mapKey.startsWith(VOTE_PREFIX)) return null;
  const rest = mapKey.slice(VOTE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  return { itemId: rest.slice(0, sep), userId: rest.slice(sep + 1) };
};

const parseCommentKey = (mapKey) => {
  if (!mapKey.startsWith(COMMENT_PREFIX)) return null;
  const rest = mapKey.slice(COMMENT_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  return { itemId: rest.slice(0, sep), commentId: rest.slice(sep + 1) };
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

// Keys that should never enter the undo stack even when written with shared=true.
const NEVER_UNDO_KEYS = new Set(['presence']);

// ---------------------------------------------------------------------------
// Presence — via Yjs awareness.
//
// The old design stored the entire {userId -> {name, lastSeen}} map under a
// single shared Y.Map key. Every client read-modify-wrote the whole blob on
// each heartbeat tick, so concurrent heartbeats LWW-trampled each other and
// users disappeared from peers' lists ("same link, looks like different
// rooms"). Awareness gives each connection its own slot — writes are
// conflict-free, and slots auto-clear when the WebSocket drops.
// ---------------------------------------------------------------------------
const presenceEmitter = new EventTarget();
const busyEmitter = new EventTarget();
const editingEmitter = new EventTarget();
const selectionEmitter = new EventTarget();
const AWARENESS_MAX_ITEM_IDS = 256;
const AWARENESS_MAX_ITEM_ID_LENGTH = 128;
const localBusySources = {
  text: new Set(),
  geometry: new Set(),
};
const normalizeBusyIds = (ids) => Array.from(new Set(
  (Array.isArray(ids) || ids instanceof Set ? Array.from(ids) : [])
    .filter((id) => typeof id === 'string'
      && id.length > 0
      && id.length <= AWARENESS_MAX_ITEM_ID_LENGTH),
)).sort().slice(0, AWARENESS_MAX_ITEM_IDS);
const setLocalBusyItems = (source, ids) => {
  if (!provider || (source !== 'text' && source !== 'geometry')) return;
  const normalized = normalizeBusyIds(ids);
  localBusySources[source] = new Set(source === 'text' ? normalized.slice(0, 1) : normalized);
  const busyItems = normalizeBusyIds([
    ...localBusySources.text,
    ...localBusySources.geometry,
  ]);
  const editingItemId = Array.from(localBusySources.text)[0] || null;
  const localState = provider.awareness.getLocalState() || {};
  const current = normalizeBusyIds(localState.busyItems);
  const busyUnchanged = current.length === busyItems.length
    && current.every((id, i) => id === busyItems[i]);
  if (busyUnchanged && (localState.editingItemId || null) === editingItemId) return;
  provider.awareness.setLocalState({
    ...localState,
    busyItems: busyItems.length ? busyItems : null,
    editingItemId,
  });
};
const readRemoteBusyOwners = () => {
  const out = new Map();
  if (!provider) return out;
  provider.awareness.getStates().forEach((state, awarenessClientId) => {
    if (awarenessClientId === provider.awareness.clientID) return;
    normalizeBusyIds(state?.busyItems).forEach((itemId) => {
      let owners = out.get(itemId);
      if (!owners) { owners = new Map(); out.set(itemId, owners); }
      owners.set(awarenessClientId, state?.user || null);
    });
  });
  return out;
};
const remoteBusySignature = (busy) => Array.from(busy.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([itemId, owners]) => `${itemId}:${Array.from(owners.keys()).sort((a, b) => a - b).join(',')}`)
  .join('|');
let lastRemoteBusySignature = '';
const readRemoteEditingOwners = () => {
  const out = new Map();
  if (!provider) return out;
  provider.awareness.getStates().forEach((state, awarenessClientId) => {
    if (awarenessClientId === provider.awareness.clientID) return;
    const itemId = typeof state?.editingItemId === 'string' ? state.editingItemId : '';
    if (!itemId) return;
    let owners = out.get(itemId);
    if (!owners) { owners = new Map(); out.set(itemId, owners); }
    owners.set(awarenessClientId, state?.user || null);
  });
  return out;
};
const remoteEditingSignature = (editing) => Array.from(editing.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([itemId, owners]) => `${itemId}:${Array.from(owners.entries())
    .sort(([a], [b]) => a - b)
    .map(([clientId, user]) => `${clientId}:${user?.userId || ''}:${user?.name || ''}`)
    .join(',')}`)
  .join('|');
let lastRemoteEditingSignature = '';
const readRemoteSelectionOwners = () => {
  const out = new Map();
  if (!provider) return out;
  provider.awareness.getStates().forEach((state, awarenessClientId) => {
    if (awarenessClientId === provider.awareness.clientID) return;
    normalizeBusyIds(state?.selectedItems).forEach((itemId) => {
      let owners = out.get(itemId);
      if (!owners) { owners = new Map(); out.set(itemId, owners); }
      owners.set(awarenessClientId, state?.user || null);
    });
  });
  return out;
};
const remoteSelectionSignature = (selection) => Array.from(selection.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([itemId, owners]) => `${itemId}:${Array.from(owners.entries())
    .sort(([a], [b]) => a - b)
    .map(([clientId, user]) => `${clientId}:${user?.userId || ''}:${user?.name || ''}`)
    .join(',')}`)
  .join('|');
let lastRemoteSelectionSignature = '';
const readPresenceMap = () => readPlayerPresence(
  provider?.awareness.getStates() || new Map(),
);

if (provider) {
  provider.awareness.on('change', () => {
    const busy = readRemoteBusyOwners();
    const signature = remoteBusySignature(busy);
    if (signature !== lastRemoteBusySignature) {
      lastRemoteBusySignature = signature;
      busyEmitter.dispatchEvent(new CustomEvent('change', { detail: busy }));
    }
    const editing = readRemoteEditingOwners();
    const editingSignature = remoteEditingSignature(editing);
    if (editingSignature !== lastRemoteEditingSignature) {
      lastRemoteEditingSignature = editingSignature;
      editingEmitter.dispatchEvent(new CustomEvent('change', { detail: editing }));
    }
    const selection = readRemoteSelectionOwners();
    const selectionSignature = remoteSelectionSignature(selection);
    if (selectionSignature !== lastRemoteSelectionSignature) {
      lastRemoteSelectionSignature = selectionSignature;
      selectionEmitter.dispatchEvent(new CustomEvent('change', { detail: selection }));
    }
    const presence = readPresenceMap();
    presenceEmitter.dispatchEvent(new CustomEvent('change', { detail: presence }));
    // Fan into the main change emitter so existing storage.on('change')
    // handlers (RetroBoard's applyRemoteBoard router) keep receiving
    // presence updates the same way they used to.
    emitter.dispatchEvent(new CustomEvent('change', {
      detail: { scope: 's', key: 'presence', value: presence },
    }));
  });
}

// Bounded wait for the initial WebSocket sync, used by get()'s recovery path
// when a per-device value is missing from localStorage. One shared, lazily
// created promise so the three sequential cold-start reads (userId, userName,
// viewport) pay the timeout at most once between them, not once each. Resolves
// on the first 'sync' event or after the timeout, and always removes its own
// listener on settle — deliberately NOT built on the public onSynced() below,
// which never self-unregisters and would leak a listener per cold-start read.
const RECOVERY_SYNC_TIMEOUT_MS = 3000;
let syncWaitPromise = null;
const waitForSyncBounded = () => {
  if (!provider || provider.synced) return Promise.resolve();
  if (!syncWaitPromise) {
    syncWaitPromise = new Promise((resolve) => {
      let settled = false;
      let onSync = null;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (onSync) provider.off('sync', onSync);
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, RECOVERY_SYNC_TIMEOUT_MS);
      onSync = (isSynced) => { if (isSynced) finish(); };
      provider.on('sync', onSync);
    });
  }
  return syncWaitPromise;
};

if (provider) {
  window.storage = {
    async get(key, shared) {
      if (key === 'boardState' && shared) {
        return { value: readBoardSnapshot() };
      }
      if (key === 'presence' && shared) {
        return { value: readPresenceMap() };
      }
      // User-scope keys (userName, viewport, userId) are per-device preferences.
      // localStorage is a fast local cache in front of a durable per-client copy
      // in Yjs (key `u|<clientId>|<key>`), which is synced + persisted server-
      // side. localStorage stays the hot path; Yjs is the recovery path when the
      // cache is missing/cleared (as long as clientId itself survives).
      if (!shared) {
        const lk = localStorageKeyFor(key);
        const uKey = keyOf('u', key, clientId);
        try {
          const raw = localStorage.getItem(lk);
          if (raw !== null) {
            const cached = JSON.parse(raw);
            // Write-through: seed this board's durable copy if it has none yet.
            // Needed because userId's localStorage key is global (shared across
            // boards), so entering a second board hits the cache and never calls
            // set() — its Yjs copy would otherwise never exist on that board.
            // Also retro-seeds users whose value predates durable storage.
            // origin 'system' keeps it off the undo stack; it's a local echo, so
            // ymap.observe's own-write guard suppresses any change event.
            if (ymap.get(uKey) == null) {
              try { ydoc.transact(() => { ymap.set(uKey, cached); }, 'system'); }
              catch { /* transact refused — cache is still returned below */ }
            }
            return { value: cached };
          }
        } catch { /* corrupted entry — ignore */ }
        // Cache miss — the durable copy may still be in flight over the socket.
        // Wait (bounded) for the initial sync before reading Yjs so a returning
        // client with a cleared cache can recover. Bounded so a dead relay can't
        // hang the init effect's first await (which gates the loading screen).
        await waitForSyncBounded();
        const v = ymap.get(uKey);
        if (v != null) {
          try { localStorage.setItem(lk, JSON.stringify(v)); }
          catch { /* quota / private mode — non-fatal */ }
          return { value: v };
        }
        return { value: null };
      }
      const ck = keyOf('s', key, '');
      const v = ymap.get(ck);
      return { value: v ?? null };
    },
    async set(key, value, shared, opts) {
      // `opts.silent` forces origin='system' so the write skips the undo stack.
      // Use it for automatic/derived changes the user didn't explicitly trigger
      // (e.g. timer-end auto-sort of cards by vote count).
      const silent = !!(opts && opts.silent);
      if (key === 'presence' && shared && value && typeof value === 'object') {
        // Backward-compat shim: callers still pass the FULL pmap. The only
        // entry we actually own is the one with the freshest lastSeen — that's
        // the one this client just refreshed in its heartbeat. Lift it into
        // our awareness slot so peers see it without LWW-trampling.
        if (provider) {
          let mine = null;
          Object.values(value).forEach((p) => {
            if (!p || typeof p !== 'object') return;
            if (!mine || (p.lastSeen || 0) > (mine.lastSeen || 0)) mine = p;
          });
          if (mine) provider.awareness.setLocalStateField('user', mine);
        }
        return;
      }
      // User-scope: dual-write. localStorage is the fast local cache; the Yjs
      // per-client key is the durable, server-persisted copy. See get() above.
      if (!shared) {
        // Best-effort cache — instant reads next load.
        try {
          localStorage.setItem(localStorageKeyFor(key), JSON.stringify(value));
        } catch { /* quota / private-mode / disabled — durable copy below covers it */ }
        // Durable copy — written on every set, not only on cache failure, so
        // per-device prefs survive a cleared/broken localStorage. 'system' keeps
        // it off the undo stack; transact is synchronous, nothing to await.
        try {
          ydoc.transact(() => { ymap.set(keyOf('u', key, clientId), value); }, 'system');
        } catch { /* Yjs refused — cache above is the fallback */ }
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
    getPresenceSnapshot() { return readPresenceMap(); },
    onPresenceChange(handler) {
      presenceEmitter.addEventListener('change', handler);
      return () => presenceEmitter.removeEventListener('change', handler);
    },
    offPresenceChange(handler) { presenceEmitter.removeEventListener('change', handler); },
    setLocalBusyItems,
    findRemoteBusyItem(ids) {
      const busy = readRemoteBusyOwners();
      for (const itemId of normalizeBusyIds(ids)) {
        const owners = busy.get(itemId);
        if (!owners) continue;
        const [clientID, user] = owners.entries().next().value;
        return { itemId, clientID, user };
      }
      return null;
    },
    getRemoteBusyItems() { return readRemoteBusyOwners(); },
    onBusyChange(handler) {
      busyEmitter.addEventListener('change', handler);
      return () => busyEmitter.removeEventListener('change', handler);
    },
    offBusyChange(handler) { busyEmitter.removeEventListener('change', handler); },
    getRemoteEditingItems() { return readRemoteEditingOwners(); },
    onEditingChange(handler) {
      editingEmitter.addEventListener('change', handler);
      return () => editingEmitter.removeEventListener('change', handler);
    },
    offEditingChange(handler) { editingEmitter.removeEventListener('change', handler); },
    setLocalSelectedItems(ids) {
      if (!provider) return;
      const selectedItems = normalizeBusyIds(ids);
      const localState = provider.awareness.getLocalState() || {};
      const current = normalizeBusyIds(localState.selectedItems);
      const unchanged = current.length === selectedItems.length
        && current.every((id, index) => id === selectedItems[index]);
      if (unchanged) return;
      provider.awareness.setLocalStateField(
        'selectedItems',
        selectedItems.length ? selectedItems : null,
      );
    },
    getRemoteSelectedItems() { return readRemoteSelectionOwners(); },
    onSelectionChange(handler) {
      selectionEmitter.addEventListener('change', handler);
      return () => selectionEmitter.removeEventListener('change', handler);
    },
    offSelectionChange(handler) { selectionEmitter.removeEventListener('change', handler); },
    setLocalCursor(cursor) {
      if (!motionPublisher) return;
      if (cursor == null) { motionPublisher.set('cursor', null); return; }
      const normalized = normalizePlayerCursor({ ...cursor, updatedAt: Date.now() });
      if (normalized) motionPublisher.set('cursor', normalized);
    },
    setLocalView(view) {
      if (!motionPublisher) return;
      if (view == null) { motionPublisher.set('view', null); return; }
      const normalized = normalizePlayerView({ ...view, updatedAt: Date.now() });
      if (normalized) motionPublisher.set('view', normalized);
    },

    // Uploads an image blob to the server and resolves to its served URL.
    async uploadImage(blob) {
      const res = await roomFetch('upload', {
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
        relayBaseUrl: resolveServerUrl('/'),
        roomHandle: activeRoomSession.roomHandle,
      });
      if (!url) throw new Error('invalid image upload URL');
      return url;
    },

    // --- Granular board writes (delta-only; see helpers above) ---
    addItem(item, opts) {
      if (boardItemWriteError(item) || geometryErrorForItem(item) || yItems.has(item.id)) return false;
      ydoc.transact(() => { createItem(item.id, item); }, originOf(opts));
      return true;
    },
    addItems(items, opts) {
      if (!Array.isArray(items) || !items.length) return false;
      if (boardItemsWriteError(items) || items.some((item) => yItems.has(item.id))) return false;
      ydoc.transact(() => {
        items.forEach((item) => {
          createItem(item.id, item);
        });
      }, originOf(opts));
      return true;
    },
    updateItem(id, patch, opts) {
      if (!id || !patch || typeof patch !== 'object') return false;
      const current = readItemSnapshot(yItems.get(id), id);
      if (!current
        || ('type' in patch && patch.type !== current.type)
        || geometryErrorForPatch(current, patch)) return false;
      ydoc.transact(() => { patchExistingItem(id, patch); }, originOf(opts));
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
        entries.forEach((e) => {
          patchExistingItem(e.id, e.patch);
        });
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
    importBundle(board, voteEntries, commentEntries, customTemplates) {
      if (!board || typeof board !== 'object' || !Array.isArray(board.items)) return false;
      if (!Array.isArray(voteEntries) || !Array.isArray(commentEntries)) return false;
      const normalizedTemplates = normalizeTemplateEntries(customTemplates);
      if (customTemplates != null && !normalizedTemplates) return false;
      if (boardItemsWriteError(board.items)) return false;

      const itemTypes = new Map();
      for (const item of board.items) {
        if (!item || typeof item !== 'object' || !isSafeId(item.id) || itemTypes.has(item.id)) return false;
        if (!['sticky', 'zone', 'text', 'image'].includes(item.type)) return false;
        itemTypes.set(item.id, item.type);
      }

      const normalizedVotes = [];
      const seenVotes = new Set();
      for (const entry of voteEntries) {
        if (!entry || itemTypes.get(entry.itemId) !== 'sticky' || !isSafeId(entry.userId)) return false;
        const key = VOTE_KEY(entry.itemId, entry.userId);
        if (seenVotes.has(key)) return false;
        seenVotes.add(key);
        normalizedVotes.push(key);
      }

      const normalizedComments = [];
      const seenComments = new Set();
      for (const entry of commentEntries) {
        if (!entry || itemTypes.get(entry.itemId) !== 'sticky') return false;
        const comment = normalizeComment(entry.comment, entry.comment?.id);
        if (!comment) return false;
        const key = COMMENT_KEY(entry.itemId, comment.id);
        if (seenComments.has(key)) return false;
        seenComments.add(key);
        normalizedComments.push({ key, comment });
      }

      const relatedKeys = [];
      ymap.forEach((_value, key) => {
        if (key.startsWith(VOTE_PREFIX) || key.startsWith(COMMENT_PREFIX)) relatedKeys.push(key);
      });
      ydoc.transact(() => {
        // writeBoardSnapshot's nested transaction joins this active outer
        // transaction in Yjs, so peers and UndoManager observe one command.
        writeBoardSnapshot(board, 'local');
        relatedKeys.forEach((key) => ymap.delete(key));
        normalizedVotes.forEach((key) => ymap.set(key, 1));
        normalizedComments.forEach(({ key, comment }) => ymap.set(key, comment));
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
    startVoteSession(rootZoneId, timerPatch, staleResultZoneIds, clearedItemIds) {
      const root = yItems.get(rootZoneId);
      if (!(root instanceof Y.Map) || root.get('type') !== 'zone'
          || root.get('voteTimer') || !timerPatch?.voteTimer
          || !Array.isArray(staleResultZoneIds) || !Array.isArray(clearedItemIds)) return false;
      ydoc.transact(() => {
        patchExistingItem(rootZoneId, timerPatch);
        staleResultZoneIds.forEach((id) => patchExistingItem(id, { lastResultsAt: null }));
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
const undoEmitter = new EventTarget();
if (provider) {
  undoManager = new Y.UndoManager([yItems, yMeta, ymap], {
    trackedOrigins: new Set(['local']),
    captureTimeout: 500,
  });
  const fire = () => undoEmitter.dispatchEvent(new Event('change'));
  undoManager.on('stack-item-added', fire);
  undoManager.on('stack-item-popped', fire);
  undoManager.on('stack-cleared', fire);

  Object.assign(window.storage, {
    undo() {
      if (!undoManager || undoManager.undoStack.length === 0) return false;
      undoManager.undo();
      return true;
    },
    redo() {
      if (!undoManager || undoManager.redoStack.length === 0) return false;
      undoManager.redo();
      return true;
    },
    canUndo() { return !!(undoManager && undoManager.undoStack.length > 0); },
    canRedo() { return !!(undoManager && undoManager.redoStack.length > 0); },
    onUndoChange(handler) { undoEmitter.addEventListener('change', handler); },
    offUndoChange(handler) { undoEmitter.removeEventListener('change', handler); },
  });
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
