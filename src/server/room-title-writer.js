import { isBoardTitle } from '../domain/board-title.js';
import { unloadUnattachedDoc } from './plain-upgrade.js';

/** Transaction origin of a relay rename. Clients track only their own 'local' origin for undo. */
export const RELAY_TITLE_ORIGIN = 'relay-title';
export const TITLE_WRITE_STATUS = Object.freeze({ OK: 200, NOT_FOUND: 404, UNAVAILABLE: 503 });
/** Storage reads of non-resident rooms in flight at once, across every list request. */
export const MAX_CONCURRENT_TITLE_READS = 4;
/** A renamed idle room waits for other fence holders without limit; this only re-arms the fence wait. */
export const TITLE_UNLOAD_RECHECK_MS = 60_000;
const META_MAP = 'meta';
const TITLE_KEY = 'title';

const titleOf = (doc) => {
  const title = doc.getMap(META_MAP).get(TITLE_KEY);
  return isBoardTitle(title) ? title : null;
};

/** Runs at most `limit` tasks at once; the rest wait in arrival order. */
function boundedRunner(limit) {
  let active = 0;
  const waiting = [];
  const acquire = () => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => { waiting.push(resolve); });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Title of a room for a list: read live from a resident doc, otherwise from storage into a throwaway doc that is never
 * registered. Null when it has none (a room cleared mid-list reads as empty); a storage failure rejects.
 * Ports: docs, roomReady (doc → hydration promise), readStoredDoc(docName) → Y.Doc built from persistence.
 */
export function createRoomTitleReader({ docs, roomReady, readStoredDoc, limit = MAX_CONCURRENT_TITLE_READS }) {
  const run = boundedRunner(limit);
  const readStored = (docName) => run(async () => {
    const stored = await readStoredDoc(docName);
    try {
      return titleOf(stored);
    } finally {
      stored.destroy();
    }
  });
  return async (docName) => {
    const resident = docs.get(docName);
    if (!resident) return readStored(docName);
    await roomReady.get(resident);
    return titleOf(resident);
  };
}

/**
 * Renames a room on its one live document, through the same getYDoc + roomReady path an upgrade uses, so a rename can
 * never race a first connection onto a second copy. Ports: docs, getYDoc, roomReady, fence (RoomFence), refusal(doc,
 * docName) → an Error when the relay will not serve the room, or null; admitsColdRoom() → the relay's active-room
 * admission an upgrade of a cold room uses; storeWriteOf(doc) → the promise (true once stored, false on failure) of
 * the last store write the doc's update queued.
 */
export function createRoomTitleWriter({ docs, getYDoc, roomReady, fence, refusal, admitsColdRoom, storeWriteOf }) {
  // A doc loaded only for the rename is unloaded once nobody else holds the room: an upgrade that took the same doc
  // while it hydrated holds a fence entry until its socket is attached, and then owns the doc's lifecycle.
  // A long holder (a slow upload) only delays the unload: it runs when the last holder releases.
  const unloadWhenIdle = async (docName, doc) => {
    while (fence.held(docName) && docs.get(docName) === doc) await fence.drained(docName, TITLE_UNLOAD_RECHECK_MS);
    unloadUnattachedDoc({ docs, roomReady }, docName, doc);
  };

  const apply = async (docName, doc, title) => {
    if (fence.isFenced(docName) || docs.get(docName) !== doc) return TITLE_WRITE_STATUS.NOT_FOUND;
    if (refusal(doc, docName)) return TITLE_WRITE_STATUS.UNAVAILABLE;
    const before = storeWriteOf(doc);
    doc.transact(() => doc.getMap(META_MAP).set(TITLE_KEY, title), RELAY_TITLE_ORIGIN);
    const write = storeWriteOf(doc);
    // No new store write: the relay refused the update (blocked room, backlog, quota).
    if (write === before || !(await write)) return TITLE_WRITE_STATUS.UNAVAILABLE;
    return fence.isFenced(docName) ? TITLE_WRITE_STATUS.NOT_FOUND : TITLE_WRITE_STATUS.OK;
  };

  return {
    /** Resolves a TITLE_WRITE_STATUS once the update is stored (not fsynced, like every Yjs edit) or refused. */
    async write(docName, title) {
      if (!isBoardTitle(title)) throw new TypeError('invalid board title');
      // Same admission as an upgrade, in the same tick as getYDoc: a rename never loads a room past the cap.
      if (!docs.has(docName) && !admitsColdRoom()) return TITLE_WRITE_STATUS.UNAVAILABLE;
      const leave = fence.enter(docName);
      if (!leave) return TITLE_WRITE_STATUS.NOT_FOUND;
      const doc = getYDoc(docName, true);
      try {
        await roomReady.get(doc);
        return await apply(docName, doc, title);
      } finally {
        leave();
        void unloadWhenIdle(docName, doc);
      }
    },
  };
}
