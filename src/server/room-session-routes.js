import { entitlementsFor } from '../domain/plan-entitlements.js';
import { LOCK_KDF, hasExactKeys, parseAuthKey, parseLockParams } from '../domain/room-lock-contract.js';
import { authenticateAccount } from './auth-session.js';
import { acceptCredentialOrigin, readJsonBody, sendIfWritable, sendJson } from './relay-http.js';
import { RETRY_AFTER_LONG_SECONDS, RETRY_AFTER_SHORT_SECONDS } from './relay-config.js';
import { CORRUPT_LOCK, ROOM_LOCK_VERSION } from './room-lock-record.js';

const HTTP = Object.freeze({
  OK: 200, CREATED: 201, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  CONFLICT: 409, TOO_LARGE: 413, TOO_MANY: 429, CAPACITY: 507, UNAVAILABLE: 503,
});
const INITIAL_KEY_EPOCH = 0;
const INITIAL_LOCK_REVISION = 0;
const SESSION_KEYS = ['code', 'token'];
const LOCKED_SESSION_KEYS = ['code', 'token', 'authKey'];
const AUTH_KEY_FIELD = 'authKey';
const SOFT_CREATE_ERRORS = ['ROOM_CAPACITY', 'SERVER_UNAVAILABLE'];

/**
 * Room creation and session exchange. ctx: registry, sessions (RoomSessions), verifier (RoomLockVerifier),
 * accountSessions, accountStore, buckets (rate limiters), config, unavailable() getter, onStorageFailure.
 * @returns {{ handleCreateRoom: Function, handleRoomSession: Function }}
 */
export function createRoomSessionRoutes(ctx) {
  const { registry, sessions, verifier, buckets, config } = ctx;

  const preamble = (req, res) => {
    if (!acceptCredentialOrigin(req, res, config.allowedOrigins, config.allowInsecureHttp)) return false;
    res.setHeader('cache-control', 'no-store');
    if (ctx.unavailable()) { res.writeHead(HTTP.UNAVAILABLE); res.end(); return false; }
    return true;
  };

  const accountOf = (req) => authenticateAccount(req, ctx.accountSessions, ctx.accountStore);

  // Returns the lock record to create with, or sends the refusal and returns null.
  const lockForCreation = async (req, res, lockParams) => {
    const params = parseLockParams(lockParams);
    if (!params) { sendIfWritable(res, HTTP.BAD_REQUEST); return null; }
    const account = await accountOf(req);
    if (!account) { sendIfWritable(res, HTTP.UNAUTHORIZED); return null; }
    if (!entitlementsFor(account.plan).canCreateLockedRoom) { sendIfWritable(res, HTTP.FORBIDDEN); return null; }
    return {
      v: ROOM_LOCK_VERSION, ...params, keyEpoch: INITIAL_KEY_EPOCH, ownerAccountId: account.id,
      createdAt: Date.now(), lockRevision: INITIAL_LOCK_REVISION,
    };
  };

  const handleCreateRoom = async (req, res, clientIp) => {
    if (!preamble(req, res)) return;
    const retryAfterSeconds = buckets.takeCreateToken(clientIp);
    if (retryAfterSeconds) { res.writeHead(HTTP.TOO_MANY, { 'retry-after': String(retryAfterSeconds) }); res.end(); return; }
    let body;
    try {
      body = await readJsonBody(req, config.maxApiBodyBytes, { allowEmpty: true });
    } catch (err) {
      sendIfWritable(res, err.code === 'BODY_TOO_LARGE' ? HTTP.TOO_LARGE : HTTP.BAD_REQUEST);
      return;
    }
    const wantsLock = hasExactKeys(body, ['lock']);
    if (!wantsLock && Object.keys(body).length !== 0) { res.writeHead(HTTP.BAD_REQUEST); res.end(); return; }
    try {
      let lock = null;
      if (wantsLock) {
        lock = await lockForCreation(req, res, body.lock);
        if (!lock) return;
      }
      sendJson(res, HTTP.CREATED, await registry.createRoom({ unavailable: ctx.unavailable(), lock }));
    } catch (err) {
      if (err.code === 'STORAGE_FAILURE') ctx.onStorageFailure(err);
      else if (!SOFT_CREATE_ERRORS.includes(err.code)) {
        console.error('[yjs] room creation failed', { code: err.code || 'UNKNOWN', err: err.message });
      }
      sendIfWritable(res, err.code === 'ROOM_CAPACITY' ? HTTP.CAPACITY : HTTP.UNAVAILABLE);
    }
  };

  const refuseFailedLookup = (res, clientIp, status) => {
    if (!buckets.failureAttemptAvailable(clientIp)) sendIfWritable(res, HTTP.TOO_MANY, { 'retry-after': RETRY_AFTER_LONG_SECONDS });
    else {
      buckets.recordSessionFailure(clientIp);
      sendIfWritable(res, status);
    }
  };

  const issueSession = (docName, prefixed, keyEpoch) => {
    const roomHandle = registry.roomHandleForDoc(docName);
    const expiresAt = Date.now() + config.sessionTtlMs;
    const cookiePath = `${prefixed ? '/yjs' : ''}/rooms/${roomHandle}`;
    return { roomHandle, expiresAt, cookie: sessions.createCookie(roomHandle, expiresAt, docName, cookiePath, { keyEpoch }) };
  };

  const exchangeLocked = async (req, res, clientIp, prefixed, docName, authKey) => {
    const lock = registry.lockFor(docName);
    if (lock === CORRUPT_LOCK) { sendIfWritable(res, HTTP.UNAVAILABLE); return; }
    if (authKey === undefined) {
      sendJson(res, HTTP.CONFLICT, { locked: true, salt: lock.salt, kdf: { ...LOCK_KDF } });
      return;
    }
    if (!parseAuthKey(authKey)) { sendIfWritable(res, HTTP.BAD_REQUEST); return; }
    const verdict = verifier.check(clientIp, docName, lock, authKey);
    if (verdict === 'wrong') { sendIfWritable(res, HTTP.FORBIDDEN); return; }
    if (verdict !== 'ok') { sendIfWritable(res, HTTP.TOO_MANY, { 'retry-after': String(verdict.limited) }); return; }
    const account = await accountOf(req);
    const { roomHandle, expiresAt, cookie } = issueSession(docName, prefixed, lock.keyEpoch);
    sendJson(res, HTTP.OK, {
      roomHandle, expiresAt,
      lock: { wrappedDek: lock.wrappedDek, wrapIv: lock.wrapIv, keyEpoch: lock.keyEpoch, isOwner: account?.id === lock.ownerAccountId },
    }, { 'set-cookie': cookie });
  };

  const exchangeNormal = (res, docName, prefixed) => {
    const { roomHandle, expiresAt, cookie } = issueSession(docName, prefixed, null);
    sendJson(res, HTTP.OK, { roomHandle, expiresAt }, { 'set-cookie': cookie });
  };

  const handleRoomSession = async (req, res, clientIp, prefixed) => {
    if (!preamble(req, res)) return;
    let body;
    try { body = await readJsonBody(req, config.maxApiBodyBytes); }
    catch (err) { refuseFailedLookup(res, clientIp, err.code === 'BODY_TOO_LARGE' ? HTTP.TOO_LARGE : HTTP.BAD_REQUEST); return; }
    const hasAuthKeyField = hasExactKeys(body, LOCKED_SESSION_KEYS);
    const wellFormed = (hasAuthKeyField || hasExactKeys(body, SESSION_KEYS))
      && typeof body.code === 'string' && typeof body.token === 'string';
    // A present but non-string authKey is a malformed request, not a failed capability guess.
    if (wellFormed && hasAuthKeyField && typeof body[AUTH_KEY_FIELD] !== 'string') { sendIfWritable(res, HTTP.BAD_REQUEST); return; }
    const docName = wellFormed ? registry.registeredDocForCapability(body.code, body.token) : null;
    if (!docName) { refuseFailedLookup(res, clientIp, HTTP.NOT_FOUND); return; }
    if (!buckets.takeSessionExchangeToken(clientIp)) {
      sendIfWritable(res, HTTP.TOO_MANY, { 'retry-after': RETRY_AFTER_SHORT_SECONDS });
      return;
    }
    if (!registry.isLocked(docName)) {
      if (hasAuthKeyField) sendIfWritable(res, HTTP.BAD_REQUEST);
      else exchangeNormal(res, docName, prefixed);
      return;
    }
    try {
      await exchangeLocked(req, res, clientIp, prefixed, docName, hasAuthKeyField ? body.authKey : undefined);
    } catch (err) {
      if (err.code === 'STORAGE_FAILURE') ctx.onStorageFailure(err);
      sendIfWritable(res, HTTP.UNAVAILABLE);
    }
  };

  return { handleCreateRoom, handleRoomSession };
}
