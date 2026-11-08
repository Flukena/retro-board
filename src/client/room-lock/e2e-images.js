import { e2eAad } from '../../domain/room-lock-contract.js';
import { classifyImportedImageSource, isSafeImageMime } from '../../domain/security-boundaries.js';
import { roomFetch } from '../session/room-session.js';
import { RoomKeyError, decryptFrame, encryptFrame } from './e2e-crypto.js';
import { getRoomKey } from './lock-session.js';

const BLOB_AAD_KIND = 'blob';
const BLOB_ROUTE = 'e2e-blobs';
const BLOB_ID_HEADER = 'x-blob-id';
const BLOB_CONTENT_TYPE = 'application/octet-stream';
const TYPE_LENGTH_BYTES = 1;
/** Resolved blob epochs are remembered per source; the oldest entry goes first once the map is full. */
export const E2E_EPOCH_CACHE_MAX_ENTRIES = 256;
const BROKEN_IMAGE = 'broken-image';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('ascii');
const epochBySource = new Map();

const brokenImage = () => new RoomKeyError(BROKEN_IMAGE);

const requireKey = (key) => {
  if (!key?.dek || typeof key.roomHandle !== 'string') throw new RangeError('room is locked');
  return key;
};

export const e2eImagePath = (roomHandle, blobId) => `/rooms/${roomHandle}/${BLOB_ROUTE}/${blobId}`;

/** Plaintext layout: `[u8 typeLen][type ASCII][image bytes]`. */
async function packImage(blob) {
  if (!isSafeImageMime(blob.type)) throw new RangeError('unsupported image type');
  const type = textEncoder.encode(blob.type);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const packed = new Uint8Array(TYPE_LENGTH_BYTES + type.length + bytes.length);
  packed[0] = type.length;
  packed.set(type, TYPE_LENGTH_BYTES);
  packed.set(bytes, TYPE_LENGTH_BYTES + type.length);
  return packed;
}

function unpackImage(packed) {
  const typeEnd = TYPE_LENGTH_BYTES + packed[0];
  if (packed.length <= typeEnd) throw brokenImage();
  const type = textDecoder.decode(packed.subarray(TYPE_LENGTH_BYTES, typeEnd));
  if (!isSafeImageMime(type)) throw brokenImage();
  return new Blob([packed.subarray(typeEnd)], { type });
}

/** Encrypts an image blob under the room key; the AAD binds the freshly generated blob id. */
export async function encryptImageForUpload(blob, key = getRoomKey()) {
  const { dek, roomHandle, keyEpoch } = requireKey(key);
  const id = globalThis.crypto.randomUUID();
  const bytes = await encryptFrame(dek, e2eAad(roomHandle, keyEpoch, BLOB_AAD_KIND, id), await packImage(blob));
  return { bytes, id };
}

/** Encrypts in the browser and posts the ciphertext; resolves to the canonical `/rooms/<h>/e2e-blobs/<id>` source. */
export async function uploadEncryptedImage(blob, { signal, key = getRoomKey() } = {}) {
  const { bytes, id } = await encryptImageForUpload(blob, key);
  const response = await roomFetch(BLOB_ROUTE, {
    signal, method: 'POST', body: bytes, headers: { 'Content-Type': BLOB_CONTENT_TYPE, [BLOB_ID_HEADER]: id },
  });
  if (!response.ok) throw new Error(`image upload failed: ${response.status}`);
  const payload = await response.json();
  if (payload?.id !== id || Object.keys(payload).length !== 1) throw new Error('invalid image upload response');
  return e2eImagePath(key.roomHandle, id);
}

/** True when this page already opened the source under the current key: nothing to repair, no fetch needed. */
export const isKnownCurrentEpoch = (src, key) => epochBySource.get(src) === key.keyEpoch;

function rememberEpoch(src, epoch) {
  epochBySource.delete(src);
  epochBySource.set(src, epoch);
  if (epochBySource.size > E2E_EPOCH_CACHE_MAX_ENTRIES) epochBySource.delete(epochBySource.keys().next().value);
}

/** Current key first, then each earlier epoch newest first; a remembered epoch jumps the queue. */
function keyCandidates(key, src) {
  const earlier = [...(key.previousKeys ?? [])].sort(([a], [b]) => b - a).map(([epoch, dek]) => ({ epoch, dek }));
  const all = [{ epoch: key.keyEpoch, dek: key.dek }, ...earlier];
  const known = epochBySource.get(src);
  return known === undefined ? all : [...all.filter((c) => c.epoch === known), ...all.filter((c) => c.epoch !== known)];
}

/** Opens ciphertext with whichever held key fits; resolves `{ blob, epoch }` or throws a RoomKeyError. */
export async function decryptImageBytes(bytes, src, key = getRoomKey()) {
  requireKey(key);
  const source = classifyImportedImageSource(src);
  if (source?.kind !== 'e2e' || source.roomHandle !== key.roomHandle) throw brokenImage();
  let lastError = new RoomKeyError('tampered');
  for (const { epoch, dek } of keyCandidates(key, source.source)) {
    let packed;
    try {
      packed = await decryptFrame(dek, e2eAad(key.roomHandle, epoch, BLOB_AAD_KIND, source.blobId), bytes);
    } catch (error) {
      lastError = error;
      continue;
    }
    const blob = unpackImage(packed);
    rememberEpoch(source.source, epoch);
    return { blob, epoch };
  }
  throw lastError;
}

/** Decrypts an already fetched `e2e-blobs/<id>` response. */
export async function decryptImageResponse(response, src, key = getRoomKey()) {
  return decryptImageBytes(new Uint8Array(await response.arrayBuffer()), src, key);
}

/** Fetches and decrypts one image: `{ blob, epoch }` (the epoch tells repair which key opened it). */
export async function readE2EImage(src, { signal, key = getRoomKey() } = {}) {
  const source = classifyImportedImageSource(src);
  if (source?.kind !== 'e2e') throw brokenImage();
  const response = await roomFetch(`${BLOB_ROUTE}/${source.blobId}`, { signal });
  if (!response.ok) throw new Error(`image read failed: ${response.status}`);
  return decryptImageResponse(response, source.source, key);
}

export async function readE2EImageBytes(src, options) {
  return (await readE2EImage(src, options)).blob;
}

// Live blob URLs, shared by every card showing the same source and revoked with the last release.
const liveUrls = new Map();

function openLiveUrl(src) {
  const entry = { refs: 0, url: null, promise: null };
  entry.promise = readE2EImageBytes(src).then((blob) => {
    entry.url = URL.createObjectURL(blob);
    return entry.url;
  });
  entry.promise.catch(() => { if (liveUrls.get(src) === entry) liveUrls.delete(src); });
  return entry;
}

function releaseLiveUrl(src, entry) {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (liveUrls.get(src) === entry) liveUrls.delete(src);
  entry.promise.then((url) => URL.revokeObjectURL(url), () => {});
}

/** Takes a shared `blob:` URL for the source; `release()` (idempotent) revokes it once no card holds it. */
export function resolveE2EImage(src) {
  let entry = liveUrls.get(src);
  if (!entry) {
    entry = openLiveUrl(src);
    liveUrls.set(src, entry);
  }
  entry.refs += 1;
  const held = entry;
  let released = false;
  return {
    url: held.promise,
    release() {
      if (released) return;
      released = true;
      releaseLiveUrl(src, held);
    },
  };
}
