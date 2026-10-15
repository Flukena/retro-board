// Yjs WebSocket relay with LevelDB persistence.
// Single source of truth for collaborative state.

import { envInt, envBool, readRelayConfig, MILLISECONDS_PER_SECOND, MILLISECONDS_PER_HOUR, MILLISECONDS_PER_DAY, ROOM_ID_ALLOCATION_ATTEMPTS, ROOM_BLOCK_TTL_MS, BLOCKED_ROOM_ENTRIES_PER_ACTIVE_ROOM, ROOM_HANDLE_RE, LARGE_UPDATE_LOG_THRESHOLD_BYTES, VOTE_EXPIRY_RETRY_INTERVAL_MS, MAINTENANCE_INTERVAL_MS, STORE_OPERATION_OVERHEAD_BYTES, MAX_HTTP_TARGET_CHARACTERS, CORS_PREFLIGHT_MAX_AGE_SECONDS, MAX_REQUESTS_PER_SOCKET, RETRY_AFTER_SHORT_SECONDS, RETRY_AFTER_LONG_SECONDS } from './src/relay-config.js';
import { evictOldestBucket, refillTokens, takeTrafficTokens, takeTrafficBudget, createTrafficBucket } from './src/relay-rate-bucket.js';
import { isExactAllowedOrigin, acceptCredentialOrigin, readJsonBody, sendJson, sendIfWritable, sendUpgradeRejection } from './src/relay-http.js';
import { roomLogId } from './src/relay-log-id.js';
import { createUploadState, scanUploadUsage, createRelayUploads, createImageReadBudgets, MIME_EXT, matchesMagicBytes, isStoredImageFilename, UPLOAD_STORAGE_FAILURE_EVENT, ROOM_UPLOAD_USAGE_META } from './src/relay-uploads.js';
import http from 'http';
import fs from 'fs';
import { createRequire } from 'module';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import {
  createRelayLifecycle, drainRelay, isRelayReady, STORAGE_FAILURE_LOG, STORAGE_FAILURE_REASON,
  UNHANDLED_REJECTION_EVENT, UNCAUGHT_EXCEPTION_EVENT,
} from './src/relay-lifecycle.js';
import { finalizeRelayVotes, maintainRoomVotes } from './src/relay-vote-maintenance.js';
import { createRejectionCounters } from './src/relay-rejection-counters.js';

// yjs, y-leveldb, and y-websocket must all resolve to the SAME yjs module
// instance. y-websocket's bin/utils.js (below) is CJS and does
// `require('yjs')`, which its package.json "exports" map sends to
// dist/yjs.cjs. If we instead `import * as Y from 'yjs'` here, the "exports"
// map sends that to dist/yjs.mjs — a separate module with separate Item/GC/
// etc. classes. Structs created by one instance fail `instanceof` checks in
// the other's merge/sync code, silently corrupting a doc's struct store; it
// surfaces later as "Cannot read properties of undefined (reading 'splice')"
// once enough concurrent edits force a merge over the tainted region.
// Routing everything through this one `require` keeps it a single instance.
const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const decoding = require('lib0/decoding');




const PORT = envInt('YJS_PORT', 1234, { min: 0, max: 65535 });
const HOST = process.env.YJS_HOST || '127.0.0.1';
if (!isIP(HOST)) throw new Error('YJS_HOST must be an IPv4 or IPv6 address');
const DB_DIR = process.env.YJS_DB_DIR || './yjs-db';
const ALLOW_LEGACY_ROOMS = envBool('YJS_ALLOW_LEGACY_ROOMS');
const ALLOW_LEGACY_URL_TOKENS = envBool('YJS_ALLOW_LEGACY_URL_TOKENS');
const ALLOW_INSECURE_HTTP = envBool('YJS_ALLOW_INSECURE_HTTP');
// Only enable this when the relay is reachable exclusively through a trusted
// reverse proxy. Otherwise a direct client can forge CF-Connecting-IP/XFF.
const TRUST_PROXY = envBool('YJS_TRUST_PROXY');

const BOARD_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
const ROOM_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TOKENIZED_ROOM_RE = /^board-[A-Za-z0-9_-]{3,32}-[A-Za-z0-9_-]{8,64}$/;
const LEGACY_ROOM_RE = /^board-[A-Za-z0-9_-]{3,32}$/;
const canonicalDocName = (code, token) => `yjs/board-${code}-${token}`;

// Accept the two paths WebsocketProvider uses in this repo:
//   dev  /board-<code>-<token>
//   prod /yjs/board-<code>-<token>
// Canonical persistence names retain the historic `yjs/` prefix. Arbitrary
// paths and tokenless rooms are rejected before a Y.Doc/LevelDB key exists.
const tokenDocNameFromRequest = (req) => {
  const target = req.url || '';
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 256
      || target.includes('?') || target.includes('#')) return null;
  const rawRoom = target.startsWith('/yjs/') ? target.slice('/yjs/'.length) : target.slice(1);
  if (TOKENIZED_ROOM_RE.test(rawRoom)) return `yjs/${rawRoom}`;
  if (ALLOW_LEGACY_ROOMS && LEGACY_ROOM_RE.test(rawRoom)) return `yjs/${rawRoom}`;
  return null;
};

const roomTargetFromRequest = (req) => {
  const target = req.url || '';
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 256
      || target.includes('#')) return null;
  const queryAt = target.indexOf('?');
  const path = queryAt < 0 ? target : target.slice(0, queryAt);
  const query = queryAt < 0 ? '' : target.slice(queryAt + 1);
  const match = path.match(/^\/(?:yjs\/)?rooms\/([A-Za-z0-9_-]{32})$/);
  if (!match) return null;
  if (query === '') return { handle: match[1], awarenessClientId: null };
  const awarenessMatch = query.match(/^awarenessId=(0|[1-9]\d{0,9})$/);
  if (!awarenessMatch) return null;
  const awarenessClientId = Number(awarenessMatch[1]);
  if (!Number.isSafeInteger(awarenessClientId) || awarenessClientId > 0xffffffff) return null;
  return { handle: match[1], awarenessClientId };
};

const normalizeIp = (value) => {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.startsWith('::ffff:') && isIP(candidate.slice(7)) === 4) candidate = candidate.slice(7);
  return isIP(candidate) ? candidate : null;
};

const clientIpFromRequest = (req) => {
  const socketIp = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  if (!TRUST_PROXY) return socketIp;
  const cfIp = normalizeIp(Array.isArray(req.headers['cf-connecting-ip'])
    ? req.headers['cf-connecting-ip'][0]
    : req.headers['cf-connecting-ip']);
  if (cfIp) return cfIp;
  const forwarded = Array.isArray(req.headers['x-forwarded-for'])
    ? req.headers['x-forwarded-for'][0]
    : req.headers['x-forwarded-for'];
  return normalizeIp(typeof forwarded === 'string' ? forwarded.split(',')[0] : '') || socketIp;
};

const directorySizeSync = (root) => {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { total += fs.statSync(path).size; } catch { /* raced with compaction */ }
      }
    }
  }
  return total;
};

const loadSessionSigningKey = () => {
  const fromEnv = process.env.YJS_SESSION_SECRET;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'utf8');
    if (key.byteLength < 32) throw new Error('YJS_SESSION_SECRET must contain at least 32 bytes');
    return key;
  }
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  const keyPath = join(DB_DIR, '.room-session-key');
  const readKey = () => {
    const encoded = fs.readFileSync(keyPath, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('invalid persisted room session key');
    const key = Buffer.from(encoded, 'base64url');
    if (key.byteLength !== 32) throw new Error('invalid persisted room session key');
    return key;
  };
  try {
    const key = readKey();
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort on mounted filesystems */ }
    return key;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const encoded = randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(keyPath, `${encoded}\n`, { flag: 'wx', mode: 0o600 });
    return Buffer.from(encoded, 'base64url');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return readKey();
  }
};

const SESSION_SIGNING_KEY = loadSessionSigningKey();

// y-websocket v1 ships server utils at bin/utils.js but doesn't expose them
// in its package "exports" map, so we import the file directly.
const here = dirname(fileURLToPath(import.meta.url));
const utilsPath = resolve(here, 'node_modules/y-websocket/bin/utils.js');
const { setupWSConnection, setPersistence, docs, getYDoc } = await import(utilsPath);

// y-websocket calls syncProtocol.readSyncMessage without the optional
// errorHandler, so corrupt-state errors fall through to a console.error that
// doesn't include the doc name — we never know which room broke. y-websocket
// uses CJS `require('y-protocols/sync')`, which resolves to dist/sync.cjs and
// is cached, so mutating exports on the cached module reaches that call site.
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const origReadSyncMessage = syncProtocol.readSyncMessage;
syncProtocol.readSyncMessage = (decoder, encoder, doc, origin) =>
  origReadSyncMessage(decoder, encoder, doc, origin, () => {
    console.warn('[yjs] invalid sync message', { docName: roomLogId(doc.name) });
    try { origin?.close?.(1008, 'invalid sync message'); } catch { /* already closing */ }
  });

// Comma-separated exact Origin allowlist. Empty is fail-closed unless the
// explicit dev-only YJS_ALLOW_INSECURE_HTTP flag is enabled, in which case
// only localhost/127.0.0.1 HTTP origins are accepted.
const ALLOWED_ORIGINS = (process.env.YJS_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const origin of ALLOWED_ORIGINS) {
  let parsed;
  try { parsed = new URL(origin); }
  catch { throw new Error('YJS_ALLOWED_ORIGINS must contain exact URL origins'); }
  const localHttp = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== origin
      || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash
      || (parsed.protocol !== 'https:' && !(ALLOW_INSECURE_HTTP && localHttp))) {
    throw new Error('YJS_ALLOWED_ORIGINS must contain exact HTTPS origins (or localhost HTTP in dev mode)');
  }
}

const relayConfig = readRelayConfig();
const {
  RL_MAX_MSGS,
  RL_REFILL_MSGS_PER_SEC,
  RL_MAX_BYTES,
  RL_REFILL_BYTES_PER_SEC,
  GLOBAL_RL_MAX_MSGS,
  GLOBAL_RL_REFILL_MSGS_PER_SEC,
  GLOBAL_RL_MAX_BYTES,
  GLOBAL_RL_REFILL_BYTES_PER_SEC,
  ROOM_RL_MAX_MSGS,
  ROOM_RL_REFILL_MSGS_PER_SEC,
  ROOM_RL_MAX_BYTES,
  ROOM_RL_REFILL_BYTES_PER_SEC,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  MAX_CONNECTIONS_PER_ROOM,
  MAX_ACTIVE_ROOMS,
  MAX_DOCUMENT_BYTES,
  MAX_ACTIVE_DOCUMENT_BYTES,
  MAX_UPDATE_BYTES,
  MAX_PENDING_STORE_OPS,
  MAX_PENDING_STORE_BYTES,
  MAX_DB_BYTES,
  MAX_WS_BUFFERED_BYTES,
  ROOM_COMPACT_AFTER_BYTES,
  ROOM_COMPACT_AFTER_UPDATES,
  ROOM_MAX_UNCOMPACTED_UPDATES,
  ROOM_COMPACTION_MIN_INTERVAL_MS,
  DOCUMENT_REMEASURE_MIN_INTERVAL_MS,
  ROOM_MAX_UNCOMPACTED_BYTES,
  MAX_STATE_VECTOR_BYTES,
  MAX_AWARENESS_MESSAGE_BYTES,
  MAX_AWARENESS_STATE_BYTES,
  MAX_AWARENESS_IDS_PER_CONNECTION,
  MAX_AWARENESS_CLIENTS_PER_ROOM,
  MAX_AWARENESS_ROOM_BYTES,
  SYNC_RESPONSE_MIN_CHARGE_BYTES,
  SYNC_RESPONSE_CONNECTION_BURST_BYTES,
  SYNC_RESPONSE_ROOM_BURST_BYTES,
  SYNC_RESPONSE_GLOBAL_BURST_BYTES,
  SYNC_RESPONSE_CONNECTION_BYTES_PER_SECOND,
  SYNC_RESPONSE_ROOM_BYTES_PER_SECOND,
  SYNC_RESPONSE_GLOBAL_BYTES_PER_SECOND,
  SYNC_RESPONSE_CONNECTION_BURST_MESSAGES,
  SYNC_RESPONSES_PER_CONNECTION_PER_MINUTE,
  WS_EGRESS_CONNECTION_BURST_BYTES,
  WS_EGRESS_ROOM_BURST_BYTES,
  WS_EGRESS_GLOBAL_BURST_BYTES,
  WS_EGRESS_CONNECTION_BYTES_PER_SECOND,
  WS_EGRESS_ROOM_BYTES_PER_SECOND,
  WS_EGRESS_GLOBAL_BYTES_PER_SECOND,
  WS_EGRESS_CONNECTION_BURST_MESSAGES,
  WS_EGRESS_CONNECTION_MESSAGES_PER_SECOND,
  WS_EGRESS_ROOM_BURST_MESSAGES,
  WS_EGRESS_ROOM_MESSAGES_PER_SECOND,
  WS_EGRESS_GLOBAL_BURST_MESSAGES,
  WS_EGRESS_GLOBAL_MESSAGES_PER_SECOND,
  MAX_REGISTERED_ROOMS,
  ROOM_SESSION_TTL_MS,
  MAX_API_BODY_BYTES,
  MAX_COOKIE_HEADER_BYTES,
  MAX_HEADER_BYTES,
  ROOM_CREATE_BURST,
  ROOM_CREATES_PER_HOUR,
  GLOBAL_ROOM_CREATE_BURST,
  GLOBAL_ROOM_CREATES_PER_MINUTE,
  SESSION_EXCHANGE_BURST,
  SESSION_EXCHANGES_PER_MINUTE,
  GLOBAL_SESSION_EXCHANGE_BURST,
  GLOBAL_SESSION_EXCHANGES_PER_MINUTE,
  SESSION_FAILURE_BURST,
  SESSION_FAILURES_PER_HOUR,
  WS_UPGRADE_IP_BURST,
  WS_UPGRADES_PER_IP_PER_MINUTE,
  WS_UPGRADE_ROOM_BURST,
  WS_UPGRADES_PER_ROOM_PER_MINUTE,
  GLOBAL_WS_UPGRADE_BURST,
  GLOBAL_WS_UPGRADES_PER_MINUTE,
  COLD_ROOM_OPEN_IP_BURST,
  COLD_ROOM_OPENS_PER_IP_PER_MINUTE,
  COLD_ROOM_OPEN_ROOM_BURST,
  COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE,
  GLOBAL_COLD_ROOM_OPEN_BURST,
  GLOBAL_COLD_ROOM_OPENS_PER_MINUTE,
  MAX_HTTP_REQUESTS,
  MAX_HTTP_REQUESTS_PER_IP,
  REQUEST_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  UPGRADE_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  HTTP_SHUTDOWN_GRACE_MS,
  UPLOADS_DIR,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_STORAGE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_ROOM_UPLOAD_BYTES,
  MAX_ROOM_UPLOAD_FILES,
  UPLOAD_RETENTION_DAYS,
  BUCKET_TTL_MS,
  MAX_BUCKETS,
} = relayConfig;
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const uploadState = createUploadState(relayConfig);
const initialUploadUsage = uploadState.initialUsage;
const uploadBuckets = uploadState.buckets;

const ldb = new LeveldbPersistence(DB_DIR);
let dbUsageBytes = directorySizeSync(DB_DIR);
let pendingStoreOps = 0;
let pendingStoreBytes = 0;

// Marks the one update we apply from disk during hydration, so the listener
// below can skip writing it straight back.
const HYDRATION_ORIGIN = Symbol('hydration');

const storageOperationError = (message) => Object.assign(new Error(message), {
  code: 'STORAGE_FAILURE',
});

// y-leveldb's _transact swallows every error: it catches, console.warn's the
// error, and resolves `null`. Its promises therefore NEVER reject, so a
// `.catch()` on any of these calls is dead code and a `.then()` runs even when
// the write failed. Each call has to be checked against its own success
// contract instead (verified in node_modules/y-leveldb/src/y-leveldb.js):
//   getYDoc       -> Y.Doc         | null on failure
//   storeUpdate   -> integer clock | null on failure
//   flushDocument -> undefined     | null on failure
const checkedGetYDoc = async (docName) => {
  const doc = await ldb.getYDoc(docName);
  if (!(doc instanceof Y.Doc)) throw storageOperationError(`getYDoc failed: ${roomLogId(docName)}`);
  return doc;
};

const checkedStoreUpdate = async (docName, update) => {
  const clock = await ldb.storeUpdate(docName, update);
  if (!Number.isInteger(clock)) throw storageOperationError(`storeUpdate failed: ${roomLogId(docName)}`);
  return clock;
};

const checkedClearDocument = async (docName) => {
  // Same contract as flushDocument: `undefined` on success, `null` on failure.
  const result = await ldb.clearDocument(docName);
  if (result === null) throw storageOperationError(`clearDocument failed: ${roomLogId(docName)}`);
};

const checkedFlushDocument = async (docName) => {
  // A successful flush resolves `undefined` — the callback y-leveldb passes to
  // _transact has no return statement — so only a strict `null` means failure.
  // `if (!result)` would treat every success as an error here.
  const result = await ldb.flushDocument(docName);
  if (result === null) throw storageOperationError(`flushDocument failed: ${roomLogId(docName)}`);
};

const checkedGetAllDocNames = async () => {
  const names = await ldb.getAllDocNames();
  if (!Array.isArray(names)) throw storageOperationError('getAllDocNames failed');
  return names;
};

const checkedGetMeta = async (docName, key) => {
  const value = await ldb.getMeta(docName, key);
  if (value === null) throw storageOperationError(`getMeta failed: ${roomLogId(docName)}`);
  return value;
};

const checkedSetMeta = async (docName, key, value) => {
  const result = await ldb.setMeta(docName, key, value);
  if (result === null) throw storageOperationError(`setMeta failed: ${roomLogId(docName)}`);
};

// One-shot wipe/retirement runs before room registration. If registration ran
// first, the old capability would remain in the in-memory maps and could mint
// a session that recreated the just-cleared document.
const WIPE = (process.env.YJS_WIPE_DOCS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const name of WIPE) {
  await checkedClearDocument(name);
  console.log('[yjs] wiped doc', roomLogId(name));
}

const ROOM_REGISTRATION_META = 'retro-room-registration-v1';
const ROOM_HANDLE_META = 'retro-room-handle-v1';
const registeredDocs = new Set();
const registeredDocDigests = new Map();
const registeredRoomsByHandle = new Map();
const registeredRoomHandlesByDoc = new Map();
const roomUploadUsage = new Map();
const pendingRoomHandles = new Set();
let pendingRoomCreations = 0;
const existingDocNames = new Set(await checkedGetAllDocNames());

const newUniqueRoomHandle = () => {
  for (let attempt = 0; attempt < ROOM_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
    const handle = randomBytes(24).toString('base64url');
    if (!registeredRoomsByHandle.has(handle) && !pendingRoomHandles.has(handle)) return handle;
  }
  throw Object.assign(new Error('room handle generation failed'), { code: 'SERVER_UNAVAILABLE' });
};

const roomHandleForDoc = (docName) => registeredRoomHandlesByDoc.get(docName) || null;

const docRegistrationDigest = (docName) => createHmac('sha256', SESSION_SIGNING_KEY)
  .update('room-registration\0')
  .update(docName)
  .digest();

const registerDocInMemory = (docName, handle) => {
  if (!ROOM_HANDLE_RE.test(handle)) throw new Error('invalid persisted room handle');
  const prior = registeredRoomsByHandle.get(handle);
  if (prior && prior !== docName) throw new Error('room handle collision');
  registeredDocs.add(docName);
  registeredDocDigests.set(docName, docRegistrationDigest(docName));
  registeredRoomsByHandle.set(handle, docName);
  registeredRoomHandlesByDoc.set(docName, handle);
  return handle;
};

const tokenizedExistingDocs = [...existingDocNames].filter((name) => (
  name.startsWith('yjs/') && TOKENIZED_ROOM_RE.test(name.slice('yjs/'.length))
));
for (const docName of tokenizedExistingDocs) {
  // A document is reachable only after room creation writes this final commit
  // marker. Older code adopted every token-shaped LevelDB key, which turned a
  // partial failed creation into a permanent room whose capability was never
  // delivered to a user. Leave incomplete documents quarantined instead.
  if ((await checkedGetMeta(docName, ROOM_REGISTRATION_META)) !== 1) {
    console.warn('[yjs] quarantined incomplete room', { docName: roomLogId(docName) });
    continue;
  }
  if (registeredDocs.size >= MAX_REGISTERED_ROOMS) {
    throw new Error('existing room count exceeds YJS_MAX_REGISTERED_ROOMS');
  }
  let roomHandle = await checkedGetMeta(docName, ROOM_HANDLE_META);
  if (!ROOM_HANDLE_RE.test(roomHandle || '')) {
    roomHandle = newUniqueRoomHandle();
    await checkedSetMeta(docName, ROOM_HANDLE_META, roomHandle);
  }
  registerDocInMemory(docName, roomHandle);
  const storedUsage = await checkedGetMeta(docName, ROOM_UPLOAD_USAGE_META);
  const persistedBytes = Number.isSafeInteger(storedUsage?.bytes) && storedUsage.bytes >= 0 ? storedUsage.bytes : 0;
  const persistedFiles = Number.isSafeInteger(storedUsage?.files) && storedUsage.files >= 0 ? storedUsage.files : 0;
  const actualUsage = initialUploadUsage.roomsByHandle.get(roomHandle) || { bytes: 0, files: 0 };
  const bytes = initialUploadUsage.complete ? actualUsage.bytes : persistedBytes;
  const files = initialUploadUsage.complete ? actualUsage.files : persistedFiles;
  if (initialUploadUsage.complete && (bytes !== persistedBytes || files !== persistedFiles)) {
    await checkedSetMeta(docName, ROOM_UPLOAD_USAGE_META, { bytes, files });
    console.warn('[yjs] reconciled room upload usage', {
      docName: roomLogId(docName),
      bytes,
      files,
    });
  }
  roomUploadUsage.set(docName, { bytes, files, reservedBytes: 0, active: 0 });
}
dbUsageBytes = directorySizeSync(DB_DIR);

// Flipped by the first storage failure. Existing clients are closed as well as
// refusing new upgrades: otherwise they would continue seeing edits that can
// no longer be persisted and lose them at the next restart.
let storageFailure = null;
// Set by the signal handlers at the bottom of this file; checked in the
// upgrade path so a draining process stops taking on new rooms.
let shuttingDown = false;
const markStorageFailure = (err) => {
  if (storageFailure) return;
  storageFailure = err;
  console.error(STORAGE_FAILURE_LOG, { errorId: roomLogId(String(err)) });
  shutdown(STORAGE_FAILURE_REASON, true);
};

const reconcileUploadUsage = async () => {
  const scanned = scanUploadUsage(relayConfig);
  uploadState.bytes = scanned.bytes;
  uploadState.files = scanned.files;
  if (!scanned.complete) return;
  for (const [roomHandle, docName] of registeredRoomsByHandle) {
    const room = roomUploadUsage.get(docName);
    if (!room) continue;
    const actual = scanned.roomsByHandle.get(roomHandle) || { bytes: 0, files: 0 };
    if (room.bytes === actual.bytes && room.files === actual.files) continue;
    room.bytes = actual.bytes;
    room.files = actual.files;
    await checkedSetMeta(docName, ROOM_UPLOAD_USAGE_META, actual);
    console.warn('[yjs] reconciled room upload usage', {
      docName: roomLogId(docName),
      bytes: actual.bytes,
      files: actual.files,
    });
  }
};

// `upperBytes` is a conservative in-memory document bound. It starts at the
// exact hydrated size and grows by each accepted update until a separately
// throttled measurement refreshes it. This avoids synchronously encoding a
// near-limit document on every tiny edit or every persistence compaction.
const roomUsage = new WeakMap();
const destroyedDocs = new WeakSet();
const capacityRejectedDocs = new WeakSet();
let activeDocumentBytes = 0;

const projectedActiveDocumentBytes = (ydoc, nextUpperBytes) => {
  const previous = roomUsage.get(ydoc);
  return Math.max(0, activeDocumentBytes - (previous?.upperBytes || 0) + nextUpperBytes);
};

const commitRoomUsage = (ydoc, nextUsage) => {
  activeDocumentBytes = projectedActiveDocumentBytes(ydoc, nextUsage.upperBytes);
  roomUsage.set(ydoc, nextUsage);
};

const tryCommitRoomUsage = (ydoc, nextUsage) => {
  if (projectedActiveDocumentBytes(ydoc, nextUsage.upperBytes) > MAX_ACTIVE_DOCUMENT_BYTES) {
    return false;
  }
  commitRoomUsage(ydoc, nextUsage);
  return true;
};

const releaseRoomUsage = (ydoc) => {
  const previous = roomUsage.get(ydoc);
  if (!previous) return;
  activeDocumentBytes = Math.max(0, activeDocumentBytes - previous.upperBytes);
  roomUsage.delete(ydoc);
};
// A small current Y.Doc can still have a very large LevelDB update log (for
// example repeated insert/delete cycles). Track that write amplification
// independently and compact while peers remain connected instead of waiting
// for the last socket to leave.
const roomPersistenceChurn = new Map();
const persistenceChurnFor = (docName) => {
  let state = roomPersistenceChurn.get(docName);
  if (!state) {
    state = {
      uncompactedBytes: 0,
      uncompactedUpdates: 0,
      compactionPromise: null,
      compactionTimer: null,
      compactionTimerDueAt: 0,
      // Permit one prompt compaction after process start, then enforce the
      // cooldown. Cold-open budgets bound how often an attacker can reset
      // this state by cycling rooms, while legitimate first edits stay fluid.
      lastCompactedAt: 0,
      remeasureRequested: false,
    };
    roomPersistenceChurn.set(docName, state);
  }
  return state;
};
const blockedRooms = new Map();
const MAX_BLOCKED_ROOM_ENTRIES = MAX_ACTIVE_ROOMS * BLOCKED_ROOM_ENTRIES_PER_ACTIVE_ROOM;

const blockRoom = (docName, ydoc, reason) => {
  const now = Date.now();
  blockedRooms.delete(docName);
  blockedRooms.set(docName, now + ROOM_BLOCK_TTL_MS);
  while (blockedRooms.size > MAX_BLOCKED_ROOM_ENTRIES) {
    blockedRooms.delete(blockedRooms.keys().next().value);
  }
  console.warn('[yjs] room policy close', { docName: roomLogId(docName), reason });
  if (ydoc) {
    for (const conn of ydoc.conns.keys()) {
      try { conn.close(1009, 'room resource limit'); } catch { /* already closing */ }
    }
  }
};

const isRoomBlocked = (docName) => {
  const expiresAt = blockedRooms.get(docName);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    blockedRooms.delete(docName);
    return false;
  }
  return true;
};

const armRoomCompactionTimer = (docName, churn, dueAt) => {
  if (churn.compactionTimer && churn.compactionTimerDueAt <= dueAt) return;
  if (churn.compactionTimer) clearTimeout(churn.compactionTimer);
  churn.compactionTimerDueAt = dueAt;
  churn.compactionTimer = setTimeout(() => {
    churn.compactionTimer = null;
    churn.compactionTimerDueAt = 0;
    scheduleRoomCompaction(docName);
  }, Math.max(1, dueAt - Date.now()));
  churn.compactionTimer.unref();
};

const scheduleRoomCompaction = (docName, { remeasure = false } = {}) => {
  const churn = persistenceChurnFor(docName);
  if (remeasure) churn.remeasureRequested = true;
  if (churn.compactionPromise || shuttingDown || storageFailure) return churn.compactionPromise;
  let activeDoc = docs.get(docName);
  if (!activeDoc) churn.remeasureRequested = false;

  const hasPersistenceWork = churn.uncompactedBytes > 0 || churn.uncompactedUpdates > 0;
  if (!hasPersistenceWork && !churn.remeasureRequested) return null;

  const now = Date.now();
  const compactionDueAt = churn.lastCompactedAt + ROOM_COMPACTION_MIN_INTERVAL_MS;
  const canCompact = hasPersistenceWork && now >= compactionDueAt;
  const usage = activeDoc ? roomUsage.get(activeDoc) : null;
  const remeasureDueAt = (usage?.lastMeasuredAt || now) + DOCUMENT_REMEASURE_MIN_INTERVAL_MS;
  const canRemeasure = Boolean(churn.remeasureRequested && activeDoc && now >= remeasureDueAt);

  if (!canCompact && !canRemeasure) {
    const nextDueAt = Math.min(
      hasPersistenceWork ? compactionDueAt : Number.POSITIVE_INFINITY,
      churn.remeasureRequested && activeDoc ? remeasureDueAt : Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(nextDueAt)) armRoomCompactionTimer(docName, churn, nextDueAt);
    return null;
  }

  if (churn.compactionTimer) clearTimeout(churn.compactionTimer);
  churn.compactionTimer = null;
  churn.compactionTimerDueAt = 0;
  const coveredBytes = canCompact ? churn.uncompactedBytes : 0;
  const coveredUpdates = canCompact ? churn.uncompactedUpdates : 0;

  // checkedFlushDocument enters y-leveldb's single serialized transaction
  // queue at this exact point. Later storeUpdate calls are queued behind it,
  // so subtracting only this captured generation cannot hide concurrent edits.
  // Exact in-memory measurement is independent and can run without a flush;
  // both expensive operations have their own per-room cooldown.
  const compaction = (canCompact ? checkedFlushDocument(docName) : Promise.resolve())
    .then(() => {
      if (canCompact) {
        churn.uncompactedBytes = Math.max(0, churn.uncompactedBytes - coveredBytes);
        churn.uncompactedUpdates = Math.max(0, churn.uncompactedUpdates - coveredUpdates);
        churn.lastCompactedAt = Date.now();
        dbUsageBytes = directorySizeSync(DB_DIR);
      }
      activeDoc = docs.get(docName);
      const currentUsage = activeDoc ? roomUsage.get(activeDoc) : null;
      const measurementNow = Date.now();
      if (churn.remeasureRequested && activeDoc && currentUsage
          && measurementNow - currentUsage.lastMeasuredAt >= DOCUMENT_REMEASURE_MIN_INTERVAL_MS) {
        try {
          const exactBytes = Y.encodeStateAsUpdate(activeDoc).byteLength;
          commitRoomUsage(activeDoc, {
            upperBytes: exactBytes,
            exactBytes,
            lastMeasuredAt: measurementNow,
          });
          churn.remeasureRequested = false;
          if (exactBytes > MAX_DOCUMENT_BYTES) {
            blockRoom(docName, activeDoc, 'document too large');
          } else if (activeDocumentBytes > MAX_ACTIVE_DOCUMENT_BYTES) {
            blockRoom(docName, activeDoc, 'active document capacity exceeded');
          }
          console.log('[yjs] document remeasured', {
            docName: roomLogId(docName),
            bytes: exactBytes,
          });
        } catch (err) {
          churn.remeasureRequested = false;
          blockRoom(docName, activeDoc, 'document size check failed');
          console.error('[yjs] document size check failed', {
            docName: roomLogId(docName),
            err: err.message,
          });
        }
      }
      if (!activeDoc) churn.remeasureRequested = false;
      if (canCompact) {
        console.log('[yjs] room compacted', {
          docName: roomLogId(docName),
          bytes: coveredBytes,
          updates: coveredUpdates,
        });
      }
    })
    .catch((err) => {
      markStorageFailure(err);
      console.error('[yjs] room compaction failed', { docName: roomLogId(docName), err: err.message });
    })
    .finally(() => {
      churn.compactionPromise = null;
      if (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES
          || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES
          || churn.remeasureRequested) {
        scheduleRoomCompaction(docName);
      }
    });
  churn.compactionPromise = compaction;
  return compaction;
};

const queueStoreUpdate = (docName, update, ydoc) => {
  const estimatedBytes = update.byteLength + STORE_OPERATION_OVERHEAD_BYTES;
  const churn = persistenceChurnFor(docName);
  if (churn.uncompactedBytes + estimatedBytes > ROOM_MAX_UNCOMPACTED_BYTES
      || churn.uncompactedUpdates + 1 > ROOM_MAX_UNCOMPACTED_UPDATES) {
    scheduleRoomCompaction(docName, { remeasure: true });
    blockRoom(docName, ydoc, 'room persistence backlog');
    return;
  }
  if (pendingStoreOps >= MAX_PENDING_STORE_OPS
      || pendingStoreBytes + estimatedBytes > MAX_PENDING_STORE_BYTES) {
    blockRoom(docName, ydoc, 'persistence backlog');
    return;
  }
  if (dbUsageBytes + pendingStoreBytes + estimatedBytes > MAX_DB_BYTES) {
    markStorageFailure(new Error('configured database quota exceeded'));
    return;
  }
  pendingStoreOps += 1;
  pendingStoreBytes += estimatedBytes;
  churn.uncompactedBytes += estimatedBytes;
  churn.uncompactedUpdates += 1;
  checkedStoreUpdate(docName, update)
    .then(() => {
      dbUsageBytes += estimatedBytes;
      if (update.byteLength > LARGE_UPDATE_LOG_THRESHOLD_BYTES) {
        console.log('[yjs] storeUpdate ok', { docName: roomLogId(docName), bytes: update.byteLength });
      }
    })
    .catch((err) => {
      markStorageFailure(err);
      console.error('[yjs] storeUpdate failed', { docName: roomLogId(docName), err: err.message });
    })
    .finally(() => {
      pendingStoreOps = Math.max(0, pendingStoreOps - 1);
      pendingStoreBytes = Math.max(0, pendingStoreBytes - estimatedBytes);
    });
  if (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES
      || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES) {
    scheduleRoomCompaction(docName, { remeasure: true });
  }
};

// The relay is the durable fallback for deadlines. Connected clients also
// finalize promptly for immediate UI feedback; this pass covers a room whose
// creator is gone and a room reopened after everyone was offline.
const finalizeExpiredVotes = (docName, ydoc, atTime = Date.now()) => {
  if (storageFailure || shuttingDown || isRoomBlocked(docName)) return;
  finalizeRelayVotes(ydoc, Y, atTime, () => {
    console.warn('[yjs] vote finalization skipped invalid geometry', { docName: roomLogId(docName) });
  });
};

const voteExpiryTimers = new WeakMap();
const armVoteExpiry = (docName, ydoc, deferExpired = false) => {
  const existing = voteExpiryTimers.get(ydoc);
  if (existing) clearTimeout(existing);
  voteExpiryTimers.delete(ydoc);
  if (destroyedDocs.has(ydoc) || storageFailure || shuttingDown) return;
  let earliest = Infinity;
  ydoc.getMap('items').forEach((yItem) => {
    if (!(yItem instanceof Y.Map) || yItem.get('type') !== 'zone') return;
    const deadline = yItem.get('voteTimer')?.endsAt;
    if (Number.isFinite(deadline)) earliest = Math.min(earliest, deadline);
  });
  if (!Number.isFinite(earliest)) return;
  // A malformed unfinalizable room must not create a zero-delay retry loop.
  const waitMs = earliest <= Date.now()
    ? (deferExpired ? VOTE_EXPIRY_RETRY_INTERVAL_MS : 1)
    : Math.max(1, Math.min(earliest - Date.now(), 2_147_483_647));
  const timer = setTimeout(() => {
    voteExpiryTimers.delete(ydoc);
    try { finalizeExpiredVotes(docName, ydoc); }
    catch (err) {
      console.error('[yjs] vote finalization failed', { docName: roomLogId(docName), err: err.message });
    }
    armVoteExpiry(docName, ydoc, true);
  }, waitMs);
  timer.unref();
  voteExpiryTimers.set(ydoc, timer);
};

// Hydration promise per room. y-websocket calls bindState without awaiting it
// and starts answering the sync protocol immediately, so a client connecting
// to a cold room is told "synced" against an empty doc while the LevelDB read
// is still in flight — it then sees a blank board and can write over real
// state. The upgrade handler awaits this before letting the socket through.
const roomReady = new WeakMap();

setPersistence({
  bindState: (docName, ydoc) => {
    // Aggregate accounting follows the Y.Doc lifetime. This covers normal
    // last-peer teardown as well as a failed first-upgrade cleanup exactly
    // once, without depending on each caller to mirror the bookkeeping.
    ydoc.on('destroy', () => {
      const timer = voteExpiryTimers.get(ydoc);
      if (timer) clearTimeout(timer);
      voteExpiryTimers.delete(ydoc);
      destroyedDocs.add(ydoc);
      releaseRoomUsage(ydoc);
    });
    ydoc.getMap('items').observeDeep((events) => {
      const itemMap = ydoc.getMap('items');
      if (events.some((event) => event.keysChanged?.has('voteTimer')
          || (event.target === itemMap && [...event.keysChanged].some((id) => (
            itemMap.get(id) instanceof Y.Map && itemMap.get(id).get('voteTimer')
          ))))) {
        armVoteExpiry(docName, ydoc);
      }
    });
    // The listener must be registered BEFORE the first await. y-websocket
    // calls bindState without awaiting it, so the room already accepts and
    // broadcasts client updates while the LevelDB read is in flight. Any
    // update applied during that gap was never handed to storeUpdate — it
    // reaches every peer, then vanishes on the next server restart.
    ydoc.on('update', (u, origin) => {
      if (origin === HYDRATION_ORIGIN) return;
      if (u.byteLength > MAX_UPDATE_BYTES) {
        blockRoom(docName, ydoc, 'update too large');
        return;
      }
      const usage = roomUsage.get(ydoc) || {
        upperBytes: 0,
        exactBytes: 0,
        lastMeasuredAt: Date.now(),
      };
      const nextUsage = {
        ...usage,
        upperBytes: usage.upperBytes + u.byteLength,
      };
      if (nextUsage.upperBytes > MAX_DOCUMENT_BYTES) {
        // Network updates are conservatively admitted before y-websocket
        // applies them. Reaching this branch means a non-network origin or an
        // unexpected encoding expansion escaped that guard; never turn it
        // into an attacker-controlled full-document encode loop.
        commitRoomUsage(ydoc, nextUsage);
        blockRoom(docName, ydoc, 'document conservative limit');
        return;
      }
      if (!tryCommitRoomUsage(ydoc, nextUsage)) {
        // A non-network update is already resident by this point. Account for
        // the temporary excess, then evict; network updates are rejected by
        // the protocol preflight before they can reach this branch.
        commitRoomUsage(ydoc, nextUsage);
        blockRoom(docName, ydoc, 'active document capacity exceeded');
        return;
      }
      queueStoreUpdate(docName, u, ydoc);
    });
    // y-websocket calls bindState as a floating promise (bin/utils.js:149) with
    // no .catch(), so anything thrown here becomes an unhandled rejection and
    // kills the process. Contain it: latch the failure and drain for restart.
    const ready = (async () => {
      try {
        const persisted = await checkedGetYDoc(docName);
        let persistedUpdate;
        try {
          persistedUpdate = Y.encodeStateAsUpdate(persisted);
        } finally {
          persisted.destroy();
        }
        if (persistedUpdate.byteLength > MAX_DOCUMENT_BYTES) {
          blockRoom(docName, ydoc, 'persisted document too large');
          return;
        }
        if (destroyedDocs.has(ydoc)) return;
        const hydratedUsage = {
          upperBytes: persistedUpdate.byteLength,
          exactBytes: persistedUpdate.byteLength,
          lastMeasuredAt: Date.now(),
        };
        if (!tryCommitRoomUsage(ydoc, hydratedUsage)) {
          // Aggregate pressure is transient. Reject this cold-room admission
          // without poisoning the room for the blocked-room TTL or declaring
          // the persistence layer globally unhealthy.
          capacityRejectedDocs.add(ydoc);
          console.warn('[yjs] active document capacity reached', {
            docName: roomLogId(docName),
          });
          return;
        }
        Y.applyUpdate(ydoc, persistedUpdate, HYDRATION_ORIGIN);
        try { finalizeExpiredVotes(docName, ydoc); }
        catch (err) {
          console.error('[yjs] vote finalization failed', { docName: roomLogId(docName), err: err.message });
        }
        armVoteExpiry(docName, ydoc);
      } catch (err) {
        markStorageFailure(err);
        console.error('[yjs] hydrate failed', { docName: roomLogId(docName), err: err.message });
      }
    })();
    // Runs before the IIFE's first await yields, so the entry is in place by
    // the time y-websocket's getYDoc returns this doc to the upgrade handler.
    roomReady.set(ydoc, ready);
    return ready;
  },
  // y-websocket invokes writeState in closeConn when the last client of a
  // room disconnects. Updates are already stored individually; consolidation
  // is thresholded and rate-limited separately so disconnect cannot force a
  // full-document merge.
  // Rethrowing here would also be fatal: the caller does
  // `writeState(...).then(() => doc.destroy())` with no .catch()
  // (bin/utils.js:205), so the rejection would go unhandled.
  writeState: async (docName) => {
    try {
      const churn = persistenceChurnFor(docName);
      // Every update is already durable through storeUpdate. Do not force a
      // full-room merge merely because the last peer disconnected: repeated
      // connect/disconnect would otherwise be an unbounded CPU amplifier.
      // If a threshold-triggered merge is already running, wait before the
      // library destroys its Y.Doc so our completion path cannot race it.
      if (churn.compactionPromise) await churn.compactionPromise;
    }
    catch (err) {
      markStorageFailure(err);
      console.error('[yjs] flushDocument failed', { docName: roomLogId(docName), err: err.message });
    }
  },
  provider: ldb,
});

// One-shot migration: rewrite legacy base64-embedded image `src` fields
// (from before image uploads existed) to server-hosted files, same env-var-
// triggered pattern as YJS_WIPE_DOCS above. Runs through this process's own
// already-open `ldb` — a second LeveldbPersistence against the same DB_DIR
// while this server holds it open conflicts (`Iterator is not open`).
// Idempotent: migrated items no longer have a `data:` src, so re-running is
// a no-op. Irreversible CRDT surgery — back up the yjs_data volume first.
const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;
const MIGRATE = (process.env.YJS_MIGRATE_DOCS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const name of MIGRATE) {
  const createdPaths = [];
  let updatePersisted = false;
  try {
    const roomHandle = roomHandleForDoc(name);
    const room = roomUploadUsage.get(name);
    if (!roomHandle || !room) throw new Error('migration target is not a registered tokenized room');
    const ydoc = await checkedGetYDoc(name);
    const before = Y.encodeStateAsUpdate(ydoc).byteLength;
    const pendingUpdates = [];
    ydoc.on('update', (u) => pendingUpdates.push(u));
    let rewritten = 0;
    let rewrittenBytes = 0;
    ydoc.transact(() => {
      ydoc.getMap('items').forEach((yItem) => {
        if (!(yItem instanceof Y.Map) || yItem.get('type') !== 'image') return;
        const src = yItem.get('src');
        const m = typeof src === 'string' && src.match(DATA_URL_RE);
        if (!m) return;
        const ext = MIME_EXT[m[1]];
        if (!ext) return;
        const bytes = Buffer.from(m[2], 'base64');
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOAD_BYTES
            || !matchesMagicBytes(bytes.subarray(0, 12), m[1])
            || uploadState.bytes + rewrittenBytes + bytes.byteLength > MAX_UPLOAD_STORAGE_BYTES
            || room.bytes + rewrittenBytes + bytes.byteLength > MAX_ROOM_UPLOAD_BYTES
            || uploadState.files + rewritten >= MAX_UPLOAD_FILES
            || room.files + rewritten >= MAX_ROOM_UPLOAD_FILES) return;
        const imageId = `${randomUUID()}.${ext}`;
        const filename = `${roomHandle}.${imageId}`;
        const path = join(UPLOADS_DIR, filename);
        fs.writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
        createdPaths.push(path);
        yItem.set('src', `/rooms/${roomHandle}/images/${imageId}`);
        rewritten += 1;
        rewrittenBytes += bytes.byteLength;
      });
    }, 'migration');
    for (const u of pendingUpdates) {
      await checkedStoreUpdate(name, u);
      updatePersisted = true;
    }
    if (rewritten) {
      room.bytes += rewrittenBytes;
      room.files += rewritten;
      await checkedSetMeta(name, ROOM_UPLOAD_USAGE_META, { bytes: room.bytes, files: room.files });
    }
    await checkedFlushDocument(name);
    uploadState.bytes += rewrittenBytes;
    uploadState.files += rewritten;
    const after = Y.encodeStateAsUpdate(ydoc).byteLength;
    console.log('[yjs] migrated doc', roomLogId(name), { rewritten, beforeBytes: before, afterBytes: after });
  } catch (err) {
    // Before the CRDT update is durable these files are unreachable and safe
    // to roll back. Once the update is stored they must remain so a retry can
    // reconcile metadata without breaking already-persisted image URLs.
    if (!updatePersisted) {
      for (const path of createdPaths) {
        try { fs.unlinkSync(path); }
        catch (cleanupErr) {
          if (cleanupErr.code !== 'ENOENT') {
            console.error('[yjs] migration rollback failed', { docName: roomLogId(name), err: cleanupErr.message });
          }
        }
      }
    }
    console.error('[yjs] migration failed', { docName: roomLogId(name), err: err.message });
    throw err;
  }
}

const BOARD_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const randomBoardCode = () => {
  const bytes = randomBytes(8);
  let code = '';
  for (const byte of bytes) code += BOARD_CODE_ALPHABET[byte % BOARD_CODE_ALPHABET.length];
  return code;
};
const randomRoomToken = () => randomBytes(24).toString('base64url');

const createRegisteredRoom = async () => {
  if (shuttingDown || storageFailure) throw Object.assign(new Error('service unavailable'), { code: 'SERVER_UNAVAILABLE' });
  if (registeredDocs.size + pendingRoomCreations >= MAX_REGISTERED_ROOMS) {
    throw Object.assign(new Error('room capacity reached'), { code: 'ROOM_CAPACITY' });
  }
  if (dbUsageBytes + pendingStoreBytes >= MAX_DB_BYTES) throw Object.assign(new Error('database capacity reached'), { code: 'ROOM_CAPACITY' });
  pendingRoomCreations += 1;
  let storeReserved = false;
  let estimatedBytes = 0;
  let roomHandle = null;
  let docName = null;
  try {
    let code;
    let token;
    for (let attempt = 0; attempt < ROOM_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
      code = randomBoardCode();
      token = randomRoomToken();
      docName = canonicalDocName(code, token);
      if (!existingDocNames.has(docName) && !registeredDocs.has(docName)) break;
      docName = null;
    }
    if (!docName) throw new Error('room id generation failed');
    roomHandle = newUniqueRoomHandle();
    pendingRoomHandles.add(roomHandle);

    const seed = new Y.Doc();
    seed.getMap('meta').set('__roomRegistered', 1);
    const update = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    estimatedBytes = update.byteLength + STORE_OPERATION_OVERHEAD_BYTES;
    if (pendingStoreOps >= MAX_PENDING_STORE_OPS
        || pendingStoreBytes + estimatedBytes > MAX_PENDING_STORE_BYTES
        || dbUsageBytes + pendingStoreBytes + estimatedBytes > MAX_DB_BYTES) {
      throw Object.assign(new Error('database capacity reached'), { code: 'ROOM_CAPACITY' });
    }
    pendingStoreOps += 1;
    pendingStoreBytes += estimatedBytes;
    storeReserved = true;
    await checkedStoreUpdate(docName, update);
    await checkedSetMeta(docName, ROOM_HANDLE_META, roomHandle);
    await checkedSetMeta(docName, ROOM_UPLOAD_USAGE_META, { bytes: 0, files: 0 });
    await checkedFlushDocument(docName);
    dbUsageBytes = directorySizeSync(DB_DIR);
    if (dbUsageBytes > MAX_DB_BYTES) {
      const err = Object.assign(new Error('database capacity reached'), { code: 'ROOM_CAPACITY' });
      markStorageFailure(err);
      throw err;
    }
    // Commit marker comes last. Startup ignores token-shaped documents that do
    // not have it, so a failed multi-step creation can never become reachable.
    await checkedSetMeta(docName, ROOM_REGISTRATION_META, 1);
    existingDocNames.add(docName);
    registerDocInMemory(docName, roomHandle);
    roomUploadUsage.set(docName, { bytes: 0, files: 0, reservedBytes: 0, active: 0 });
    return { code, token };
  } catch (err) {
    if (docName && !registeredDocs.has(docName)) {
      try {
        await checkedClearDocument(docName);
        existingDocNames.delete(docName);
        dbUsageBytes = directorySizeSync(DB_DIR);
      } catch (cleanupErr) {
        markStorageFailure(cleanupErr);
        console.error('[yjs] incomplete room rollback failed', {
          docName: roomLogId(docName),
          err: cleanupErr.message,
        });
      }
    }
    throw err;
  } finally {
    pendingRoomCreations = Math.max(0, pendingRoomCreations - 1);
    if (roomHandle) pendingRoomHandles.delete(roomHandle);
    if (storeReserved) {
      pendingStoreOps = Math.max(0, pendingStoreOps - 1);
      pendingStoreBytes = Math.max(0, pendingStoreBytes - estimatedBytes);
    }
  }
};

const fixedDigestEqual = (left, right) => (
  Buffer.isBuffer(left)
  && Buffer.isBuffer(right)
  && left.byteLength === right.byteLength
  && timingSafeEqual(left, right)
);
const DUMMY_REGISTRATION_DIGEST = randomBytes(32);

const registeredDocForCapability = (code, token) => {
  if (!BOARD_CODE_RE.test(code) || !ROOM_TOKEN_RE.test(token)) return null;
  const docName = canonicalDocName(code, token);
  const expected = registeredDocDigests.get(docName) || DUMMY_REGISTRATION_DIGEST;
  const candidate = docRegistrationDigest(docName);
  return fixedDigestEqual(candidate, expected) && registeredDocs.has(docName) ? docName : null;
};

const ROOM_COOKIE_NAME = 'rb_room_session';
const sessionSignature = (handle, expiresAt, docName) => createHmac('sha256', SESSION_SIGNING_KEY)
  .update('room-session-v1\0')
  .update(handle)
  .update('\0')
  .update(String(expiresAt))
  .update('\0')
  .update(docName)
  .digest();

const createSessionCookie = (handle, expiresAt, docName, path) => {
  const signature = sessionSignature(handle, expiresAt, docName).toString('base64url');
  const value = `v1.${handle}.${expiresAt}.${signature}`;
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  return `${ROOM_COOKIE_NAME}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${ALLOW_INSECURE_HTTP ? '' : '; Secure'}`;
};

const cookieValueFromRequest = (req) => {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER_BYTES) return null;
  let found = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== ROOM_COOKIE_NAME) continue;
    if (found !== null) return null;
    found = part.slice(separator + 1).trim();
  }
  return found;
};

const authenticatedDocFromRequest = (req, requestedHandle) => {
  if (!ROOM_HANDLE_RE.test(requestedHandle)) return null;
  const docName = registeredRoomsByHandle.get(requestedHandle);
  const value = cookieValueFromRequest(req);
  if (!docName || !value || value.length > 160) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, cookieHandle, rawExpiry, rawSignature] = parts;
  if (!ROOM_HANDLE_RE.test(cookieHandle)
      || !/^\d{13}$/.test(rawExpiry)
      || !/^[A-Za-z0-9_-]{43}$/.test(rawSignature)) return null;
  const expiresAt = Number(rawExpiry);
  const now = Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + ROOM_SESSION_TTL_MS) return null;
  const handleMatches = fixedDigestEqual(Buffer.from(cookieHandle), Buffer.from(requestedHandle));
  const suppliedSignature = Buffer.from(rawSignature, 'base64url');
  // Node's decoder accepts non-canonical final base64url characters whose
  // unused padding bits differ but decode to the same bytes. Reject those
  // alternate spellings so changing any cookie character is always tampering.
  if (suppliedSignature.toString('base64url') !== rawSignature) return null;
  const expectedSignature = sessionSignature(requestedHandle, expiresAt, docName);
  return handleMatches && fixedDigestEqual(suppliedSignature, expectedSignature)
    ? { docName, expiresAt }
    : null;
};


const rateBuckets = {
  roomCreate: new Map(),
  roomCreateGlobal: new Map(),
  sessionExchange: new Map(),
  sessionExchangeGlobal: new Map(),
  sessionFailure: new Map(),
  wsUpgradeIp: new Map(),
  wsUpgradeRoom: new Map(),
  wsUpgradeGlobal: new Map(),
  coldRoomOpenIp: new Map(),
  coldRoomOpenRoom: new Map(),
  coldRoomOpenGlobal: new Map(),
};
const getRateBucket = (map, key, burst, perHour) => {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket) {
    evictOldestBucket(map, MAX_BUCKETS);
    bucket = { tokens: burst, last: now, lastSeen: now };
    map.set(key, bucket);
  }
  bucket.tokens = refillTokens(bucket.tokens, burst, now - bucket.last, perHour, MILLISECONDS_PER_HOUR);
  bucket.last = now;
  bucket.lastSeen = now;
  return bucket;
};
const takeCreateToken = (ip) => {
  const ipBucket = getRateBucket(rateBuckets.roomCreate, ip, ROOM_CREATE_BURST, ROOM_CREATES_PER_HOUR);
  const globalBucket = getRateBucket(
    rateBuckets.roomCreateGlobal,
    'global',
    GLOBAL_ROOM_CREATE_BURST,
    GLOBAL_ROOM_CREATES_PER_MINUTE * 60,
  );
  if (ipBucket.tokens < 1 || globalBucket.tokens < 1) return false;
  ipBucket.tokens -= 1;
  globalBucket.tokens -= 1;
  return true;
};
const takeSessionExchangeToken = (ip) => {
  const ipBucket = getRateBucket(
    rateBuckets.sessionExchange,
    ip,
    SESSION_EXCHANGE_BURST,
    SESSION_EXCHANGES_PER_MINUTE * 60,
  );
  const globalBucket = getRateBucket(
    rateBuckets.sessionExchangeGlobal,
    'global',
    GLOBAL_SESSION_EXCHANGE_BURST,
    GLOBAL_SESSION_EXCHANGES_PER_MINUTE * 60,
  );
  if (ipBucket.tokens < 1 || globalBucket.tokens < 1) return false;
  ipBucket.tokens -= 1;
  globalBucket.tokens -= 1;
  return true;
};
const failureAttemptAvailable = (ip) => (
  getRateBucket(rateBuckets.sessionFailure, ip, SESSION_FAILURE_BURST, SESSION_FAILURES_PER_HOUR).tokens >= 1
);
const recordSessionFailure = (ip) => {
  const bucket = getRateBucket(rateBuckets.sessionFailure, ip, SESSION_FAILURE_BURST, SESSION_FAILURES_PER_HOUR);
  bucket.tokens = Math.max(0, bucket.tokens - 1);
};

const takeWsUpgradeToken = (ip, docName, coldRoom) => {
  const reservations = [
    getRateBucket(
      rateBuckets.wsUpgradeIp,
      ip,
      WS_UPGRADE_IP_BURST,
      WS_UPGRADES_PER_IP_PER_MINUTE * 60,
    ),
    getRateBucket(
      rateBuckets.wsUpgradeRoom,
      docName,
      WS_UPGRADE_ROOM_BURST,
      WS_UPGRADES_PER_ROOM_PER_MINUTE * 60,
    ),
    getRateBucket(
      rateBuckets.wsUpgradeGlobal,
      'global',
      GLOBAL_WS_UPGRADE_BURST,
      GLOBAL_WS_UPGRADES_PER_MINUTE * 60,
    ),
  ];
  if (coldRoom) {
    reservations.push(
      getRateBucket(
        rateBuckets.coldRoomOpenIp,
        ip,
        COLD_ROOM_OPEN_IP_BURST,
        COLD_ROOM_OPENS_PER_IP_PER_MINUTE * 60,
      ),
      getRateBucket(
        rateBuckets.coldRoomOpenRoom,
        docName,
        COLD_ROOM_OPEN_ROOM_BURST,
        COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE * 60,
      ),
      getRateBucket(
        rateBuckets.coldRoomOpenGlobal,
        'global',
        GLOBAL_COLD_ROOM_OPEN_BURST,
        GLOBAL_COLD_ROOM_OPENS_PER_MINUTE * 60,
      ),
    );
  }
  if (reservations.some((bucket) => bucket.tokens < 1)) return false;
  for (const bucket of reservations) bucket.tokens -= 1;
  return true;
};


const handleCreateRoom = async (req, res, clientIp) => {
  if (!acceptCredentialOrigin(req, res, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP)) return;
  res.setHeader('cache-control', 'no-store');
  if (shuttingDown || storageFailure) { res.writeHead(503); res.end(); return; }
  if (!takeCreateToken(clientIp)) { res.writeHead(429, { 'retry-after': RETRY_AFTER_LONG_SECONDS }); res.end(); return; }
  let body;
  try {
    body = await readJsonBody(req, MAX_API_BODY_BYTES, { allowEmpty: true });
  } catch (err) {
    sendIfWritable(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400);
    return;
  }
  if (Object.keys(body).length !== 0) { res.writeHead(400); res.end(); return; }
  try {
    const room = await createRegisteredRoom();
    sendJson(res, 201, room);
  } catch (err) {
    if (err.code === 'STORAGE_FAILURE') markStorageFailure(err);
    else if (!['ROOM_CAPACITY', 'SERVER_UNAVAILABLE'].includes(err.code)) {
      console.error('[yjs] room creation failed', { code: err.code || 'UNKNOWN', err: err.message });
    }
    sendIfWritable(res, err.code === 'ROOM_CAPACITY' ? 507 : 503);
  }
};

const handleRoomSession = async (req, res, clientIp, prefixed) => {
  if (!acceptCredentialOrigin(req, res, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP)) return;
  res.setHeader('cache-control', 'no-store');
  if (shuttingDown || storageFailure) { res.writeHead(503); res.end(); return; }
  let body;
  try { body = await readJsonBody(req, MAX_API_BODY_BYTES); }
  catch (err) {
    if (!failureAttemptAvailable(clientIp)) sendIfWritable(res, 429, { 'retry-after': RETRY_AFTER_LONG_SECONDS });
    else {
      recordSessionFailure(clientIp);
      sendIfWritable(res, err.code === 'BODY_TOO_LARGE' ? 413 : 400);
    }
    return;
  }
  const keys = Object.keys(body).sort();
  const wellFormed = keys.length === 2
    && keys[0] === 'code'
    && keys[1] === 'token'
    && typeof body.code === 'string'
    && typeof body.token === 'string';
  const docName = wellFormed ? registeredDocForCapability(body.code, body.token) : null;
  if (!docName) {
    if (!failureAttemptAvailable(clientIp)) sendIfWritable(res, 429, { 'retry-after': RETRY_AFTER_LONG_SECONDS });
    else {
      recordSessionFailure(clientIp);
      sendIfWritable(res, 404);
    }
    return;
  }
  if (!takeSessionExchangeToken(clientIp)) {
    sendIfWritable(res, 429, { 'retry-after': RETRY_AFTER_SHORT_SECONDS });
    return;
  }
  const roomHandle = roomHandleForDoc(docName);
  const expiresAt = Date.now() + ROOM_SESSION_TTL_MS;
  const cookiePath = `${prefixed ? '/yjs' : ''}/rooms/${roomHandle}`;
  sendJson(res, 200, { roomHandle, expiresAt }, {
    'set-cookie': createSessionCookie(roomHandle, expiresAt, docName, cookiePath),
  });
};


const globalTrafficLimits = {
  maxMessages: GLOBAL_RL_MAX_MSGS,
  messagesPerSecond: GLOBAL_RL_REFILL_MSGS_PER_SEC,
  maxBytes: GLOBAL_RL_MAX_BYTES,
  bytesPerSecond: GLOBAL_RL_REFILL_BYTES_PER_SEC,
};
const roomTrafficLimits = {
  maxMessages: ROOM_RL_MAX_MSGS,
  messagesPerSecond: ROOM_RL_REFILL_MSGS_PER_SEC,
  maxBytes: ROOM_RL_MAX_BYTES,
  bytesPerSecond: ROOM_RL_REFILL_BYTES_PER_SEC,
};
const globalTrafficBucket = createTrafficBucket(GLOBAL_RL_MAX_MSGS, GLOBAL_RL_MAX_BYTES);
const roomTrafficBuckets = new Map();

const imageReads = createImageReadBudgets(relayConfig);
const imageReadIpBuckets = imageReads.ipBuckets;
const imageReadRoomBuckets = imageReads.roomBuckets;

const uploads = createRelayUploads({
  config: relayConfig, state: uploadState, roomUploadUsage, imageReads,
  storage: { setMeta: checkedSetMeta },
  allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: ALLOW_INSECURE_HTTP,
});
uploadState.events.on(UPLOAD_STORAGE_FAILURE_EVENT, markStorageFailure);

const syncResponseConnectionLimits = {
  maxMessages: SYNC_RESPONSE_CONNECTION_BURST_MESSAGES,
  messagesPerSecond: SYNC_RESPONSES_PER_CONNECTION_PER_MINUTE / 60,
  maxBytes: SYNC_RESPONSE_CONNECTION_BURST_BYTES,
  bytesPerSecond: SYNC_RESPONSE_CONNECTION_BYTES_PER_SECOND,
};
const syncResponseRoomLimits = {
  maxMessages: 32,
  messagesPerSecond: 8,
  maxBytes: SYNC_RESPONSE_ROOM_BURST_BYTES,
  bytesPerSecond: SYNC_RESPONSE_ROOM_BYTES_PER_SECOND,
};
const syncResponseGlobalLimits = {
  maxMessages: 128,
  messagesPerSecond: 32,
  maxBytes: SYNC_RESPONSE_GLOBAL_BURST_BYTES,
  bytesPerSecond: SYNC_RESPONSE_GLOBAL_BYTES_PER_SECOND,
};
const globalSyncResponseBucket = createTrafficBucket(
  syncResponseGlobalLimits.maxMessages,
  syncResponseGlobalLimits.maxBytes,
);
const roomSyncResponseBuckets = new Map();

const egressConnectionLimits = {
  maxMessages: WS_EGRESS_CONNECTION_BURST_MESSAGES,
  messagesPerSecond: WS_EGRESS_CONNECTION_MESSAGES_PER_SECOND,
  maxBytes: WS_EGRESS_CONNECTION_BURST_BYTES,
  bytesPerSecond: WS_EGRESS_CONNECTION_BYTES_PER_SECOND,
};
const egressRoomLimits = {
  maxMessages: WS_EGRESS_ROOM_BURST_MESSAGES,
  messagesPerSecond: WS_EGRESS_ROOM_MESSAGES_PER_SECOND,
  maxBytes: WS_EGRESS_ROOM_BURST_BYTES,
  bytesPerSecond: WS_EGRESS_ROOM_BYTES_PER_SECOND,
};
const egressGlobalLimits = {
  maxMessages: WS_EGRESS_GLOBAL_BURST_MESSAGES,
  messagesPerSecond: WS_EGRESS_GLOBAL_MESSAGES_PER_SECOND,
  maxBytes: WS_EGRESS_GLOBAL_BURST_BYTES,
  bytesPerSecond: WS_EGRESS_GLOBAL_BYTES_PER_SECOND,
};
const globalEgressBucket = createTrafficBucket(
  egressGlobalLimits.maxMessages,
  egressGlobalLimits.maxBytes,
);
const roomEgressBuckets = new Map();
const MAX_WS_EGRESS_MESSAGE_BYTES = MAX_DOCUMENT_BYTES + MAX_AWARENESS_ROOM_BYTES + 64 * 1024;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

const protocolBytes = (data) => {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('non-binary WebSocket message');
};

// Fully validate the framing before y-websocket mutates either a Y.Doc or its
// Awareness maps. In particular, y-protocols otherwise applies awareness
// entries incrementally, so a truncated multi-entry frame can retain a valid
// prefix even though the rest of the frame is malformed.
const inspectProtocolMessage = (data) => {
  const bytes = protocolBytes(data);
  if (bytes.byteLength === 0) throw new Error('empty protocol message');
  const decoder = decoding.createDecoder(bytes);
  const messageType = decoding.readVarUint(decoder);
  if (messageType === MESSAGE_SYNC) {
    const syncType = decoding.readVarUint(decoder);
    if (syncType === SYNC_STEP_1) {
      const stateVector = decoding.readVarUint8Array(decoder);
      if (stateVector.byteLength > MAX_STATE_VECTOR_BYTES || decoding.hasContent(decoder)) {
        throw new Error('invalid sync state vector');
      }
      return { kind: 'sync-step-1' };
    }
    if (syncType === SYNC_STEP_2 || syncType === SYNC_UPDATE) {
      const update = decoding.readVarUint8Array(decoder);
      if (update.byteLength > MAX_UPDATE_BYTES || decoding.hasContent(decoder)) {
        throw new Error('invalid sync update');
      }
      return { kind: 'sync-update', updateBytes: update.byteLength };
    }
    throw new Error('unknown sync message');
  }
  if (messageType === MESSAGE_AWARENESS) {
    if (bytes.byteLength > MAX_AWARENESS_MESSAGE_BYTES) throw new Error('awareness frame too large');
    const update = decoding.readVarUint8Array(decoder);
    if (decoding.hasContent(decoder)) throw new Error('invalid awareness envelope');
    const inner = decoding.createDecoder(update);
    const count = decoding.readVarUint(inner);
    // A standard y-websocket client echoes the server's multi-client
    // awareness snapshot back over its socket. Bound the envelope by the
    // room-wide identity cap here; planAwarenessUpdate separately limits how
    // many previously-unowned identities this connection may actually claim.
    if (count < 1 || count > MAX_AWARENESS_CLIENTS_PER_ROOM) {
      throw new Error('invalid awareness entry count');
    }
    const seen = new Set();
    const entries = [];
    for (let index = 0; index < count; index += 1) {
      const clientId = decoding.readVarUint(inner);
      const clock = decoding.readVarUint(inner);
      const encodedState = decoding.readVarUint8Array(inner);
      if (!Number.isSafeInteger(clientId) || clientId < 0 || clientId > 0xffffffff
          || !Number.isSafeInteger(clock) || clock < 0
          || encodedState.byteLength > MAX_AWARENESS_STATE_BYTES
          || seen.has(clientId)) {
        throw new Error('invalid awareness entry');
      }
      seen.add(clientId);
      const state = JSON.parse(strictUtf8Decoder.decode(encodedState));
      if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
        throw new Error('invalid awareness state');
      }
      entries.push({ clientId, clock, stateIsNull: state === null, stateBytes: encodedState.byteLength });
    }
    if (decoding.hasContent(inner)) throw new Error('invalid awareness payload');
    return { kind: 'awareness', entries };
  }
  throw new Error('unknown protocol message');
};

const awarenessPolicies = new WeakMap();
const awarenessPolicyFor = (doc) => {
  let policy = awarenessPolicies.get(doc);
  if (!policy) {
    policy = {
      owners: new Map(),
      bytesById: new Map(),
      totalBytes: 0,
    };
    awarenessPolicies.set(doc, policy);
  }
  return policy;
};

const planAwarenessUpdate = (doc, conn, context, entries) => {
  const policy = awarenessPolicyFor(doc);
  const proposedIds = new Set(context.awarenessClientIds);
  const proposedOwners = new Map(policy.owners);
  const proposedBytes = new Map(policy.bytesById);
  let totalBytes = policy.totalBytes;
  const mutations = [];

  // Standard y-websocket clients echo server snapshots, BroadcastChannel
  // relays, and removal announcements over their own socket. Never let such
  // a relay overwrite another connection's first-claimed identity. An
  // already-unowned null is likewise a harmless stale removal; feeding it to
  // y-protocols would retain useless metadata. Drop the whole mixed frame so
  // upstream parsing remains atomic and cannot take ownership as a side
  // effect.
  for (const entry of entries) {
    if (entry.clientId === doc.awareness.clientID) throw new Error('reserved awareness id');
    if (context.expectedAwarenessClientId !== null
        && entry.clientId !== context.expectedAwarenessClientId) {
      return { dropFrame: true };
    }
    const owner = proposedOwners.get(entry.clientId);
    if ((owner && owner !== conn) || (!owner && entry.stateIsNull)) {
      return { dropFrame: true };
    }
  }

  for (const entry of entries) {
    const owner = proposedOwners.get(entry.clientId);
    const currentMeta = doc.awareness.meta.get(entry.clientId);
    const currentClock = currentMeta === undefined ? 0 : currentMeta.clock;
    const willApply = currentClock < entry.clock
      || (currentClock === entry.clock
        && entry.stateIsNull
        && doc.awareness.states.has(entry.clientId));
    if (!willApply) continue;

    if (!owner) {
      if (proposedIds.size >= MAX_AWARENESS_IDS_PER_CONNECTION
          || proposedOwners.size >= MAX_AWARENESS_CLIENTS_PER_ROOM) {
        throw new Error('awareness identity limit');
      }
      proposedIds.add(entry.clientId);
      proposedOwners.set(entry.clientId, conn);
    }

    const previousBytes = proposedBytes.get(entry.clientId) || 0;
    const nextBytes = entry.stateIsNull ? 0 : entry.stateBytes;
    totalBytes += nextBytes - previousBytes;
    if (totalBytes > MAX_AWARENESS_ROOM_BYTES) throw new Error('awareness room size limit');
    if (nextBytes > 0) proposedBytes.set(entry.clientId, nextBytes);
    else proposedBytes.delete(entry.clientId);
    mutations.push({ ...entry, nextBytes });
  }

  return {
    dropFrame: false,
    policy,
    proposedIds,
    proposedOwners,
    proposedBytes,
    totalBytes,
    mutations,
  };
};

const commitAwarenessPlan = (context, plan) => {
  if (plan.mutations.length === 0) return;
  context.awarenessClientIds = plan.proposedIds;
  plan.policy.owners = plan.proposedOwners;
  plan.policy.bytesById = plan.proposedBytes;
  plan.policy.totalBytes = plan.totalBytes;
};

const releaseAwarenessForConnection = (doc, conn, context) => {
  const policy = awarenessPolicies.get(doc);
  if (!policy) return;
  const remainingStates = [];
  for (const clientId of context.awarenessClientIds) {
    if (policy.owners.get(clientId) === conn && doc.awareness.states.has(clientId)) {
      remainingStates.push(clientId);
    }
  }
  // y-websocket stops tracking an ID after a null update and classifies a
  // later non-null update as `updated`, not `added`. Its own close hook can
  // therefore miss a re-added state. Remove any authoritative leftovers while
  // metadata still exists so the removal can be encoded and broadcast safely.
  if (remainingStates.length > 0) {
    awarenessProtocol.removeAwarenessStates(doc.awareness, remainingStates, null);
  }
  for (const clientId of context.awarenessClientIds) {
    if (policy.owners.get(clientId) !== conn) continue;
    policy.owners.delete(clientId);
    policy.totalBytes = Math.max(0, policy.totalBytes - (policy.bytesById.get(clientId) || 0));
    policy.bytesById.delete(clientId);
    // y-protocols intentionally retains clocks in `meta`. Once the owning
    // socket has been removed there is no identity continuity to preserve,
    // and retaining every reconnect forever is an avoidable memory leak.
    doc.awareness.meta.delete(clientId);
  }
};

const takeSyncResponseBudget = (docName, connectionBucket, estimatedBytes) => {
  let roomBucket = roomSyncResponseBuckets.get(docName);
  if (!roomBucket) {
    roomBucket = createTrafficBucket(
      syncResponseRoomLimits.maxMessages,
      syncResponseRoomLimits.maxBytes,
    );
    roomSyncResponseBuckets.set(docName, roomBucket);
  }
  const charge = Math.max(SYNC_RESPONSE_MIN_CHARGE_BYTES, estimatedBytes);
  return takeTrafficBudget([
    { bucket: connectionBucket, size: charge, limits: syncResponseConnectionLimits },
    { bucket: roomBucket, size: charge, limits: syncResponseRoomLimits },
    { bucket: globalSyncResponseBucket, size: charge, limits: syncResponseGlobalLimits },
  ]);
};

let wsConnectionCount = 0;
const wsConnectionsByIp = new Map();
const wsConnectionsByRoom = new Map();

const reserveWsConnection = (ip, docName) => {
  if (wsConnectionCount >= MAX_CONNECTIONS) return { status: 503 };
  if ((wsConnectionsByIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) return { status: 429 };
  if ((wsConnectionsByRoom.get(docName) || 0) >= MAX_CONNECTIONS_PER_ROOM) return { status: 429 };
  wsConnectionCount += 1;
  wsConnectionsByIp.set(ip, (wsConnectionsByIp.get(ip) || 0) + 1);
  wsConnectionsByRoom.set(docName, (wsConnectionsByRoom.get(docName) || 0) + 1);
  let released = false;
  return {
    status: 0,
    release() {
      if (released) return;
      released = true;
      wsConnectionCount = Math.max(0, wsConnectionCount - 1);
      const ipCount = (wsConnectionsByIp.get(ip) || 1) - 1;
      if (ipCount > 0) wsConnectionsByIp.set(ip, ipCount);
      else wsConnectionsByIp.delete(ip);
      const roomCount = (wsConnectionsByRoom.get(docName) || 1) - 1;
      if (roomCount > 0) wsConnectionsByRoom.set(docName, roomCount);
      else {
        wsConnectionsByRoom.delete(docName);
        roomTrafficBuckets.delete(docName);
        roomSyncResponseBuckets.delete(docName);
        roomEgressBuckets.delete(docName);
      }
    },
  };
};

let httpRequestCount = 0;
const httpRequestsByIp = new Map();
const reserveHttpRequest = (ip) => {
  if (httpRequestCount >= MAX_HTTP_REQUESTS) return { status: 503 };
  if ((httpRequestsByIp.get(ip) || 0) >= MAX_HTTP_REQUESTS_PER_IP) return { status: 429 };
  httpRequestCount += 1;
  httpRequestsByIp.set(ip, (httpRequestsByIp.get(ip) || 0) + 1);
  let released = false;
  return {
    status: 0,
    release() {
      if (released) return;
      released = true;
      httpRequestCount = Math.max(0, httpRequestCount - 1);
      const next = (httpRequestsByIp.get(ip) || 1) - 1;
      if (next > 0) httpRequestsByIp.set(ip, next);
      else httpRequestsByIp.delete(ip);
    },
  };
};

const rejectionCounters = createRejectionCounters((message, counts) => console.log(message, counts));
const rejectUpgrade = (socket, status) => {
  rejectionCounters.upgrade(status);
  sendUpgradeRejection(socket, status);
};

let maintenanceRunning = false;
const runMaintenance = async () => {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const now = Date.now();
    for (const [ip, bucket] of uploadBuckets) {
      if (now - bucket.lastSeen > BUCKET_TTL_MS) uploadBuckets.delete(ip);
    }
    for (const buckets of Object.values(rateBuckets)) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.lastSeen > BUCKET_TTL_MS) buckets.delete(key);
      }
    }
    for (const buckets of [imageReadIpBuckets, imageReadRoomBuckets]) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.lastSeen > BUCKET_TTL_MS) buckets.delete(key);
      }
    }
    for (const [docName, churn] of roomPersistenceChurn) {
      if (!churn.compactionPromise
          && (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES
            || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES)) {
        scheduleRoomCompaction(docName, { remeasure: true });
      }
    }
    maintainRoomVotes(docs, finalizeExpiredVotes, now, (docName, err) => {
      console.error('[yjs] vote finalization failed', { docName: roomLogId(docName), errorId: roomLogId(String(err)) });
    });
    for (const [name, expiresAt] of blockedRooms) {
      if (expiresAt <= now) blockedRooms.delete(name);
    }
    dbUsageBytes = directorySizeSync(DB_DIR);
    if (dbUsageBytes > MAX_DB_BYTES) markStorageFailure(new Error('configured database quota exceeded'));

    // Final image deletion is disabled by default. Operators may explicitly
    // configure retention after choosing a policy suitable for their boards.
    if (UPLOAD_RETENTION_DAYS > 0) {
      const cutoff = now - UPLOAD_RETENTION_DAYS * MILLISECONDS_PER_DAY;
      let removed = 0;
      const entries = await fs.promises.readdir(UPLOADS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !isStoredImageFilename(entry.name)) continue;
        const path = join(UPLOADS_DIR, entry.name);
        const stat = await fs.promises.stat(path);
        if (stat.mtimeMs >= cutoff) continue;
        await fs.promises.unlink(path);
        removed += 1;
      }
      if (removed) console.log('[yjs] upload retention sweep', { removed });
    }

    // Interrupted uploads are never published. Reap only our private temp-file
    // namespace, and only after it is older than twice the request deadline.
    const tempCutoff = now - REQUEST_TIMEOUT_MS * 2;
    const tempEntries = await fs.promises.readdir(UPLOADS_DIR, { withFileTypes: true });
    for (const entry of tempEntries) {
      if (!entry.isFile() || !/^\.upload-[a-f0-9-]+\.tmp$/.test(entry.name)) continue;
      const path = join(UPLOADS_DIR, entry.name);
      const stat = await fs.promises.stat(path);
      if (stat.mtimeMs < tempCutoff) await fs.promises.unlink(path);
    }
    if (uploadState.active === 0) await reconcileUploadUsage();
  } catch (err) {
    if (err?.code === 'STORAGE_FAILURE') markStorageFailure(err);
    console.error('[yjs] maintenance failed', { err: err.message });
  } finally {
    rejectionCounters.flush();
    maintenanceRunning = false;
  }
};
const maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
maintenanceTimer.unref();

const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
  rejectionCounters.observeResponse(res);
  const clientIp = clientIpFromRequest(req);
  const reservation = reserveHttpRequest(clientIp);
  if (reservation.status) {
    res.writeHead(reservation.status, { 'retry-after': RETRY_AFTER_SHORT_SECONDS });
    res.end();
    return;
  }
  res.once('finish', reservation.release);
  res.once('close', reservation.release);
  let pathname;
  let hasQueryOrFragment = false;
  try {
    if (!req.url || req.url.length > MAX_HTTP_TARGET_CHARACTERS) throw new Error('invalid request target');
    const parsed = new URL(req.url, 'http://localhost');
    ({ pathname } = parsed);
    hasQueryOrFragment = Boolean(parsed.search || parsed.hash);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  // Cloudflare Tunnel forwards the /yjs prefix through unstripped in prod;
  // capability, session and room-upload routes answer in bare and prefixed
  // forms so dev and production use the same server.
  const routePath = pathname.replace(/^\/yjs(?=\/|$)/, '') || '/';
  const prefixed = pathname === '/yjs' || pathname.startsWith('/yjs/');
  const uploadMatch = !hasQueryOrFragment
    ? routePath.match(/^\/rooms\/([A-Za-z0-9_-]{32})\/upload$/)
    : null;
  const roomImageMatch = !hasQueryOrFragment
    ? routePath.match(/^\/rooms\/([A-Za-z0-9_-]{32})\/images\/([a-f0-9-]+\.(?:png|jpe?g|webp|gif))$/)
    : null;
  // Readiness is separate from liveness: the process can be perfectly alive
  // while LevelDB is unwritable, and the catch-all below answers 200 either
  // way. An orchestrator polling this stops routing new traffic here instead
  // of accepting work the relay can no longer persist.
  if (req.method === 'GET' && routePath === '/readyz') {
    const ok = isRelayReady(storageFailure, shuttingDown);
    res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' });
    res.end(ok ? 'ready' : 'not ready');
    return;
  }
  if (req.method === 'OPTIONS'
      && !hasQueryOrFragment
      && (routePath === '/api/rooms' || routePath === '/api/room-session' || uploadMatch)) {
    if (!acceptCredentialOrigin(req, res, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP)) return;
    if (uploadMatch && !registeredRoomsByHandle.has(uploadMatch[1])) { res.writeHead(404); res.end(); return; }
    res.writeHead(204, {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'access-control-max-age': String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  if (req.method === 'POST' && !hasQueryOrFragment && routePath === '/api/rooms') {
    void handleCreateRoom(req, res, clientIp);
    return;
  }
  if (req.method === 'POST' && !hasQueryOrFragment && routePath === '/api/room-session') {
    void handleRoomSession(req, res, clientIp, prefixed);
    return;
  }
  if (req.method === 'POST' && uploadMatch) {
    if (!acceptCredentialOrigin(req, res, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP)) return;
    res.setHeader('cache-control', 'no-store');
    if (shuttingDown || storageFailure) { res.writeHead(503); res.end(); return; }
    if (!registeredRoomsByHandle.has(uploadMatch[1])) { res.writeHead(404); res.end(); return; }
    const session = authenticatedDocFromRequest(req, uploadMatch[1]);
    if (!session) { res.writeHead(401); res.end(); return; }
    void uploads.handleUpload(req, res, clientIp, session.docName, uploadMatch[1]);
    return;
  }
  if (req.method === 'GET' && roomImageMatch) {
    if (!registeredRoomsByHandle.has(roomImageMatch[1])) { res.writeHead(404); res.end(); return; }
    const session = authenticatedDocFromRequest(req, roomImageMatch[1]);
    if (!session) { res.writeHead(401); res.end(); return; }
    uploads.handleGetRoomImage(roomImageMatch[1], roomImageMatch[2], clientIp, res);
    return;
  }
  if (req.method === 'GET' && routePath.startsWith('/images/')) {
    uploads.handleGetLegacyImage(routePath.slice('/images/'.length), clientIp, res);
    return;
  }
  if (req.method === 'GET' && routePath === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('yjs-ws ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
server.maxConnections = MAX_CONNECTIONS + MAX_HTTP_REQUESTS;
server.on('clientError', (err, socket) => {
  const status = err.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
  if (socket.writable) rejectUpgrade(socket, status);
  else socket.destroy();
});

// maxPayload caps a single frame before `ws` assembles it, so an oversized
// frame is refused (close 1009) without ever reaching a 'message' listener.
// The token bucket alone cannot do this: its `return` only exits its own
// callback, and EventEmitter still delivers the frame to y-websocket's
// listener, which parses and applies it. RL_MAX_BYTES is the right ceiling —
// the bucket holds at most that many bytes, so a larger frame could never
// have been admitted anyway.
const wss = new WebSocketServer({ noServer: true, maxPayload: RL_MAX_BYTES });
wss.on('connection', (conn, req) => {
  const context = req.wsSecurityContext;
  if (!context?.docName) {
    conn.close(1011, 'server setup error');
    return;
  }
  const { docName, clientIp, expiresAt } = context;
  const doc = docs.get(docName);
  if (!doc) {
    conn.close(1011, 'server setup error');
    return;
  }
  context.awarenessClientIds = new Set();
  console.log('[yjs] conn open', { docName: roomLogId(docName), client: roomLogId(`ip:${clientIp}`), origin: req.headers.origin });
  conn.on('error', (err) => {
    console.warn('[yjs] conn error', { docName: roomLogId(docName), err: err.message, code: err.code });
    try { conn.terminate(); } catch { /* already closed */ }
  });
  if (expiresAt) {
    const sessionTimer = setTimeout(() => {
      try { conn.close(1008, 'session expired'); } catch { /* already closed */ }
    }, Math.max(1, expiresAt - Date.now()));
    sessionTimer.unref();
    conn.once('close', () => clearTimeout(sessionTimer));
  }
  // Token-bucket rate limit. Refill smoothly; over-budget closes the WS.
  const bucket = {
    msgs: RL_MAX_MSGS,
    bytes: RL_MAX_BYTES,
    last: Date.now(),
  };
  let limited = false;
  const takeTokens = (size) => {
    const now = Date.now();
    const dt = now - bucket.last;
    bucket.msgs = refillTokens(bucket.msgs, RL_MAX_MSGS, dt, RL_REFILL_MSGS_PER_SEC, MILLISECONDS_PER_SECOND);
    bucket.bytes = refillTokens(bucket.bytes, RL_MAX_BYTES, dt, RL_REFILL_BYTES_PER_SEC, MILLISECONDS_PER_SECOND);
    bucket.last = now;
    if (bucket.msgs < 1 || bucket.bytes < size) return false;
    bucket.msgs -= 1;
    bucket.bytes -= size;
    return true;
  };

  // y-websocket funnels sync replies, awareness snapshots, and broadcasts
  // through conn.send. Mediate that method before setup so one small inbound
  // request cannot enqueue unbounded full-document responses or multiply a
  // broadcast across peers without paying room/global egress budgets.
  const originalSend = conn.send.bind(conn);
  const connectionEgressBucket = createTrafficBucket(
    egressConnectionLimits.maxMessages,
    egressConnectionLimits.maxBytes,
  );
  const connectionSyncBucket = createTrafficBucket(
    syncResponseConnectionLimits.maxMessages,
    syncResponseConnectionLimits.maxBytes,
  );
  let egressLimited = false;
  conn.send = (data, ...args) => {
    const size = typeof data === 'string'
      ? Buffer.byteLength(data)
      : (data?.byteLength ?? data?.length ?? 0);
    let roomEgressBucket = roomEgressBuckets.get(docName);
    if (!roomEgressBucket) {
      roomEgressBucket = createTrafficBucket(
        egressRoomLimits.maxMessages,
        egressRoomLimits.maxBytes,
      );
      roomEgressBuckets.set(docName, roomEgressBucket);
    }
    const admitted = Number.isSafeInteger(size)
      && size >= 0
      && size <= MAX_WS_EGRESS_MESSAGE_BYTES
      && takeTrafficBudget([
        { bucket: connectionEgressBucket, size, limits: egressConnectionLimits },
        { bucket: roomEgressBucket, size, limits: egressRoomLimits },
        { bucket: globalEgressBucket, size, limits: egressGlobalLimits },
      ]);
    if (!admitted) {
      if (!egressLimited) {
        egressLimited = true;
        console.warn('[yjs] egress-limit close', { docName: roomLogId(docName), size });
        setImmediate(() => {
          try { conn.close(1008, 'egress rate-limit'); } catch { /* already closing */ }
        });
      }
      return undefined;
    }
    return originalSend(data, ...args);
  };

  const before = new Set(conn.listeners('message'));
  setupWSConnection(conn, req, { docName, gc: true });
  // setupWSConnection registers its close handler synchronously. Registering
  // after it guarantees states/controlled IDs are removed before we delete
  // y-protocols' otherwise-retained metadata and our byte accounting.
  conn.once('close', () => releaseAwarenessForConnection(doc, conn, context));
  const parsers = conn.listeners('message').filter((listener) => !before.has(listener));
  if (parsers.length !== 1) {
    console.error('[yjs] unexpected message-listener count', { docName: roomLogId(docName), count: parsers.length });
    conn.close(1011, 'server setup error');
    return;
  }
  const [parseYjsMessage] = parsers;
  conn.off('message', parseYjsMessage);
  conn.on('message', (data) => {
    if (limited) return;
    const size = data?.byteLength ?? data?.length ?? 0;
    let roomBucket = roomTrafficBuckets.get(docName);
    if (!roomBucket) {
      roomBucket = createTrafficBucket(ROOM_RL_MAX_MSGS, ROOM_RL_MAX_BYTES);
      roomTrafficBuckets.set(docName, roomBucket);
    }
    if (!takeTokens(size)
        || !takeTrafficTokens(globalTrafficBucket, size, globalTrafficLimits)
        || !takeTrafficTokens(roomBucket, size, roomTrafficLimits)
        || pendingStoreOps >= MAX_PENDING_STORE_OPS
        || pendingStoreBytes >= MAX_PENDING_STORE_BYTES) {
      limited = true;
      rejectionCounters.observeBacklog(pendingStoreOps, pendingStoreBytes, MAX_PENDING_STORE_OPS, MAX_PENDING_STORE_BYTES);
      console.warn('[yjs] rate-limit close', { docName: roomLogId(docName), origin: req.headers.origin, size });
      try { conn.close(1008, 'rate-limit'); } catch { /* already closing */ }
      return;
    }
    let inspection;
    let awarenessPlan = null;
    try {
      inspection = inspectProtocolMessage(data);
      if (inspection.kind === 'sync-update') {
        const usage = roomUsage.get(doc) || {
          upperBytes: 0,
          exactBytes: 0,
          lastMeasuredAt: Date.now(),
        };
        const churn = persistenceChurnFor(docName);
        const estimatedStoreBytes = inspection.updateBytes + STORE_OPERATION_OVERHEAD_BYTES;
        if (pendingStoreOps >= MAX_PENDING_STORE_OPS
            || pendingStoreBytes + estimatedStoreBytes > MAX_PENDING_STORE_BYTES) {
          rejectionCounters.storageBacklog();
          throw new Error('persistence backlog');
        }
        if (dbUsageBytes + pendingStoreBytes + estimatedStoreBytes > MAX_DB_BYTES) {
          markStorageFailure(new Error('configured database quota exceeded'));
          throw new Error('database capacity reached');
        }
        if (usage.upperBytes + inspection.updateBytes > MAX_DOCUMENT_BYTES) {
          scheduleRoomCompaction(docName, { remeasure: true });
          throw Object.assign(new Error('document conservative limit'), { closeCode: 1009 });
        }
        if (activeDocumentBytes + inspection.updateBytes > MAX_ACTIVE_DOCUMENT_BYTES) {
          scheduleRoomCompaction(docName, { remeasure: true });
          throw Object.assign(new Error('active document capacity reached'), { closeCode: 1009 });
        }
        if (churn.uncompactedUpdates + 1 > ROOM_MAX_UNCOMPACTED_UPDATES) {
          scheduleRoomCompaction(docName, { remeasure: true });
          throw new Error('room persistence compacting');
        }
        if (churn.uncompactedBytes + inspection.updateBytes + STORE_OPERATION_OVERHEAD_BYTES > ROOM_MAX_UNCOMPACTED_BYTES) {
          scheduleRoomCompaction(docName, { remeasure: true });
          throw new Error('room persistence compacting');
        }
      } else if (inspection.kind === 'sync-step-1') {
        const usage = roomUsage.get(doc) || {
          upperBytes: 0,
          exactBytes: 0,
          lastMeasuredAt: Date.now(),
        };
        const estimatedBytes = Math.min(
          MAX_DOCUMENT_BYTES,
          Math.max(usage.upperBytes, usage.exactBytes),
        );
        if (!takeSyncResponseBudget(docName, connectionSyncBucket, estimatedBytes)) {
          throw new Error('sync response rate-limit');
        }
      } else if (inspection.kind === 'awareness') {
        awarenessPlan = planAwarenessUpdate(doc, conn, context, inspection.entries);
        if (awarenessPlan.dropFrame) return;
      }
    } catch (err) {
      limited = true;
      console.warn('[yjs] protocol-policy close', {
        docName: roomLogId(docName),
        reason: err.message,
        size,
      });
      try { conn.close(err.closeCode || 1008, 'protocol policy'); } catch { /* already closing */ }
      return;
    }
    parseYjsMessage(data);
    if (awarenessPlan) commitAwarenessPlan(context, awarenessPlan);
    for (const peer of doc.conns.keys()) {
      if (peer.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
        try { peer.close(1008, 'slow consumer'); } catch { /* already closing */ }
      }
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  // Origin allowlist — set YJS_ALLOWED_ORIGINS in prod to lock the relay to
  // the public site. Browsers always send Origin on WS handshakes; non-browser
  // clients can spoof it but at least defeats opportunistic CSRF-style abuse
  // from a malicious site running a ws() in the user's tab.
  const origin = req.headers.origin || '';
  if (!isExactAllowedOrigin(origin, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP)) {
    rejectUpgrade(socket, 403);
    return;
  }
  const roomTarget = roomTargetFromRequest(req);
  const handle = roomTarget?.handle || null;
  const session = handle ? authenticatedDocFromRequest(req, handle) : null;
  let docName = session?.docName || null;
  let expiresAt = session?.expiresAt || null;
  if (handle && !registeredRoomsByHandle.has(handle)) {
    rejectUpgrade(socket, 404);
    return;
  }
  if (handle && !session) {
    rejectUpgrade(socket, 401);
    return;
  }
  if (!handle && !docName && ALLOW_LEGACY_URL_TOKENS) {
    const candidate = tokenDocNameFromRequest(req);
    if (candidate && (registeredDocs.has(candidate)
        || (ALLOW_LEGACY_ROOMS && existingDocNames.has(candidate)))) {
      docName = candidate;
      expiresAt = null;
    }
  }
  if (!docName) {
    rejectUpgrade(socket, 404);
    return;
  }
  // Reject known-doomed upgrades before getYDoc can allocate and hydrate a
  // room that will never receive a connection.
  if (shuttingDown || storageFailure || isRoomBlocked(docName)) {
    rejectUpgrade(socket, 503);
    return;
  }
  const coldRoom = !docs.has(docName);
  if (coldRoom && docs.size >= MAX_ACTIVE_ROOMS) {
    rejectUpgrade(socket, 503);
    return;
  }
  const clientIp = clientIpFromRequest(req);
  if (!takeWsUpgradeToken(clientIp, docName, coldRoom)) {
    rejectUpgrade(socket, 429);
    return;
  }
  const reservation = reserveWsConnection(clientIp, docName);
  if (reservation.status) {
    rejectUpgrade(socket, reservation.status);
    return;
  }
  socket.once('close', reservation.release);
  req.wsSecurityContext = {
    docName,
    clientIp,
    expiresAt,
    expectedAwarenessClientId: roomTarget?.awarenessClientId ?? null,
  };
  const upgradeTimer = setTimeout(() => {
    if (!socket.destroyed) socket.destroy();
  }, UPGRADE_TIMEOUT_MS);
  upgradeTimer.unref();
  // Use the same canonical name passed to setupWSConnection, so hydration and
  // the client attachment cannot diverge between bare and /yjs-prefixed paths.
  // getYDoc creates the room (running bindState) if this is the first client;
  // awaiting its hydration keeps the sync protocol from answering with an
  // empty doc. Rooms already in memory resolve immediately.
  const hadDoc = docs.has(docName);
  const doc = getYDoc(docName, true);
  const createdForUpgrade = !hadDoc && docs.get(docName) === doc;
  // `handleUpgrade` returns normally when it rejects a malformed handshake,
  // without invoking its callback. Retire a room created for such an upgrade
  // when the raw socket closes; a successful upgrade removes this listener
  // before normal WebSocket connection lifecycle handling takes over.
  const cleanupUnattachedUpgrade = () => {
    if (createdForUpgrade && docs.get(docName) === doc && doc.conns.size === 0) {
      docs.delete(docName);
      roomReady.delete(doc);
      doc.destroy();
    }
  };
  if (createdForUpgrade) socket.once('close', cleanupUnattachedUpgrade);
  Promise.resolve(roomReady.get(doc))
    .then(() => {
      if (socket.destroyed) throw new Error('socket closed');
      if (shuttingDown) throw new Error('shutting down');
      if (storageFailure) throw storageFailure;
      if (capacityRejectedDocs.has(doc)) throw new Error('active document capacity reached');
      if (isRoomBlocked(docName)) throw new Error('room unavailable');
      wss.handleUpgrade(req, socket, head, (ws) => {
        clearTimeout(upgradeTimer);
        socket.off('close', cleanupUnattachedUpgrade);
        wss.emit('connection', ws, req);
      });
    })
    .catch((err) => {
      clearTimeout(upgradeTimer);
      socket.off('close', cleanupUnattachedUpgrade);
      // A rejected first upgrade has no closeConn call to retire its room.
      // Match both identity and zero connections so an existing/replaced room,
      // or one another upgrade successfully attached to, is never destroyed.
      if (createdForUpgrade && docs.get(docName) === doc && doc.conns.size === 0) {
        docs.delete(docName);
        roomReady.delete(doc);
        doc.destroy();
      }
      console.error('[yjs] upgrade failed', { docName: roomLogId(docName), err: err.message });
      if (!socket.destroyed) rejectUpgrade(socket, 503);
    });
});

// Graceful drain. Without this, `docker stop` kills the process while
// storeUpdate calls are still in flight, so the last edits before a deploy
// can be lost even though every client saw them.
const lifecycle = createRelayLifecycle({
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  log: console,
  errorId: (err) => roomLogId(String(err)),
  exit: (code) => process.exit(code),
  setExitCode: (code) => { process.exitCode = code; },
  onStart: (signal) => {
    shuttingDown = true;
    clearInterval(maintenanceTimer);
    console.log('[yjs] draining', { signal, rooms: docs.size });
  },
  drain: async () => {
    const roomCount = docs.size;
    await drainRelay({
      server, clients: wss.clients, httpGraceMs: HTTP_SHUTDOWN_GRACE_MS,
      isBusy: () => maintenanceRunning || pendingRoomCreations > 0 || uploadState.active > 0 || pendingStoreOps > 0,
      compactions: () => [...roomPersistenceChurn.values()].map((churn) => churn.compactionPromise).filter(Boolean),
      destroyStorage: () => ldb.destroy(),
    });
    console.log('[yjs] drained', { rooms: roomCount });
  },
});
const shutdown = lifecycle.shutdown;
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on(UNHANDLED_REJECTION_EVENT, (err) => { lifecycle.fatal(UNHANDLED_REJECTION_EVENT, err); });
process.on(UNCAUGHT_EXCEPTION_EVENT, (err) => { lifecycle.fatal(UNCAUGHT_EXCEPTION_EVENT, err); });

server.listen(PORT, HOST, () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : PORT;
  const displayHost = HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`[yjs] listening on ws://${displayHost}:${boundPort}  (db: ${DB_DIR})`);
  if (ALLOWED_ORIGINS.length) {
    console.log(`[yjs] origin allowlist: ${ALLOWED_ORIGINS.join(', ')}`);
  } else if (ALLOW_INSECURE_HTTP) {
    console.warn('[yjs] dev HTTP mode: accepting localhost origins only');
  } else {
    console.warn('[yjs] no allowed origins configured; APIs and WebSockets are fail-closed');
  }
  if (ALLOW_LEGACY_ROOMS) console.warn('[yjs] legacy tokenless rooms enabled');
  if (ALLOW_LEGACY_URL_TOKENS) console.warn('[yjs] legacy URL-token WebSockets enabled');
  if (TRUST_PROXY) console.warn('[yjs] trusted proxy headers enabled; block direct origin access');
  if (dbUsageBytes > MAX_DB_BYTES) markStorageFailure(new Error('configured database quota exceeded'));
});
