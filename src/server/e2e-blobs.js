import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BLOB_ID_PATTERN } from '../domain/room-lock-contract.js';
import { IMAGE_MAX_BYTES } from '../domain/security-boundaries.js';
import { E2E_CIPHERTEXT_OVERHEAD_BYTES } from '../domain/e2e-envelope.js';
import { acceptCredentialOrigin, sendJson } from './relay-http.js';
import { RETRY_AFTER_SHORT_SECONDS } from './relay-config.js';
import { roomLogId } from './relay-log-id.js';
import { ROOM_CAPACITY_CODE } from './relay-room-registry.js';
import { E2E_BLOB_DUPLICATE, E2E_BUSY, E2E_FROZEN, E2E_QUOTA, E2E_ROTATION_STALE } from './e2e-room-log.js';
import { inventoryKey } from './e2e-blob-store.js';
import { e2eBlobFilename } from './relay-uploads.js';

export const E2E_BLOB_ID_HEADER = 'x-blob-id';
export const E2E_BLOB_STAGE_HEADER = 'x-blob-stage';
export const E2E_BLOB_PREFLIGHT_HEADERS = 'Content-Type, X-Blob-Id, X-Blob-Stage';
export const E2E_BLOB_CONTENT_TYPE = 'application/octet-stream';
export const E2E_BLOB_CACHE_CONTROL = 'private, no-store';
/** Ciphertext beyond MAX_UPLOAD_BYTES that a blob may carry: the encoding envelope around the image. */
const BLOB_ENVELOPE_SLACK_BYTES = 256;
const PRIVATE_FILE_MODE = 0o600;
const HTTP = Object.freeze({
  CREATED: 201, BAD_REQUEST: 400, NOT_FOUND: 404, TIMEOUT: 408, CONFLICT: 409, TOO_LARGE: 413, UNSUPPORTED: 415,
  RATE_LIMITED: 429, SERVER_ERROR: 500, UNAVAILABLE: 503,
});
const BLOB_TOO_LARGE = 'BLOB_TOO_LARGE';
const BLOB_TOO_SMALL = 'BLOB_TOO_SMALL';
const BLOB_TIMEOUT = 'BLOB_TIMEOUT';
const ROLLBACK_FAILURE_LOG = '[yjs] e2e blob rollback failed';
const SWEEP_FAILURE_LOG = '[yjs] e2e blob sweep failed';

/** addBlob / reservation failure codes a client can act on; anything else is a storage failure. */
const STATUS_FOR_ERROR = new Map([
  // A rotation that started or finished while the upload streamed: the client re-encrypts and retries.
  [E2E_ROTATION_STALE, HTTP.CONFLICT],
  [E2E_FROZEN, HTTP.CONFLICT],
  [E2E_BLOB_DUPLICATE, HTTP.CONFLICT],
  [E2E_QUOTA, HTTP.TOO_LARGE],
  [E2E_BUSY, HTTP.RATE_LIMITED],
  [ROOM_CAPACITY_CODE, HTTP.RATE_LIMITED],
]);

const codedError = (code, message) => Object.assign(new Error(message), { code });
/** The lowercase UUID v4 form that blob ids and rotation ids take in headers and URLs. */
const isBlobId = (value) => typeof value === 'string' && BLOB_ID_PATTERN.test(value);
const finish = (res, status, headers) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, headers);
  res.end();
};

/**
 * Encrypted image blobs: HTTP upload and download, expiry of old-epoch blobs, and the startup orphan sweep.
 * Ports: uploads (createRelayUploads: admission, streamImage), store (E2EBlobStore), roomLog (E2ERoomLog),
 * registry (lockFor, isLocked, roomHandleForDoc, locksByDoc), onStorageFailure(error).
 */
export function createE2EBlobs({
  config, allowedOrigins, allowInsecureHttp, uploads, store, roomLog, registry, onStorageFailure, logger = console, now = Date.now,
}) {
  const { admission } = uploads;
  const { MAX_UPLOAD_BYTES, REQUEST_TIMEOUT_MS } = config;
  const maxBlobBytes = Math.min(MAX_UPLOAD_BYTES, IMAGE_MAX_BYTES) + BLOB_ENVELOPE_SLACK_BYTES + E2E_CIPHERTEXT_OVERHEAD_BYTES;

  const reject = (res, status) => {
    finish(res, status);
    return null;
  };

  const readHeaders = (req, res) => {
    const id = req.headers[E2E_BLOB_ID_HEADER];
    const stage = req.headers[E2E_BLOB_STAGE_HEADER];
    const rawLength = req.headers['content-length'];
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!isBlobId(id) || (stage !== undefined && !isBlobId(stage))) return reject(res, HTTP.BAD_REQUEST);
    if (contentType !== E2E_BLOB_CONTENT_TYPE) return reject(res, HTTP.UNSUPPORTED);
    if (rawLength != null && !/^\d+$/.test(String(rawLength))) return reject(res, HTTP.BAD_REQUEST);
    const declaredLength = rawLength == null ? null : Number(rawLength);
    if (declaredLength !== null && declaredLength > maxBlobBytes) return reject(res, HTTP.TOO_LARGE);
    return { id, stage: stage ?? null, declaredLength };
  };

  const writeBody = async (req, transfer) => {
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        transfer.total += chunk.length;
        callback(transfer.total > maxBlobBytes ? codedError(BLOB_TOO_LARGE, 'blob too large') : null, chunk);
      },
    });
    await pipeline(req, meter, fs.createWriteStream(transfer.tempPath, { flags: 'wx', mode: PRIVATE_FILE_MODE }));
    if (transfer.total < E2E_CIPHERTEXT_OVERHEAD_BYTES) throw codedError(BLOB_TOO_SMALL, 'blob is shorter than any ciphertext');
  };

  // The file is already published. Count it, then inventory it; any failure removes file and usage again.
  const inventoryBlob = async ({ docName, handle, id, stage, total, epoch }) => {
    try {
      await store.account(docName, total);
      if (stage) store.rememberStaged(stage, docName, handle, id);
      await roomLog.addBlob(docName, { id, bytes: total, epoch, stagedFor: stage ?? undefined }, { expectedEpoch: epoch });
      return HTTP.CREATED;
    } catch (error) {
      await store.remove(docName, handle, id).catch((cleanupError) => logger.warn(ROLLBACK_FAILURE_LOG, { err: cleanupError.message }));
      return statusOfFailure(error);
    }
  };

  const statusOfFailure = (error) => {
    const status = STATUS_FOR_ERROR.get(error.code);
    if (status) return status;
    onStorageFailure(error);
    return HTTP.UNAVAILABLE;
  };

  const respond = (res, status, id) => {
    if (status === HTTP.CREATED) { sendJson(res, status, { id }); return; }
    finish(res, status, status === HTTP.RATE_LIMITED ? { 'retry-after': RETRY_AFTER_SHORT_SECONDS } : undefined);
  };

  const failureStatus = (error, timedOut) => {
    if (timedOut || error.code === BLOB_TIMEOUT) return HTTP.TIMEOUT;
    if (error.code === BLOB_TOO_LARGE) return HTTP.TOO_LARGE;
    if (error.code === BLOB_TOO_SMALL) return HTTP.BAD_REQUEST;
    logger.error('[yjs] e2e blob upload failed', { err: error.message });
    return HTTP.SERVER_ERROR;
  };

  const handleUpload = async (req, res, clientIp, docName, handle) => {
    if (!acceptCredentialOrigin(req, res, allowedOrigins, allowInsecureHttp)) return;
    if (!admission.takeUploadToken(clientIp)) { finish(res, HTTP.RATE_LIMITED); return; }
    const headers = readHeaders(req, res);
    if (!headers) return;
    const lock = registry.lockFor(docName);
    if (!lock || lock.corrupt) { finish(res, HTTP.UNAVAILABLE); return; }
    const reservation = admission.reserveUpload(clientIp, docName, headers.declaredLength, res, maxBlobBytes);
    if (!reservation) return;
    const upload = { total: 0, tempPath: store.newTempPath(), timedOut: false };
    const deadline = setTimeout(() => { upload.timedOut = true; req.destroy(codedError(BLOB_TIMEOUT, 'upload timeout')); }, REQUEST_TIMEOUT_MS);
    deadline.unref();
    try {
      await writeBody(req, upload);
      const published = await store.publish(upload.tempPath, handle, headers.id);
      respond(res, published ? await inventoryBlob({ docName, handle, ...headers, total: upload.total, epoch: lock.keyEpoch }) : HTTP.CONFLICT, headers.id);
    } catch (error) {
      await store.discardTemp(upload.tempPath);
      if (!res.destroyed) respond(res, failureStatus(error, upload.timedOut));
    } finally {
      clearTimeout(deadline);
      admission.releaseUpload(clientIp, reservation.reservedBytes, docName);
    }
  };

  const handleGet = (clientIp, res, handle, blobId) => {
    if (!isBlobId(blobId)) { finish(res, HTTP.NOT_FOUND); return; }
    uploads.streamImage(e2eBlobFilename(handle, blobId), clientIp, res, E2E_BLOB_CACHE_CONTROL, handle);
  };

  // File first, then the entry: a failed delete keeps the entry, so the next tick retries it.
  const expireRoom = async (docName, handle, at) => {
    const { expired, remainingRetired } = await roomLog.expiredBlobs(docName, at);
    const deleted = [];
    for (const id of expired) {
      try {
        await store.remove(docName, handle, id);
        deleted.push(id);
      } catch (error) {
        logger.warn(SWEEP_FAILURE_LOG, { docName: roomLogId(docName), err: error.message });
      }
    }
    if (deleted.length > 0) await roomLog.removeBlobs(docName, deleted);
    if (remainingRetired === 0 && deleted.length === expired.length) {
      store.untrackRetired(docName);
      roomLog.forget(docName);
    }
  };

  /** Deletes the files of old-epoch blobs whose 24 h grace ended. Visits only rooms known to hold retired blobs. */
  const sweepExpired = async () => {
    const at = now();
    for (const docName of store.retiredRooms()) {
      const handle = registry.isLocked(docName) ? registry.roomHandleForDoc(docName) : null;
      if (!handle) { store.untrackRetired(docName); continue; }
      try {
        await expireRoom(docName, handle, at);
      } catch (error) {
        logger.warn(SWEEP_FAILURE_LOG, { docName: roomLogId(docName), err: error.message });
      }
    }
  };

  // After a restart no freeze exists, so every staged entry is abandoned: file first, then entry.
  const dropAbandonedStaged = async (docName, handle, entries) => {
    const abandoned = entries.filter((entry) => entry.stagedFor);
    for (const { id } of abandoned) await store.remove(docName, handle, id);
    if (abandoned.length > 0) await roomLog.removeBlobs(docName, abandoned.map((entry) => entry.id));
    return abandoned;
  };

  /**
   * Startup recovery. Per locked room: drops abandoned staged blobs, remembers rooms with retired blobs for the
   * expiry sweep, and collects the inventory. Then deletes old unreferenced `.e2e` and blob temp files. Returns the
   * number of files removed, so the caller can reconcile usage.
   */
  const reconcileOrphans = async () => {
    const inventoried = new Set();
    const unreadable = new Set();
    let removed = 0;
    for (const docName of registry.locksByDoc.keys()) {
      const handle = registry.roomHandleForDoc(docName);
      if (!handle) continue;
      try {
        const entries = await roomLog.blobs(docName);
        const abandoned = await dropAbandonedStaged(docName, handle, entries);
        removed += abandoned.length;
        const dropped = new Set(abandoned.map((entry) => entry.id));
        for (const entry of entries) if (!dropped.has(entry.id)) inventoried.add(inventoryKey(handle, entry.id));
        if (entries.some((entry) => entry.retiredAt !== undefined)) store.trackRetired(docName);
      } catch (error) {
        unreadable.add(handle);
        logger.warn(SWEEP_FAILURE_LOG, { docName: roomLogId(docName), err: error.message });
      }
      // Rooms load again on demand; the expiry sweep opens the ones that still hold retired blobs.
      roomLog.forget(docName);
    }
    return removed + await store.deleteOrphans(inventoried, now(), unreadable);
  };

  return { handleUpload, handleGet, sweepExpired, reconcileOrphans };
}
