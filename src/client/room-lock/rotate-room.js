import * as Y from 'yjs';
import { e2eAad } from '../../domain/room-lock-contract.js';
import { classifyImportedImageSource } from '../../domain/security-boundaries.js';
import { listImageSources, rewriteImageSources } from '../session/item-image-sources.js';
import { RoomKeyError, createNextRoomKey, deriveRoomSecrets, encryptFrame } from './e2e-crypto.js';
import { readE2EImage, uploadEncryptedImage } from './e2e-images.js';
import { LOCK_ACTION_ERROR, RoomLockActionError, lockActionErrorForStatus } from './room-lock-api.js';

/** How long the drain and the catch-up to the frozen head may take before the rotation gives up. */
export const ROTATION_WAIT_TIMEOUT_MS = 60_000;
const ROTATION_POLL_INTERVAL_MS = 100;
const ROTATION_ORIGIN = 'key-rotation';
const ITEMS_MAP = 'items';
const SNAPSHOT_KIND = 'snapshot';

export const ROTATION_FAILURE = Object.freeze({
  DRAIN_TIMEOUT: 'drain-timeout',
  CATCH_UP_TIMEOUT: 'catch-up-timeout',
  STORAGE_FULL: 'storage-full',
  BOARD_CHANGED: 'board-changed',
  LOCK_CHANGED: 'lock-changed',
  WRONG_PASSWORD: 'wrong',
  LOCKED_OUT: 'locked-out',
  UNAVAILABLE: 'unavailable',
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

// A 409 before the freeze means the lock moved on (revision or another rotation); after it, the board did.
const PASS_THROUGH = new Map([
  [LOCK_ACTION_ERROR.WRONG_PASSWORD, ROTATION_FAILURE.WRONG_PASSWORD],
  [LOCK_ACTION_ERROR.LOCKED_OUT, ROTATION_FAILURE.LOCKED_OUT],
  [LOCK_ACTION_ERROR.STORAGE_FULL, ROTATION_FAILURE.STORAGE_FULL],
]);

function rotationErrorFor(error, conflictKind) {
  if (error instanceof RotationError) return error;
  if (error instanceof RoomKeyError && error.code === 'wrong-password') return new RotationError(ROTATION_FAILURE.WRONG_PASSWORD);
  if (!(error instanceof RoomLockActionError)) return new RotationError(ROTATION_FAILURE.UNAVAILABLE);
  if (error.kind === LOCK_ACTION_ERROR.CONFLICT) return new RotationError(conflictKind);
  return new RotationError(PASS_THROUGH.get(error.kind) ?? ROTATION_FAILURE.UNAVAILABLE, { retryAfterSeconds: error.retryAfterSeconds });
}

async function waitUntil(predicate, { clock, timeoutMs }, failure) {
  const deadline = clock.now() + timeoutMs;
  while (!predicate()) {
    if (clock.now() >= deadline) throw new RotationError(failure);
    await clock.sleep(ROTATION_POLL_INTERVAL_MS);
  }
}

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

/**
 * Re-encrypts every image of the detached doc under the next key as a copy staged for this rotation, and points
 * the detached doc (never the live one) at the copies. An image that no held key opens is already broken for
 * everyone; it keeps its source. Resolves the staged ids.
 */
async function reencryptImages(doc, { key, nextKey, rotationId, images }) {
  const items = doc.getMap(ITEMS_MAP);
  const sources = [...new Set(listImageSources(items).map(({ src }) => src))].filter((src) => ownBlobId(src, key.roomHandle));
  const replacements = new Map();
  for (const src of sources) {
    const image = await images.read(src, { key }).catch((error) => {
      if (error instanceof RoomKeyError) return null;
      throw error;
    });
    if (image === null) continue;
    const copy = await images.upload(image.blob, { key: nextKey, stage: rotationId }).catch((error) => {
      throw Number.isInteger(error?.status) ? lockActionErrorForStatus(error.status) : error;
    });
    replacements.set(src, copy);
  }
  if (replacements.size > 0) rewriteImageSources(doc, items, replacements, ROTATION_ORIGIN, key.roomHandle);
  return [...replacements.values()].map((src) => ownBlobId(src, key.roomHandle));
}

/** Builds the commit from a detached copy of the state this page holds once it has read up to the frozen head. */
async function buildCommit(source, { key, keys, rotation, images }) {
  const detached = new Y.Doc();
  try {
    Y.applyUpdate(detached, source.encodeState());
    const keepBlobs = await reencryptImages(detached, { key, nextKey: keys.nextKey, rotationId: rotation.rotationId, images });
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

async function commitFrozen({ storage, api, key, keys, rotation, images, wait }) {
  await waitUntil(() => {
    const source = storage.rotationSource();
    return source.appliedSeq >= rotation.head && source.pendingDelivery === 0;
  }, wait, ROTATION_FAILURE.CATCH_UP_TIMEOUT);
  const source = storage.rotationSource();
  if (source.roomHandle !== key.roomHandle || source.keyEpoch !== key.keyEpoch) throw new RotationError(ROTATION_FAILURE.LOCK_CHANGED);
  const { header, snapshot } = await buildCommit(source, { key, keys, rotation, images });
  await api.commitRotation(header, snapshot);
}

/**
 * "Remove everyone": replaces the room key and password (Deviation 5, [S1]). Drain this page's edits, freeze the
 * log, wait for every append accepted before the freeze, then commit a snapshot of a DETACHED doc and its images
 * re-encrypted under a new key. Any failure after the freeze aborts it; the live board is never written.
 * On success the relay closes every socket with 4001 and each page, this one included, re-unlocks with the new
 * password (the old key stays as a previous key for image repair).
 *
 * `key` is the unlocked room key (getRoomKey()), `storage` gives rotationSource(), `api` is createRoomLockApi().
 * Resolves `{ keyEpoch }`; rejects with a RotationError.
 */
export async function rotateRoom({
  currentPassword, newPassword, key, storage, api, images = DEFAULT_IMAGES, clock = SYSTEM_CLOCK, timeoutMs = ROTATION_WAIT_TIMEOUT_MS,
}) {
  const wait = { clock, timeoutMs };
  const keys = await prepareKeys({ currentPassword, newPassword, key });
  await waitUntil(() => storage.rotationSource().pendingDelivery === 0, wait, ROTATION_FAILURE.DRAIN_TIMEOUT);
  let rotation;
  try {
    rotation = await api.beginRotation({ oldAuthKey: keys.oldAuthKey, expectedRevision: key.lockRevision });
  } catch (error) {
    throw rotationErrorFor(error, ROTATION_FAILURE.LOCK_CHANGED);
  }
  try {
    await commitFrozen({ storage, api, key, keys, rotation, images, wait });
  } catch (error) {
    await api.abortRotation({ oldAuthKey: keys.oldAuthKey, rotationId: rotation.rotationId }).catch(() => {});
    throw rotationErrorFor(error, ROTATION_FAILURE.BOARD_CHANGED);
  }
  return { keyEpoch: keys.nextKey.keyEpoch };
}
