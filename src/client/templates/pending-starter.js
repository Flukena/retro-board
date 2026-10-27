import { useEffect } from 'react';
import { starterTemplate } from './starter-formats.js';

// A template page creates the room, remembers here which format to lay out,
// then opens the board. The board lays it out once, on the creator's browser,
// only if the room is still empty.

const PENDING_STARTERS_KEY = 'rb_pending_starters';
const PENDING_STARTERS_MAX = 20;

const readPending = (storage) => {
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_STARTERS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
};

const writePending = (storage, pending) => {
  try { storage.setItem(PENDING_STARTERS_KEY, JSON.stringify(pending)); } catch { /* storage unavailable */ }
};

export function savePendingStarter(code, slug, storage = globalThis.localStorage) {
  if (!storage || !starterTemplate(slug)) return;
  const kept = Object.entries(readPending(storage)).slice(1 - PENDING_STARTERS_MAX);
  writePending(storage, { ...Object.fromEntries(kept), [code]: slug });
}

/** Read and forget the pending format for a room, so it is laid out at most once. */
export function takePendingStarter(code, storage = globalThis.localStorage) {
  if (!storage) return null;
  const pending = readPending(storage);
  if (!Object.hasOwn(pending, code)) return null;
  const { [code]: slug, ...rest } = pending;
  writePending(storage, rest);
  return typeof slug === 'string' ? slug : null;
}

/** Lay out the room's pending format if the synced room is still empty. */
export async function seedPendingStarter({ storage, code, applyTemplate, localStore = globalThis.localStorage }) {
  const slug = takePendingStarter(code, localStore);
  const template = slug && starterTemplate(slug);
  if (!template) return false;
  const record = await storage.get('boardState', true);
  if ((record?.value?.items?.length ?? 0) > 0) return false;
  applyTemplate(template);
  return true;
}

/**
 * Run `seed` once, after the board has mounted (`ready`) and the room has synced.
 * Seeding earlier finds no canvas to place the layout on. Returns a cleanup.
 */
export function whenReadyAndSynced({ ready, liveStorage, seed }) {
  if (!ready) return () => {};
  let pending = true;
  const seedOnce = () => {
    if (!pending) return;
    pending = false;
    seed();
  };
  if (liveStorage.synced()) seedOnce();
  const offSynced = liveStorage.onSynced(seedOnce) || (() => {});
  return () => { pending = false; offSynced(); };
}

export function usePendingStarter({ storage, liveStorage, boardCode, applyTemplate, ready }) {
  useEffect(() => whenReadyAndSynced({
    ready, liveStorage, seed: () => seedPendingStarter({ storage, code: boardCode, applyTemplate }),
  }), [storage, liveStorage, boardCode, applyTemplate, ready]);
}
