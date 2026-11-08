import { BLOB_ID_PATTERN, isCounter, isPlainObject } from '../../domain/room-lock-contract.js';
import { parseRetryAfter, readSmallJson, relayPost } from '../session/room-session.js';

/** A commit carries the whole board snapshot, so it gets more time than a small JSON call. */
const REQUEST_TIMEOUT_MS = 60_000;
const COMMIT_HEADER_LENGTH_BYTES = 4;
const BINARY_TYPE = 'application/octet-stream';
const HTTP = Object.freeze({
  OK: 200, NO_CONTENT: 204, FORBIDDEN: 403, CONFLICT: 409, TOO_LARGE: 413, TOO_MANY: 429, INSUFFICIENT_STORAGE: 507,
});
const textEncoder = new TextEncoder();

/** Why an owner lock request failed, in the terms the dialogs show. */
export const LOCK_ACTION_ERROR = Object.freeze({
  WRONG_PASSWORD: 'wrong',
  LOCKED_OUT: 'locked-out',
  CONFLICT: 'conflict',
  STORAGE_FULL: 'storage-full',
  UNAVAILABLE: 'unavailable',
});

const KIND_BY_STATUS = new Map([
  [HTTP.FORBIDDEN, LOCK_ACTION_ERROR.WRONG_PASSWORD],
  [HTTP.TOO_MANY, LOCK_ACTION_ERROR.LOCKED_OUT],
  [HTTP.CONFLICT, LOCK_ACTION_ERROR.CONFLICT],
  [HTTP.TOO_LARGE, LOCK_ACTION_ERROR.STORAGE_FULL],
  [HTTP.INSUFFICIENT_STORAGE, LOCK_ACTION_ERROR.STORAGE_FULL],
]);

export class RoomLockActionError extends Error {
  constructor(kind, { status = null, retryAfterSeconds = null } = {}) {
    super(`room lock request failed: ${kind}`);
    this.name = 'RoomLockActionError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The failure an HTTP status means for a lock request or a staged upload. */
export const lockActionErrorForStatus = (status, retryAfterSeconds = null) => new RoomLockActionError(
  KIND_BY_STATUS.get(status) ?? LOCK_ACTION_ERROR.UNAVAILABLE, { status, retryAfterSeconds },
);

const isBlobId = (value) => typeof value === 'string' && BLOB_ID_PATTERN.test(value);

/** `[u32 BE header length][UTF-8 JSON header][snapshot ciphertext]` (Deviation 5). */
export function encodeCommitBody(header, snapshot) {
  const json = textEncoder.encode(JSON.stringify(header));
  const body = new Uint8Array(COMMIT_HEADER_LENGTH_BYTES + json.length + snapshot.length);
  new DataView(body.buffer).setUint32(0, json.length, false);
  body.set(json, COMMIT_HEADER_LENGTH_BYTES);
  body.set(snapshot, COMMIT_HEADER_LENGTH_BYTES + json.length);
  return body;
}

/** Aborts on the caller's signal or when the request's whole deadline (headers and body) passes. */
const deadlineSignal = (signal, timeoutMs) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));

const noBody = async () => undefined;

/** One request whose deadline also covers reading the body with `read`; every failure is a RoomLockActionError. */
async function send(path, { body, contentType, expectedStatus, signal, keepalive, timeoutMs, read = noBody }) {
  const deadline = deadlineSignal(signal, timeoutMs);
  let response;
  try {
    response = await relayPost(path, body, { contentType, signal: deadline, keepalive });
  } catch {
    throw new RoomLockActionError(LOCK_ACTION_ERROR.UNAVAILABLE);
  }
  if (response.status !== expectedStatus) {
    await response.body?.cancel?.().catch(() => {});
    throw lockActionErrorForStatus(response.status, parseRetryAfter(response));
  }
  return read(response);
}

const jsonReader = (isValid) => async (response) => {
  let value;
  try {
    value = await readSmallJson(response);
  } catch {
    throw new RoomLockActionError(LOCK_ACTION_ERROR.UNAVAILABLE);
  }
  if (!isPlainObject(value) || !isValid(value)) throw new RoomLockActionError(LOCK_ACTION_ERROR.UNAVAILABLE);
  return value;
};

/**
 * The owner-only lock routes of one room (`/api/rooms/<handle>/lock/...`). They need the account cookie and
 * prove the current password with `oldAuthKey`; every failure is a RoomLockActionError.
 */
export function createRoomLockApi(roomHandle, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const route = (action) => `/api/rooms/${roomHandle}/lock/${action}`;
  const postJson = (action, body, expectedStatus, options) => send(route(action), {
    body: JSON.stringify(body), expectedStatus, timeoutMs, ...options,
  });
  return {
    /** Resolves `{ lockRevision }`. */
    async changePassword({ oldAuthKey, expectedRevision, lock }, { signal } = {}) {
      const read = jsonReader((value) => isCounter(value.lockRevision));
      const { lockRevision } = await postJson('password', { oldAuthKey, expectedRevision, lock }, HTTP.OK, { signal, read });
      return { lockRevision };
    },
    /** Freezes appends; resolves `{ head, rotationId, lockRevision }`. */
    async beginRotation({ oldAuthKey, expectedRevision }, { signal } = {}) {
      const read = jsonReader((v) => isCounter(v.head) && isBlobId(v.rotationId) && isCounter(v.lockRevision));
      const value = await postJson('rotate/begin', { oldAuthKey, expectedRevision }, HTTP.OK, { signal, read });
      return { head: value.head, rotationId: value.rotationId, lockRevision: value.lockRevision };
    },
    async commitRotation(header, snapshot, { signal } = {}) {
      await send(route('rotate/commit'), {
        body: encodeCommitBody(header, snapshot), contentType: BINARY_TYPE, expectedStatus: HTTP.NO_CONTENT, signal, timeoutMs,
      });
    },
    /** `keepalive` lets the abort leave a page that is being hidden or unloaded. */
    async abortRotation({ oldAuthKey, rotationId }, { keepalive = false } = {}) {
      await postJson('rotate/abort', { oldAuthKey, rotationId }, HTTP.NO_CONTENT, { keepalive });
    },
  };
}
