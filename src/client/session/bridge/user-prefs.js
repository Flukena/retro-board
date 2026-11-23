import { userKey } from './kv-keys.js';

const CLIENT_ID_RADIX = 36;
const CLIENT_ID_RANDOM_START = 2;
const CLIENT_ID_RANDOM_END = 14;
const CLIENT_ID_TIME_SUFFIX_LENGTH = 4;

const randomClientId = () => Math.random().toString(CLIENT_ID_RADIX).slice(CLIENT_ID_RANDOM_START, CLIENT_ID_RANDOM_END);

export function createUserPreferences({ ydoc, ymap, provider, activeRoomSession, route }) {
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
    if (PER_BOARD_LOCAL_KEYS.has(key) && activeRoomSession) {
      // Scope with the non-secret server handle. Older builds embedded the
      // bearer token in localStorage key names, which needlessly exposed it to
      // diagnostics and storage snapshots.
      const scope = activeRoomSession?.roomHandle || route.code;
      return `rb_local_${key}__${scope}`;
    }
    return `rb_local_${key}`;
  };

  const CLIENT_ID_KEY = 'rb_clientId';
  let clientId;
  try {
    clientId = localStorage.getItem(CLIENT_ID_KEY) || '';
    if (!clientId) {
      clientId = randomClientId() + Date.now().toString(CLIENT_ID_RADIX).slice(-CLIENT_ID_TIME_SUFFIX_LENGTH);
      localStorage.setItem(CLIENT_ID_KEY, clientId);
    }
  } catch {
    clientId = randomClientId();
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

  // Recover durable identity preferences; viewport bypasses this shared path.
  const readUserPreference = async (key) => {
    const lk = localStorageKeyFor(key);
    const uKey = userKey(clientId, key);
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
  };

  const writeUserPreference = (key, value) => {
    // Best-effort cache — instant reads next load.
    try {
      localStorage.setItem(localStorageKeyFor(key), JSON.stringify(value));
    } catch { /* quota / private-mode / disabled — durable copy below covers it */ }
    // Durable copy — written on every set, not only on cache failure, so
    // per-device prefs survive a cleared/broken localStorage. 'system' keeps
    // it off the undo stack; transact is synchronous, nothing to await.
    try {
      ydoc.transact(() => { ymap.set(userKey(clientId, key), value); }, 'system');
    } catch { /* Yjs refused — cache above is the fallback */ }
  };
  return { clientId, localStorageKeyFor, readUserPreference, writeUserPreference };
}
