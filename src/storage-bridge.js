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
import { parseRoute } from './router.js';

const route = parseRoute();
if (route.kind !== 'board') {
  window.storage = {
    async get() { return null; },
    async set() { /* noop */ },
    on() { /* noop */ },
    off() { /* noop */ },
  };
}

// Fold the URL-fragment token into the room name so the yjs doc is reachable
// only by clients who already know the full share URL. Legacy /b/CODE links
// (no token) keep the original room name for backward compat.
const ROOM = route.token
  ? `board-${route.code}-${route.token}`
  : `board-${route.code || 'unused'}`;

// Some per-device prefs (display name) are scoped per-board so identity
// doesn't leak across rooms — moving from board A (where you're admin "Alice")
// to board B starts you as a fresh participant who picks a name for B. Other
// per-device prefs (userId, viewport, customTemplates) stay global so the
// browser still recognises itself across rooms.
// `viewport` is per-board because pan/zoom coordinates are meaningless across
// boards — landing on a brand-new board at the far corner of board A's last
// view is jarring (often looks like an empty page).
const PER_BOARD_LOCAL_KEYS = new Set(['userName', 'viewport']);
const localStorageKeyFor = (key) => {
  if (PER_BOARD_LOCAL_KEYS.has(key) && route.code) {
    const scope = route.token ? `${route.code}-${route.token}` : route.code;
    return `rb_local_${key}__${scope}`;
  }
  return `rb_local_${key}`;
};

// In production (https) the relay is reverse-proxied at /yjs (cloudflared
// rule). For local http access the port comes from VITE_YJS_PORT so docker
// compose can host the relay on a non-default port without colliding with a
// host-side `npm run yjs` someone may have running.
const YJS_LOCAL_PORT = import.meta.env.VITE_YJS_PORT || '1234';
const WS_URL = window.location.protocol === 'https:'
  ? `wss://${window.location.host}/yjs`
  : `ws://${window.location.hostname}:${YJS_LOCAL_PORT}`;

const ydoc = new Y.Doc();
const ymap = ydoc.getMap('kv');
const yItems = ydoc.getMap('items');
const yMeta = ydoc.getMap('meta');

let provider = null;
if (route.kind === 'board') {
  provider = new WebsocketProvider(WS_URL, ROOM, ydoc, { connect: true });
}

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

const readBoardSnapshot = () => {
  const items = [];
  // Y.Map iterates in insertion order, which matches the order items were
  // added across the doc's history — deterministic on all peers.
  yItems.forEach((yItem, id) => {
    if (!(yItem instanceof Y.Map)) return;
    const obj = { id };
    yItem.forEach((val, key) => { obj[key] = val; });
    items.push(obj);
  });
  const meta = {};
  yMeta.forEach((val, key) => {
    if (key.startsWith(META_INTERNAL_PREFIX)) return;
    meta[key] = val;
  });
  return { items, ...meta };
};

const writeBoardSnapshot = (newBoard, origin = 'local') => {
  if (!newBoard || typeof newBoard !== 'object') return;
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
          yItem.set(k, v);
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
        if (nv === undefined) yItem.delete(field);
        else yItem.set(field, nv);
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
    yItem.set(k, v);
  });
  yItems.set(id, yItem);
};

// Upsert one item: create it if absent, else apply a per-field patch where
// `undefined` deletes the field and any other value sets it.
const upsertItem = (id, patch) => {
  const yItem = yItems.get(id);
  if (!(yItem instanceof Y.Map)) { seedItem(id, patch); return; }
  Object.entries(patch).forEach(([k, v]) => {
    if (k === 'id') return;
    if (v === undefined) yItem.delete(k);
    else yItem.set(k, v);
  });
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
      const yItem = new Y.Map();
      Object.entries(it).forEach(([k, v]) => {
        if (k === 'id' || v === undefined) return;
        yItem.set(k, v);
      });
      yItems.set(it.id, yItem);
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

if (provider) {
  provider.on('sync', (isSynced) => {
    if (isSynced) tryMigrate();
  });
  if (provider.synced) tryMigrate();
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
    detail: { scope: 's', key: 'boardState', value: readBoardSnapshot() },
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
// Vote keys — unchanged from the previous design. Each vote lives at its own
// key in `ymap`, so toggling never trample-overwrites another user's vote.
// ---------------------------------------------------------------------------
const VOTE_KEY = (itemId, userId) => keyOf('s', `vote:${itemId}:${userId}`, '');
const VOTE_PREFIX = 's||vote:';
// Item / user IDs are generated via `uid()` (lowercase alphanumeric) — anything
// outside this character set should be rejected before being baked into a vote
// key, otherwise `parseVoteKey`'s indexOf(':') split goes wrong.
const ID_SAFE_RE = /^[A-Za-z0-9_-]+$/;

const parseVoteKey = (mapKey) => {
  if (!mapKey.startsWith(VOTE_PREFIX)) return null;
  const rest = mapKey.slice(VOTE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  return { itemId: rest.slice(0, sep), userId: rest.slice(sep + 1) };
};

const voteEmitter = new EventTarget();
ymap.observe((event) => {
  let dirty = false;
  event.keysChanged.forEach((k) => { if (k.startsWith(VOTE_PREFIX)) dirty = true; });
  if (dirty) voteEmitter.dispatchEvent(new Event('change'));
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
const readPresenceMap = () => {
  if (!provider) return {};
  const out = {};
  provider.awareness.getStates().forEach((state) => {
    if (!state || !state.user || !state.user.userId) return;
    // Same person in two tabs → two awareness slots, same logical userId.
    // Collapse to the freshest entry so the UI shows them once.
    const prev = out[state.user.userId];
    if (!prev || (state.user.lastSeen || 0) > (prev.lastSeen || 0)) {
      out[state.user.userId] = state.user;
    }
  });
  return out;
};
if (provider) {
  provider.awareness.on('change', () => {
    presenceEmitter.dispatchEvent(new Event('change'));
    // Fan into the main change emitter so existing storage.on('change')
    // handlers (RetroBoard's applyRemoteBoard router) keep receiving
    // presence updates the same way they used to.
    emitter.dispatchEvent(new CustomEvent('change', {
      detail: { scope: 's', key: 'presence', value: readPresenceMap() },
    }));
  });
}

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
      // We back them with localStorage so they survive page refresh even before
      // the Yjs WebSocket has resynced — and they're not lost if the y-websocket
      // server's in-memory state gets recycled. Yjs is consulted only as a
      // legacy fallback to migrate data written before this change.
      if (!shared) {
        const lk = localStorageKeyFor(key);
        try {
          const raw = localStorage.getItem(lk);
          if (raw !== null) return { value: JSON.parse(raw) };
        } catch { /* corrupted entry — ignore */ }
        const v = ymap.get(keyOf('u', key, clientId));
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
      // User-scope: persist to localStorage only. No Yjs traffic, no sync, no
      // undo-stack pollution. See the matching comment in `get` above.
      if (!shared) {
        try {
          localStorage.setItem(localStorageKeyFor(key), JSON.stringify(value));
        } catch {
          // Quota / private-mode / disabled — fall back to a per-client slot in
          // ymap so the value still survives reload via Yjs persistence. Marked
          // 'system' so it never enters the undo stack.
          try {
            ydoc.transact(() => { ymap.set(keyOf('u', key, clientId), value); }, 'system');
          } catch { /* both layers refused — give up */ }
        }
        return;
      }
      const ck = keyOf('s', key, '');
      // Presence heartbeats fire every ~8s — keep them off the undo stack.
      // Everything else on shared scope (customTemplates, etc.) IS undoable
      // unless `silent` is set.
      const origin = silent || NEVER_UNDO_KEYS.has(key) ? 'system' : 'local';
      ydoc.transact(() => { ymap.set(ck, value); }, origin);
    },
    on(handler) { emitter.addEventListener('change', handler); },
    off(handler) { emitter.removeEventListener('change', handler); },

    // --- Granular board writes (delta-only; see helpers above) ---
    addItem(item, opts) {
      if (!item || !item.id) return;
      ydoc.transact(() => { seedItem(item.id, item); }, originOf(opts));
    },
    updateItem(id, patch, opts) {
      if (!id || !patch || typeof patch !== 'object') return;
      ydoc.transact(() => { upsertItem(id, patch); }, originOf(opts));
    },
    updateItems(entries, opts) {
      if (!Array.isArray(entries) || !entries.length) return;
      ydoc.transact(() => {
        entries.forEach((e) => {
          if (e && e.id && e.patch) upsertItem(e.id, e.patch);
        });
      }, originOf(opts));
    },
    removeItem(id, opts) {
      if (!id) return;
      ydoc.transact(() => { if (yItems.has(id)) yItems.delete(id); }, originOf(opts));
    },
    setMeta(patch, opts) {
      if (!patch || typeof patch !== 'object') return;
      ydoc.transact(() => {
        Object.entries(patch).forEach(([k, v]) => {
          if (k.startsWith(META_INTERNAL_PREFIX)) return;
          if (v === undefined || v === null) yMeta.delete(k);
          else yMeta.set(k, v);
        });
      }, originOf(opts));
    },
    // Full board replace — for import / clear only. Reuses the proven
    // delete-missing + per-field upsert diff.
    replaceBoard(board, opts) {
      writeBoardSnapshot(board, originOf(opts));
    },

    setVote(itemId, voterId, on) {
      // Strict id format so a `:` in the key never confuses parseVoteKey on
      // the read-back path. Both ids come from `uid()` (alphanumeric) in
      // practice; this guard also rejects malicious values smuggled through
      // import flows.
      if (!ID_SAFE_RE.test(itemId) || !ID_SAFE_RE.test(voterId)) return;
      const k = VOTE_KEY(itemId, voterId);
      ydoc.transact(() => {
        if (on) ymap.set(k, 1);
        else ymap.delete(k);
      }, 'local');
    },
    // Delete an item AND clear all votes on it in a single Yjs transaction so
    // a single Cmd+Z restores both. Previously these were two separate
    // transactions that often missed the 500ms UndoManager merge window.
    deleteItemWithVotes(itemId) {
      if (!ID_SAFE_RE.test(itemId)) return;
      const prefix = `${VOTE_PREFIX}${itemId}:`;
      const voteKeys = [];
      ymap.forEach((_v, k) => { if (k.startsWith(prefix)) voteKeys.push(k); });
      ydoc.transact(() => {
        voteKeys.forEach((k) => ymap.delete(k));
        if (yItems.has(itemId)) yItems.delete(itemId);
      }, 'local');
    },
    snapshotVotes() {
      const out = new Map();
      ymap.forEach((val, key) => {
        if (!val) return;
        const p = parseVoteKey(key);
        if (!p) return;
        let s = out.get(p.itemId);
        if (!s) { s = new Set(); out.set(p.itemId, s); }
        s.add(p.userId);
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
      const prefix = `${VOTE_PREFIX}${itemId}:`;
      const keys = [];
      ymap.forEach((_v, k) => { if (k.startsWith(prefix)) keys.push(k); });
      if (!keys.length) return;
      ydoc.transact(() => { keys.forEach((k) => ymap.delete(k)); }, 'local');
    },
    onVotesChange(handler) { voteEmitter.addEventListener('change', handler); },
    offVotesChange(handler) { voteEmitter.removeEventListener('change', handler); },

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
// Tracks operations on yItems, yMeta, and ymap (vote keys + customTemplates).
// `trackedOrigins: ['local']` means:
//   - Local board edits, vote toggles, customTemplate saves → tracked.
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

// Token-redacted room label for any place we log the room name. The token
// is the only auth gate to the doc, so we never want it landing in console
// output that can be captured by screen-recordings, browser extensions, or
// remote-debug bridges.
const ROOM_LABEL = route.token ? `board-${route.code}-<token>` : ROOM;

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
    awareness: Array.from((provider?.awareness?.getStates?.() || new Map()).entries()),
    yItemsCount: yItems.size,
  });
}
