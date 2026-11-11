import * as Y from 'yjs';
import { e2eAad } from '../../domain/room-lock-contract.js';
import { classifyImportedImageSource } from '../../domain/security-boundaries.js';
import { listImageSources, rewriteImageSources } from '../session/item-image-sources.js';
import { RoomKeyError, createNextRoomKey, deriveRoomSecrets, encryptFrame } from './e2e-crypto.js';
import { isPermanentlyBrokenImage, readE2EImage, uploadEncryptedImage } from './e2e-images.js';
import { LOCK_ACTION_ERROR, RoomLockActionError, isRelayAnswer, lockActionErrorForStatus } from './room-lock-api.js';

/** How long the drain and the catch-up to the frozen head may take before the rotation gives up. */
export const ROTATION_WAIT_TIMEOUT_MS = 60_000;
/** Deadline of one image read or staged upload, body included. */
export const ROTATION_IMAGE_TIMEOUT_MS = 30_000;
const ROTATION_POLL_INTERVAL_MS = 100;
const ROTATION_ORIGIN = 'key-rotation';
const ITEMS_MAP = 'items';
const SNAPSHOT_KIND = 'snapshot';
const PAGE_HIDE_EVENT = 'pagehide';

export const ROTATION_FAILURE = Object.freeze({
  DRAIN_TIMEOUT: 'drain-timeout',
  CATCH_UP_TIMEOUT: 'catch-up-timeout',
  INCOMPLETE: 'incomplete',
  CANCELLED: 'cancelled',
  STORAGE_FULL: 'storage-full',
  BOARD_CHANGED: 'board-changed',
  LOCK_CHANGED: 'lock-changed',
  WRONG_PASSWORD: 'wrong',
  LOCKED_OUT: 'locked-out',
  UNAVAILABLE: 'unavailable',
  /** The commit was sent but no answer came back and the freeze could not be released: it may have committed. */
  UNKNOWN_OUTCOME: 'unknown-outcome',
});

export class RotationError extends Error {
  constructor(kind, { retryAfterSeconds = null } = {}) {
    super(`key rotation failed: ${kind}`);
    this.name = 'RotationError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const SYSTEM_CLOCK = Object.freeze({
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
});
const DEFAULT_IMAGES = Object.freeze({ read: readE2EImage, upload: uploadEncryptedImage });

/** Calls `handler` when the page is being hidden for good (navigation, tab close); returns the unsubscribe. */
const onPageHide = (handler) => {
  globalThis.window?.addEventListener?.(PAGE_HIDE_EVENT, handler);
  return () => globalThis.window?.removeEventListener?.(PAGE_HIDE_EVENT, handler);
};

// A 409 before the freeze means the lock moved on (revision or another rotation); after it, the board did.
const PASS_THROUGH = new Map([
  [LOCK_ACTION_ERROR.WRONG_PASSWORD, ROTATION_FAILURE.WRONG_PASSWORD],
  [LOCK_ACTION_ERROR.LOCKED_OUT, ROTATION_FAILURE.LOCKED_OUT],
  [LOCK_ACTION_ERROR.STORAGE_FULL, ROTATION_FAILURE.STORAGE_FULL],
]);

function rotationErrorFor(error, conflictKind, signal) {
  if (signal.aborted) return new RotationError(ROTATION_FAILURE.CANCELLED);
  if (error instanceof RotationError) return error;
  if (error instanceof RoomKeyError && error.code === 'wrong-password') return new RotationError(ROTATION_FAILURE.WRONG_PASSWORD);
  if (!(error instanceof RoomLockActionError)) return new RotationError(ROTATION_FAILURE.UNAVAILABLE);
  if (error.kind === LOCK_ACTION_ERROR.CONFLICT) return new RotationError(conflictKind);
  return new RotationError(PASS_THROUGH.get(error.kind) ?? ROTATION_FAILURE.UNAVAILABLE, { retryAfterSeconds: error.retryAfterSeconds });
}

const throwIfCancelled = (signal) => {
  if (signal.aborted) throw new RotationError(ROTATION_FAILURE.CANCELLED);
};

async function waitUntil(predicate, { clock, timeoutMs, signal }, failure) {
  const deadline = clock.now() + timeoutMs;
  while (!predicate()) {
    throwIfCancelled(signal);
    if (clock.now() >= deadline) throw new RotationError(failure);
    await clock.sleep(ROTATION_POLL_INTERVAL_MS);
  }
}

/** A page that skipped an entry it decrypted but could not apply would drop it from the new snapshot: never commit. */
const assertCompleteCoverage = (source) => {
  if (source.skippedSeq !== null) throw new RotationError(ROTATION_FAILURE.INCOMPLETE);
};

/** Read through the frozen head with every entry and snapshot applied (and nothing skipped). */
const hasReadFrozenHead = (source, head) => {
  assertCompleteCoverage(source);
  return source.appliedSeq >= head && source.synced;
};

/** The proof of the current password and the brand-new key; both before anything is frozen. */
async function prepareKeys({ currentPassword, newPassword, key }) {
  if (newPassword === currentPassword) throw new RangeError('new password must differ from the current password');
  const { authKey: oldAuthKey } = await deriveRoomSecrets(currentPassword, key.lock.salt, key.lock.kdf);
  const next = await createNextRoomKey(newPassword);
  return { oldAuthKey, next, nextKey: { roomHandle: key.roomHandle, keyEpoch: key.keyEpoch + 1, dek: next.dek } };
}

const ownBlobId = (src, roomHandle) => {
  const source = classifyImportedImageSource(src);
  return source?.kind === 'e2e' && source.roomHandle === roomHandle && source.source === src ? source.blobId : null;
};

/** One image re-encrypted under the next key as a staged copy; null when it is permanently broken (keeps its src). */
async function reencryptImage(src, { key, nextKey, rotationId, images, run }) {
  const signal = AbortSignal.any([run.signal, AbortSignal.timeout(run.imageTimeoutMs)]);
  let image;
  try {
    image = await images.read(src, { key, signal });
  } catch (error) {
    if (isPermanentlyBrokenImage(error)) return null;
    throw error;
  }
  try {
    return await images.upload(image.blob, { key: nextKey, stage: rotationId, signal });
  } catch (error) {
    throw Number.isInteger(error?.status) ? lockActionErrorForStatus(error.status) : error;
  }
}

/** Re-encrypts the detached doc's images and points the detached doc (never the live one) at the copies. */
async function reencryptImages(doc, options) {
  const { key } = options;
  const items = doc.getMap(ITEMS_MAP);
  const sources = [...new Set(listImageSources(items).map(({ src }) => src))].filter((src) => ownBlobId(src, key.roomHandle));
  const replacements = new Map();
  for (const src of sources) {
    const copy = await reencryptImage(src, options);
    if (copy !== null) replacements.set(src, copy);
  }
  if (replacements.size > 0) rewriteImageSources(doc, items, replacements, ROTATION_ORIGIN, key.roomHandle);
  return [...replacements.values()].map((src) => ownBlobId(src, key.roomHandle));
}

/** Builds the commit from a detached copy of the state this page holds once it has read up to the frozen head. */
async function buildCommit(source, { key, keys, rotation, images, run }) {
  const detached = new Y.Doc();
  try {
    Y.applyUpdate(detached, source.encodeState());
    const keepBlobs = await reencryptImages(detached, {
      key, nextKey: keys.nextKey, rotationId: rotation.rotationId, images, run,
    });
    const aad = e2eAad(key.roomHandle, keys.nextKey.keyEpoch, SNAPSHOT_KIND, rotation.head);
    const snapshot = await encryptFrame(keys.next.dek, aad, Y.encodeStateAsUpdate(detached));
    const header = {
      oldAuthKey: keys.oldAuthKey,
      rotationId: rotation.rotationId,
      expectedHead: rotation.head,
      knownSnapshotBase: source.appliedSnapshotBase,
      keyEpoch: keys.nextKey.keyEpoch,
      lock: keys.next.lock,
      keepBlobs,
    };
    return { header, snapshot };
  } finally {
    detached.destroy();
  }
}

// Local edits made after begin are refused FROZEN and stay pending; they are re-sent under the new key after the
// re-unlock, so the catch-up does not wait for this page's delivery (it already drained before begin).
async function commitFrozen({ storage, api, key, keys, rotation, images, run }) {
  await waitUntil(() => hasReadFrozenHead(storage.rotationSource(), rotation.head), run, ROTATION_FAILURE.CATCH_UP_TIMEOUT);
  const source = storage.rotationSource();
  if (source.roomHandle !== key.roomHandle || source.keyEpoch !== key.keyEpoch) throw new RotationError(ROTATION_FAILURE.LOCK_CHANGED);
  const { header, snapshot } = await buildCommit(source, { key, keys, rotation, images, run });
  throwIfCancelled(run.signal);
  run.commitSent = true;
  await api.commitRotation(header, snapshot, { signal: run.signal });
}

async function beginFrozen({ api, key, keys, storage, run }) {
  await waitUntil(() => {
    const source = storage.rotationSource();
    assertCompleteCoverage(source);
    return source.pendingDelivery === 0;
  }, run, ROTATION_FAILURE.DRAIN_TIMEOUT);
  try {
    throwIfCancelled(run.signal);
    return await api.beginRotation({ oldAuthKey: keys.oldAuthKey, expectedRevision: key.lockRevision }, { signal: run.signal });
  } catch (error) {
    throw rotationErrorFor(error, ROTATION_FAILURE.LOCK_CHANGED, run.signal);
  }
}

/**
 * "Remove everyone": replaces the room key and password (Deviation 5, [S1]). Drain this page's edits, freeze the
 * log, wait until this page has applied every entry up to the frozen head (none skipped), then commit a snapshot
 * of a DETACHED doc and its images re-encrypted under a new key. Any failure or cancel (`signal`, page hide) after
 * the freeze aborts it and never commits; the live board is never written. On success the relay closes every
 * socket with 4001 and each page, this one included, re-unlocks with the new password (the old key stays as a
 * previous key for image repair).
 *
 * `key` is the unlocked room key (getRoomKey()), `storage` gives rotationSource(), `api` is createRoomLockApi().
 * Resolves `{ keyEpoch }`; rejects with a RotationError.
 */
export async function rotateRoom({
  currentPassword, newPassword, key, storage, api, signal = new AbortController().signal, images = DEFAULT_IMAGES,
  clock = SYSTEM_CLOCK, timeoutMs = ROTATION_WAIT_TIMEOUT_MS, imageTimeoutMs = ROTATION_IMAGE_TIMEOUT_MS, onTerminate = onPageHide,
}) {
  const hidden = new AbortController();
  const run = { clock, timeoutMs, imageTimeoutMs, signal: AbortSignal.any([signal, hidden.signal]), commitSent: false };
  const keys = await prepareKeys({ currentPassword, newPassword, key });
  const rotation = await beginFrozen({ api, key, keys, storage, run });
  // Resolves whether the relay released the freeze; a refusal means it is gone (committed or expired).
  const abort = (options) => api.abortRotation({ oldAuthKey: keys.oldAuthKey, rotationId: rotation.rotationId }, options)
    .then(() => true, () => false);
  // The page is going away: release the freeze with a request that outlives it, and never commit afterwards.
  const stopWatching = onTerminate(() => {
    hidden.abort();
    abort({ keepalive: true });
  });
  try {
    await commitFrozen({ storage, api, key, keys, rotation, images, run });
  } catch (error) {
    const released = await abort();
    // A commit that got no answer may have landed; the abort's refusal is then the only sign, so say so.
    if (run.commitSent && !released && !isRelayAnswer(error)) throw new RotationError(ROTATION_FAILURE.UNKNOWN_OUTCOME);
    throw rotationErrorFor(error, ROTATION_FAILURE.BOARD_CHANGED, run.signal);
  } finally {
    stopWatching();
  }
  return { keyEpoch: keys.nextKey.keyEpoch };
}
