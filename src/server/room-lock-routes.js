import {
  KEY_ROTATED_CLOSE_CODE, KEY_ROTATED_REASON, hasExactKeys, isCounter, parseAuthKey, parseLockParams,
} from '../domain/room-lock-contract.js';
import { authenticateAccount } from './auth-session.js';
import {
  E2E_BUSY, E2E_CORRUPT, E2E_FROZEN, E2E_LOCK_MISMATCH, E2E_QUOTA, E2E_ROOM_DELETED, E2E_ROTATION_STALE, MAX_FREEZE_TTL_MS,
} from './e2e-room-log.js';
import { acceptCredentialOrigin, readJsonBody, sendIfWritable, sendJson } from './relay-http.js';
import { isBlobId, readCommitBody } from './room-lock-commit-body.js';
import { RETRY_AFTER_SHORT_SECONDS } from './relay-config.js';
import { CORRUPT_LOCK } from './room-lock-record.js';
import { UNFENCED } from './room-fence.js';

export { KEY_ROTATED_CLOSE_CODE, KEY_ROTATED_REASON };
export const MAX_PASSWORD_BODY_BYTES = 1024;
const OCTET_STREAM = 'application/octet-stream';
const LOCK_LIMITED = 'LOCK_LIMITED';
const STORAGE_FAILURE = 'STORAGE_FAILURE';
const HTTP = Object.freeze({
  OK: 200, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  TOO_LARGE: 413, UNSUPPORTED: 415, TOO_MANY: 429, UNAVAILABLE: 503,
});
const LOCK_PATH = /^\/api\/rooms\/([A-Za-z0-9_-]{32})\/lock\/(password|rotate\/begin|rotate\/commit|rotate\/abort)$/;
const PASSWORD_KEYS = ['oldAuthKey', 'expectedRevision', 'lock'];
const BEGIN_KEYS = ['oldAuthKey', 'expectedRevision'];
const ABORT_KEYS = ['oldAuthKey', 'rotationId'];

const bad = () => Object.assign(new Error('bad request'), { status: HTTP.BAD_REQUEST });
const conflict = () => Object.assign(new Error('conflict'), { status: HTTP.CONFLICT });
const notFound = () => Object.assign(new Error('not found'), { status: HTTP.NOT_FOUND });

/**
 * Verifies `oldAuthKey` against whatever record the log holds at that moment, with the wrong-password limits.
 * The log treats a false return as a mismatch; `verdict` tells the route whether that was a wrong key.
 */
function authorizer(verifier, clientIp, docName, oldAuthKey) {
  const attempt = {
    verdict: null,
    verify(record) {
      const verdict = verifier.check(clientIp, docName, record, oldAuthKey);
      attempt.verdict = verdict;
      if (verdict === 'ok') return true;
      if (verdict === 'wrong') return false;
      throw Object.assign(new Error('wrong-password limit'), { code: LOCK_LIMITED, retryAfter: verdict.limited });
    },
  };
  return attempt;
}

const requireAuthKey = (value) => {
  if (!parseAuthKey(value)) throw bad();
  return value;
};

const requireKeys = (body, keys) => {
  if (!hasExactKeys(body, keys)) throw bad();
  requireAuthKey(body.oldAuthKey);
};

/**
 * Owner-only lock routes: password change and barrier-based key rotation (begin / commit / abort).
 * ctx: registry, roomLog (E2ERoomLog), blobStore (settleStaged), closeRoom(docName, code, reason), verifier (RoomLockVerifier),
 * accountSessions, accountStore, config { allowedOrigins, allowInsecureHttp, maxApiBodyBytes },
 * unavailable() getter, onStorageFailure(error), fence (RoomFence): each request holds an entry on its room throughout.
 * @returns {{ handle: (req, res, routePath: string, options: { clientIp: string, hasQueryOrFragment: boolean }) => boolean }}
 */
export function createRoomLockRoutes(ctx) {
  const { registry, roomLog, verifier, config, fence = UNFENCED } = ctx;

  // A room fenced while the request ran is being deleted: its lock is never re-published and it answers 404.
  const assertNotDeleted = (docName) => {
    if (fence.isFenced(docName)) throw notFound();
  };

  const changePassword = async (req, { docName }, clientIp) => {
    const body = await readJsonBody(req, MAX_PASSWORD_BODY_BYTES);
    requireKeys(body, PASSWORD_KEYS);
    const params = parseLockParams(body.lock);
    if (!params || !isCounter(body.expectedRevision)) throw bad();
    const attempt = authorizer(verifier, clientIp, docName, body.oldAuthKey);
    const updated = await roomLog.mutateLock(docName, {
      verify: attempt.verify, expectedRevision: body.expectedRevision, next: (current) => ({ ...current, ...params }),
    }).catch((error) => { throw Object.assign(error, { attempt }); });
    assertNotDeleted(docName);
    registry.publishLock(docName, updated);
    return { status: HTTP.OK, json: { lockRevision: updated.lockRevision } };
  };

  const beginRotation = async (req, { docName }, clientIp) => {
    const body = await readJsonBody(req, config.maxApiBodyBytes);
    requireKeys(body, BEGIN_KEYS);
    if (!isCounter(body.expectedRevision)) throw bad();
    const attempt = authorizer(verifier, clientIp, docName, body.oldAuthKey);
    const frozen = await roomLog.freeze(docName, MAX_FREEZE_TTL_MS, {
      expectedRevision: body.expectedRevision, verify: attempt.verify,
    }).catch((error) => { throw Object.assign(error, { attempt }); });
    return { status: HTTP.OK, json: { ...frozen, expiresInMs: MAX_FREEZE_TTL_MS } };
  };

  const abortRotation = async (req, { docName }, clientIp) => {
    const body = await readJsonBody(req, config.maxApiBodyBytes);
    requireKeys(body, ABORT_KEYS);
    if (!isBlobId(body.rotationId)) throw bad();
    const attempt = authorizer(verifier, clientIp, docName, body.oldAuthKey);
    const released = await roomLog.release(docName, body.rotationId, { verify: attempt.verify })
      .catch((error) => { throw Object.assign(error, { attempt }); });
    if (!released) throw conflict();
    return { status: HTTP.NO_CONTENT };
  };

  // The new inventory: blobs staged for this rotation that the client keeps, plus every existing committed blob.
  const commitInventory = async (docName, rotationId, keepBlobs) => {
    const blobs = await roomLog.blobs(docName);
    const staged = new Set(blobs.filter((entry) => entry.stagedFor === rotationId).map((entry) => entry.id));
    if (!keepBlobs.every((id) => staged.has(id))) throw conflict();
    const keep = new Set(keepBlobs);
    return blobs.filter((entry) => (entry.stagedFor ? keep.has(entry.id) && entry.stagedFor === rotationId : true));
  };

  // The commit is durable already: a cleanup failure leaves the files for the startup orphan sweep, never fails the request.
  const settleStagedFiles = async (rotationId, keepBlobs) => {
    try {
      await ctx.blobStore.settleStaged(rotationId, keepBlobs);
    } catch (error) {
      console.error('[yjs] staged blob cleanup failed', { code: error.code || 'UNKNOWN' });
    }
  };

  const commitRotation = async (req, { docName, lock }, clientIp) => {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== OCTET_STREAM) {
      throw Object.assign(new Error('unsupported content type'), { status: HTTP.UNSUPPORTED });
    }
    const { header, snapshot } = await readCommitBody(req, roomLog.maxSnapshotBytes);
    const attempt = authorizer(verifier, clientIp, docName, header.oldAuthKey);
    const blobInventory = await commitInventory(docName, header.rotationId, header.keepBlobs);
    const lockRecord = { ...lock, ...header.lock, keyEpoch: header.keyEpoch };
    const committed = await roomLog.commitRotation(docName, {
      rotationId: header.rotationId, expectedHead: header.expectedHead, knownSnapshotBase: header.knownSnapshotBase,
      verify: attempt.verify,
      snapshot, lockRecord, blobInventory,
    }).catch((error) => { throw Object.assign(error, { attempt }); });
    assertNotDeleted(docName);
    registry.publishLock(docName, committed);
    ctx.closeRoom(docName, KEY_ROTATED_CLOSE_CODE, KEY_ROTATED_REASON);
    await settleStagedFiles(header.rotationId, header.keepBlobs);
    return { status: HTTP.NO_CONTENT };
  };

  const ACTIONS = new Map([
    ['password', changePassword],
    ['rotate/begin', beginRotation],
    ['rotate/commit', commitRotation],
    ['rotate/abort', abortRotation],
  ]);

  const statusOf = (error) => {
    if (error.status) return { status: error.status };
    if (error.code === LOCK_LIMITED) return { status: HTTP.TOO_MANY, headers: { 'retry-after': String(error.retryAfter) } };
    if (error.code === E2E_LOCK_MISMATCH) return { status: error.attempt?.verdict === 'wrong' ? HTTP.FORBIDDEN : HTTP.CONFLICT };
    if (error.code === 'BODY_TOO_LARGE') return { status: HTTP.TOO_LARGE };
    if (error.code === 'BAD_JSON') return { status: HTTP.BAD_REQUEST };
    if (error.code === E2E_ROTATION_STALE || error.code === E2E_FROZEN) return { status: HTTP.CONFLICT };
    if (error.code === E2E_QUOTA) return { status: HTTP.TOO_LARGE };
    if (error.code === E2E_ROOM_DELETED) return { status: HTTP.NOT_FOUND };
    if (error.code === E2E_BUSY) return { status: HTTP.TOO_MANY, headers: { 'retry-after': RETRY_AFTER_SHORT_SECONDS } };
    if (error.code === STORAGE_FAILURE) ctx.onStorageFailure(error);
    else if (error.code !== E2E_CORRUPT) console.error('[yjs] room lock route failed', { code: error.code || 'UNKNOWN', err: error.message });
    return { status: HTTP.UNAVAILABLE };
  };

  // Resolves the owner of the target room, or answers the refusal and returns null.
  const authorizeOwner = async (req, res, docName) => {
    const lock = registry.lockFor(docName);
    if (lock === CORRUPT_LOCK) { sendIfWritable(res, HTTP.UNAVAILABLE); return null; }
    const account = await authenticateAccount(req, ctx.accountSessions, ctx.accountStore);
    if (!account) { sendIfWritable(res, HTTP.UNAUTHORIZED); return null; }
    if (!lock) { sendIfWritable(res, HTTP.NOT_FOUND); return null; }
    if (account.id !== lock.ownerAccountId) { sendIfWritable(res, HTTP.FORBIDDEN); return null; }
    return { docName, lock };
  };

  const act = async (req, res, docName, action, clientIp) => {
    try {
      const target = await authorizeOwner(req, res, docName);
      if (!target) return;
      const result = await ACTIONS.get(action)(req, target, clientIp);
      if (result.json) sendJson(res, result.status, result.json);
      else sendIfWritable(res, result.status);
    } catch (error) {
      const { status, headers } = statusOf(error);
      // An early refusal leaves the request body unread; close the connection instead of draining it.
      sendIfWritable(res, status, req.complete ? headers : { ...headers, connection: 'close' });
    }
  };

  const run = async (req, res, handle, action, clientIp) => {
    if (!acceptCredentialOrigin(req, res, config.allowedOrigins, config.allowInsecureHttp)) return;
    res.setHeader('cache-control', 'no-store');
    if (ctx.unavailable()) { sendIfWritable(res, HTTP.UNAVAILABLE); return; }
    // The entry is taken in the same tick as the lookup, so a room being deleted is never acted on.
    const docName = registry.registeredRoomsByHandle.get(handle);
    const leave = docName ? fence.enter(docName) : null;
    if (!leave) { sendIfWritable(res, HTTP.NOT_FOUND); return; }
    try {
      await act(req, res, docName, action, clientIp);
    } finally {
      leave();
    }
  };

  return {
    handle(req, res, routePath, { clientIp, hasQueryOrFragment }) {
      if (req.method !== 'POST' || hasQueryOrFragment) return false;
      const match = LOCK_PATH.exec(routePath);
      if (!match) return false;
      void run(req, res, match[1], match[2], clientIp);
      return true;
    },
  };
}
