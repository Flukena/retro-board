import { DEFAULT_BOARD } from '../../domain/board-state.js';

const SHARED_MEMORY_PREFIX = 's';
const USER_MEMORY_PREFIX = 'u';
const MEMORY_KEY_SEPARATOR = '::';
const MEMORY_BOARD_KEY = 's::boardState';
const memoryKey = (key, shared) => (
  `${shared ? SHARED_MEMORY_PREFIX : USER_MEMORY_PREFIX}${MEMORY_KEY_SEPARATOR}${key}`
);

// Thin wrapper over window.storage with an in-memory fallback for dev/preview.
const memoryStore = new Map();
export const storage = {
  async get(key, shared) {
    try {
      if (typeof window !== 'undefined' && window.storage?.get) {
        const r = await window.storage.get(key, shared);
        return r ?? null;
      }
    } catch { /* fall through to memory */ }
    const k = memoryKey(key, shared);
    return memoryStore.has(k) ? { value: memoryStore.get(k) } : null;
  },
  async set(key, value, shared) {
    try {
      if (typeof window !== 'undefined' && window.storage?.set) {
        await window.storage.set(key, value, shared);
        return;
      }
    } catch { /* fall through */ }
    const k = memoryKey(key, shared);
    memoryStore.set(k, value);
  },
  on(handler) {
    if (typeof window !== 'undefined' && typeof window.storage?.on === 'function') {
      window.storage.on(handler);
    }
  },
  off(handler) {
    if (typeof window !== 'undefined' && typeof window.storage?.off === 'function') {
      window.storage.off(handler);
    }
  },
  getPresenceSnapshot() {
    try { return window.storage?.getPresenceSnapshot?.() || {}; } catch { return {}; }
  },
  onPresenceChange(handler) {
    try { return window.storage?.onPresenceChange?.(handler) || (() => {}); } catch { return () => {}; }
  },
  offPresenceChange(handler) {
    try { window.storage?.offPresenceChange?.(handler); } catch { /* noop fallback */ }
  },
  setLocalBusyItems(source, ids) {
    try { window.storage?.setLocalBusyItems?.(source, ids); } catch { /* noop fallback */ }
  },
  findRemoteBusyItem(ids) {
    try { return window.storage?.findRemoteBusyItem?.(ids) || null; } catch { return null; }
  },
  getRemoteBusyItems() {
    try { return window.storage?.getRemoteBusyItems?.() || new Map(); } catch { return new Map(); }
  },
  onBusyChange(handler) {
    try { return window.storage?.onBusyChange?.(handler) || (() => {}); } catch { return () => {}; }
  },
  offBusyChange(handler) {
    try { window.storage?.offBusyChange?.(handler); } catch { /* noop fallback */ }
  },
  getRemoteEditingItems() {
    try { return window.storage?.getRemoteEditingItems?.() || new Map(); } catch { return new Map(); }
  },
  onEditingChange(handler) {
    try { return window.storage?.onEditingChange?.(handler) || (() => {}); } catch { return () => {}; }
  },
  offEditingChange(handler) {
    try { window.storage?.offEditingChange?.(handler); } catch { /* noop fallback */ }
  },
  setLocalSelectedItems(ids) {
    try { window.storage?.setLocalSelectedItems?.(ids); } catch { /* noop fallback */ }
  },
  getRemoteSelectedItems() {
    try { return window.storage?.getRemoteSelectedItems?.() || new Map(); } catch { return new Map(); }
  },
  onSelectionChange(handler) {
    try { return window.storage?.onSelectionChange?.(handler) || (() => {}); } catch { return () => {}; }
  },
  offSelectionChange(handler) {
    try { window.storage?.offSelectionChange?.(handler); } catch { /* noop fallback */ }
  },
  // --- Granular board writes ---
  // Pass through to the Yjs bridge when present; otherwise mutate the in-memory
  // board so dev/preview (no relay) stays consistent. Each maps to one Yjs
  // transaction in the bridge; `opts.silent` keeps derived writes off undo.
  addItem(item, opts) {
    if (window.storage?.addItem) {
      try { return window.storage.addItem(item, opts) === true; } catch { return false; }
    }
    const b = memBoard(); memSetBoard({ ...b, items: [...b.items, item] });
    return true;
  },
  addItems(items, opts) {
    if (window.storage?.addItems) {
      try { return window.storage.addItems(items, opts) === true; } catch { return false; }
    }
    const b = memBoard();
    const ids = new Set(b.items.map((it) => it.id));
    const additions = [];
    items.forEach((it) => {
      if (!it || !it.id || ids.has(it.id)) return;
      ids.add(it.id);
      additions.push(it);
    });
    if (additions.length !== items.length) return false;
    memSetBoard({ ...b, items: [...b.items, ...additions] });
    return true;
  },
  updateItem(id, patch, opts) {
    if (window.storage?.updateItem) {
      try { return window.storage.updateItem(id, patch, opts) === true; } catch { return false; }
    }
    const b = memBoard();
    if (!b.items.some((it) => it.id === id)) return false;
    memSetBoard({ ...b, items: b.items.map((it) => (it.id === id ? memMerge(it, patch) : it)) });
    return true;
  },
  updateItems(entries, opts) {
    if (window.storage?.updateItems) {
      try { return window.storage.updateItems(entries, opts) === true; } catch { return false; }
    }
    const byId = new Map(entries.map((e) => [e.id, e.patch]));
    const b = memBoard();
    if (entries.some((entry) => !b.items.some((it) => it.id === entry.id))) return false;
    memSetBoard({ ...b, items: b.items.map((it) => (byId.has(it.id) ? memMerge(it, byId.get(it.id)) : it)) });
    return true;
  },
  removeItem(id, opts) {
    if (window.storage?.removeItem) { window.storage.removeItem(id, opts); return; }
    const b = memBoard(); memSetBoard({ ...b, items: b.items.filter((it) => it.id !== id) });
  },
  setMeta(patch, opts) {
    if (window.storage?.setMeta) {
      try { return window.storage.setMeta(patch, opts) === true; } catch { return false; }
    }
    memSetBoard(memMerge(memBoard(), patch));
    return true;
  },
  replaceBoard(board, opts) {
    if (window.storage?.replaceBoard) {
      try { return window.storage.replaceBoard(board, opts) === true; } catch { return false; }
    }
    memSetBoard(board);
    return true;
  },
};

// In-memory board helpers for the dev/preview fallback (no Yjs relay).
const memBoard = () => {
  const k = MEMORY_BOARD_KEY;
  if (!memoryStore.has(k)) memoryStore.set(k, { ...DEFAULT_BOARD, items: [] });
  return memoryStore.get(k);
};
const memSetBoard = (next) => memoryStore.set(MEMORY_BOARD_KEY, next);
// Merge a patch, treating an undefined value as "delete this key".
const memMerge = (obj, patch) => {
  const out = { ...obj };
  Object.entries(patch).forEach(([k, v]) => {
    if (v === undefined) delete out[k];
    else out[k] = v;
  });
  return out;
};


// Resolve the bridge at each call: it is installed after room bootstrap.
export const adminRoleStorage = Object.freeze({
  getAdminUserId: () => window.storage?.getAdminUserId?.(),
  synced: () => window.storage?.synced?.(),
  onSynced: (handler) => window.storage?.onSynced?.(handler),
});
