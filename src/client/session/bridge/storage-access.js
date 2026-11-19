import { LOCAL_ONLY_KEYS, readLocalPreference, writeLocalPreference } from '../local-preferences.js';

const NEVER_UNDO_KEYS = new Set(['presence']);
const keyOf = (scope, key, cid) => `${scope}|${cid}|${key}`;

export function createStorageAccess({ ydoc, ymap, userPreferences, presence, snapshot, emitter }) {
  const { localStorageKeyFor, readUserPreference, writeUserPreference } = userPreferences;
  const { readRemoteBoardSnapshot } = snapshot;
  const { readPresenceMap, writeLegacyPresence } = presence;
  return {
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
  };
}
