import { entitlementsFor } from '../domain/plan-entitlements.js';
import {
  LOCK_KDF, ROOM_SESSION_RENEWAL_SUFFIX, hasExactKeys, parseAuthKey, parseLockParams,
} from '../domain/room-lock-contract.js';
import { ROOM_KIND } from '../domain/room-ownership.js';
import { authenticateAccount } from './auth-session.js';
import { acceptCredentialOrigin, readJsonBody, sendIfWritable, sendJson } from './relay-http.js';
import { RETRY_AFTER_LONG_SECONDS, RETRY_AFTER_SHORT_SECONDS } from './relay-config.js';
import { CORRUPT_LOCK, ROOM_LOCK_VERSION } from './room-lock-record.js';
import { OWNED_ROOM_LIMIT_CODE } from './room-owner-index.js';
import { UNFENCED } from './room-fence.js';

const HTTP = Object.freeze({
  OK: 200, CREATED: 201, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  CONFLICT: 409, TOO_LARGE: 413, TOO_MANY: 429, CAPACITY: 507, UNAVAILABLE: 503,
});
const INITIAL_KEY_EPOCH = 0;
const INITIAL_LOCK_REVISION = 0;
const SESSION_KEYS = ['code', 'token'];
const LOCKED_SESSION_KEYS = ['code', 'token', 'authKey'];
const AUTH_KEY_FIELD = 'authKey';
const SOFT_CREATE_ERRORS = ['ROOM_CAPACITY', 'SERVER_UNAVAILABLE', OWNED_ROOM_LIMIT_CODE];
const OWNED_ROOM_LIMIT_BODY = Object.freeze({ error: 'owned-room-limit' });
const ROOM_KINDS = new Set(Object.values(ROOM_KIND));
const ROOM_SESSION_PATH = '/api/room-session';
const RENEWAL_PATH = new RegExp(`^/rooms/([A-Za-z0-9_-]{32})${ROOM_SESSION_RENEWAL_SUFFIX}$`);

/** The only create bodies: {} (a board), { kind } or { lock } (a locked board). null for anything else. */
function parseCreateBody(body) {
  if (hasExactKeys(body, [])) return { kind: ROOM_KIND.BOARD, locked: false, lockParams: null };
  if (hasExactKeys(body, ['kind'])) return ROOM_KINDS.has(body.kind) ? { kind: body.kind, locked: false, lockParams: null } : null;
  if (hasExactKeys(body, ['lock'])) return { kind: ROOM_KIND.BOARD, locked: true, lockParams: body.lock };
  return null;
}

/**
 * Room creation and session exchange. ctx: registry, sessions (RoomSessions), verifier (RoomLockVerifier),
 * accountSessions, accountStore, buckets (rate limiters), config, unavailable() getter, onStorageFailure,
 * fence (RoomFence): an exchange holds an entry on its room from the lookup to the answer.
 * @returns {{ handle: Function, handleCreateRoom: Function, handleRoomSession: Function }}
 */
export function createRoomSessionRoutes(ctx) {
  const { registry, sessions, verifier, buckets, config, fence = UNFENCED } = ctx;

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

  // Returns { lock, owner } to create with, or sends the refusal and returns null. Without a cookie the account store
  // is never read; an invalid or expired cookie makes a guest room.
  const ownerForCreation = async (req, res, { kind, locked, lockParams }) => {
    if (!locked) {
      const account = await accountOf(req);
      return { lock: null, owner: { kind, accountId: account?.id ?? null } };
    }
    const lock = await lockForCreation(req, res, lockParams);
    return lock && { lock, owner: { kind, accountId: lock.ownerAccountId } };
  };

  const refuseCreation = (res, err) => {
    if (err.code === 'STORAGE_FAILURE') ctx.onStorageFailure(err);
    else if (!SOFT_CREATE_ERRORS.includes(err.code)) {
      console.error('[yjs] room creation failed', { code: err.code || 'UNKNOWN', err: err.message });
    }
    if (err.code === OWNED_ROOM_LIMIT_CODE) sendJson(res, HTTP.CONFLICT, OWNED_ROOM_LIMIT_BODY);
    else sendIfWritable(res, err.code === 'ROOM_CAPACITY' ? HTTP.CAPACITY : HTTP.UNAVAILABLE);
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
    const request = parseCreateBody(body);
    if (!request) { res.writeHead(HTTP.BAD_REQUEST); res.end(); return; }
    try {
      const creation = await ownerForCreation(req, res, request);
      if (!creation) return;
      sendJson(res, HTTP.CREATED, await registry.createRoom({ unavailable: ctx.unavailable(), ...creation }));
    } catch (err) {
      refuseCreation(res, err);
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

  // A renewal on the room-scoped path carries the room cookie; one valid at the current epoch proves membership.
  const isMember = (req, docName, renewalHandle) => renewalHandle !== null
    && sessions.authenticate(req, renewalHandle)?.docName === docName;

  const exchangeLocked = async (req, res, { clientIp, prefixed, renewalHandle }, docName, authKey) => {
    const lock = registry.lockFor(docName);
    if (lock === CORRUPT_LOCK) { sendIfWritable(res, HTTP.UNAVAILABLE); return; }
    if (authKey === undefined) {
      sendJson(res, HTTP.CONFLICT, { locked: true, salt: lock.salt, kdf: { ...LOCK_KDF } });
      return;
    }
    if (!parseAuthKey(authKey)) { sendIfWritable(res, HTTP.BAD_REQUEST); return; }
    // A member's stale key (the password changed) is still refused, but it is not a guess: never charge it.
    const verdict = verifier.check(clientIp, docName, lock, authKey, { countFailure: !isMember(req, docName, renewalHandle) });
    if (verdict === 'wrong') { sendIfWritable(res, HTTP.FORBIDDEN); return; }
    if (verdict !== 'ok') { sendIfWritable(res, HTTP.TOO_MANY, { 'retry-after': String(verdict.limited) }); return; }
    const account = await accountOf(req);
    // The room may have started deleting while the account was read: never mint a cookie for it.
    if (fence.isFenced(docName)) { sendIfWritable(res, HTTP.NOT_FOUND); return; }
    const { roomHandle, expiresAt, cookie } = issueSession(docName, prefixed, lock.keyEpoch);
    sendJson(res, HTTP.OK, {
      roomHandle, expiresAt,
      lock: {
        wrappedDek: lock.wrappedDek, wrapIv: lock.wrapIv, keyEpoch: lock.keyEpoch,
        lockRevision: lock.lockRevision, isOwner: account?.id === lock.ownerAccountId,
      },
    }, { 'set-cookie': cookie });
  };

  const exchangeNormal = (res, docName, prefixed) => {
    const { roomHandle, expiresAt, cookie } = issueSession(docName, prefixed, null);
    sendJson(res, HTTP.OK, { roomHandle, expiresAt }, { 'set-cookie': cookie });
  };

  const handleRoomSession = async (req, res, clientIp, prefixed, renewalHandle = null) => {
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
    // Taken in the same tick as the lookup: a room being deleted answers exactly like a missing one.
    const leave = docName ? fence.enter(docName) : null;
    if (!leave) { refuseFailedLookup(res, clientIp, HTTP.NOT_FOUND); return; }
    try {
      await exchange(req, res, { clientIp, prefixed, renewalHandle }, docName, body, hasAuthKeyField);
    } finally {
      leave();
    }
  };

  const exchange = async (req, res, request, docName, body, hasAuthKeyField) => {
    if (!buckets.takeSessionExchangeToken(request.clientIp)) {
      sendIfWritable(res, HTTP.TOO_MANY, { 'retry-after': RETRY_AFTER_SHORT_SECONDS });
      return;
    }
    if (!registry.isLocked(docName)) {
      if (hasAuthKeyField) sendIfWritable(res, HTTP.BAD_REQUEST);
      else exchangeNormal(res, docName, request.prefixed);
      return;
    }
    try {
      await exchangeLocked(req, res, request, docName, hasAuthKeyField ? body.authKey : undefined);
    } catch (err) {
      if (err.code === 'STORAGE_FAILURE') ctx.onStorageFailure(err);
      sendIfWritable(res, HTTP.UNAVAILABLE);
    }
  };

  const handle = (req, res, routePath, { clientIp, prefixed, hasQueryOrFragment }) => {
    if (req.method !== 'POST' || hasQueryOrFragment) return false;
    const renewal = RENEWAL_PATH.exec(routePath);
    if (routePath === '/api/rooms') void handleCreateRoom(req, res, clientIp);
    else if (routePath === ROOM_SESSION_PATH) void handleRoomSession(req, res, clientIp, prefixed);
    else if (renewal) void handleRoomSession(req, res, clientIp, prefixed, renewal[1]);
    else return false;
    return true;
  };

  return { handle, handleCreateRoom, handleRoomSession };
}
