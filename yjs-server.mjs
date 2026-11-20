// Yjs WebSocket relay with LevelDB persistence.
// Single source of truth for collaborative state.
import { createRelayLateBindings, createStorageFailureHandler } from './src/server/relay-late-bindings.js';
import { createWsConnectionHandler } from './src/server/relay-ws-connection.js';
import { createRoomPolicy, createRoomState } from './src/server/relay-room-state.js';
import { createRelayPersistence } from './src/server/relay-persistence.js';
import { createRelayRuntime, logRelayBanner } from './src/server/relay-runtime.js';
import { createHttpDispatch } from './src/server/relay-http-dispatch.js';
import { createUpgradeHandler } from './src/server/relay-upgrade.js';
import { createWsAdmission } from './src/server/relay-ws-admission.js';
import { createAwarenessPolicy } from './src/server/relay-awareness-policy.js';
import { createVoteExpiry } from './src/server/relay-vote-expiry.js';
import { createRoomAccounting } from './src/server/relay-room-accounting.js';
import { createAdmissionLimits } from './src/server/relay-admission-limits.js';
import { readAllowedOrigins } from './src/server/relay-origins.js';
import { clientIpFromRequest as requestClientIp } from './src/server/relay-client-ip.js';
import { RoomSessions } from './src/server/relay-session.js';
import { RelayProtocol } from './src/server/relay-protocol.js';
import { envInt, envBool, readGuestSweepTiming, readRelayConfig, MAINTENANCE_INTERVAL_MS, MAX_REQUESTS_PER_SOCKET, RETRY_AFTER_LONG_SECONDS } from './src/server/relay-config.js';
import { RelayWsTraffic } from './src/server/relay-ws-traffic.js';
import { createE2ERelay } from './src/server/e2e-relay.js';
import { E2ERoomLog } from './src/server/e2e-room-log.js';
import { migrateLegacyImages } from './src/server/legacy-image-migration.js';
import { E2EBlobStore } from './src/server/e2e-blob-store.js';
import { createE2EBlobs } from './src/server/e2e-blobs.js';
import { sendUpgradeRejection } from './src/server/relay-http.js';
import { roomLogId } from './src/server/relay-log-id.js';
import { createUploadState, scanUploadUsage, createRelayUploads, createImageReadBudgets, UPLOAD_STORAGE_FAILURE_EVENT, ROOM_UPLOAD_USAGE_META } from './src/server/relay-uploads.js';
import http from 'http';
import fs from 'fs';
import { randomBytes } from 'crypto';
import { isIP } from 'net';
import { WebSocketServer } from 'ws';
import {
  createRelayLifecycle, drainRelay, isRelayReady,
  UNHANDLED_REJECTION_EVENT, UNCAUGHT_EXCEPTION_EVENT,
} from './src/server/relay-lifecycle.js';
import { RoomRegistry, REGISTRY_STORAGE_FAILURE_EVENT } from './src/server/relay-room-registry.js';
import { RelayMaintenance, MAINTENANCE_STORAGE_FAILURE_EVENT } from './src/server/relay-maintenance.js';
import { directorySizeSync, loadSessionSigningKey, loadSigningKey, ACCOUNT_SESSION_KEY } from './src/server/relay-local-files.js';
import { AccountStore, ACCOUNT_STORAGE_FAILURE_EVENT } from './src/server/account-store.js';
import { AccountSessions } from './src/server/auth-session.js';
import { FlowLedger } from './src/server/auth-google.js';
import { createAuthRoutes, enabledOAuthConfig } from './src/server/auth-routes.js';
import { publicRelayEnvironment, isPublicWallEnabled, PUBLIC_SNAPSHOT_DIRECTORY } from './src/server/public-wall-config.js';
import { claimPublicDirectory, PublicWallHistory } from './src/server/public-wall-history.js';
import { provisionPublicWall, RelayPublicWall, retainPublicDocument } from './src/server/relay-public-wall.js';
import { createRejectionCounters } from './src/server/relay-rejection-counters.js';
import { startMaintainer } from './src/server/maintainer-server.js';
import { maintainerSnapshot } from './src/server/maintainer-snapshot.js';
import { checkedStorage, durableMetaBatch } from './src/server/relay-storage.js';
import { RoomLockVerifier } from './src/server/room-lock.js';
import { CORRUPT_LOCK } from './src/server/room-lock-record.js';
import { createRoomSessionRoutes } from './src/server/room-session-routes.js';
import { createRoomLockRoutes } from './src/server/room-lock-routes.js';
import { GuestRoomSweep } from './src/server/guest-room-sweep.js';
import { RoomFence } from './src/server/room-fence.js';
import { DeletionJournal, RoomDeletion, createRoomFileRemover } from './src/server/room-deletion.js';
import { createPlainRoomTeardown } from './src/server/plain-room-teardown.js';
import { createPlainUpgrades } from './src/server/plain-upgrade.js';
import { createHttpRequestSlots } from './src/server/relay-http-slots.js';
import { createAccountRoomRoutes } from './src/server/account-room-routes.js';
import { createRoomSummaryReader, createRoomTitleWriter } from './src/server/room-title-writer.js';
import { orphanRoomsOfDeletedAccounts } from './src/server/room-orphaning.js';

const bindings = createRelayLateBindings();
const { Y, LeveldbPersistence, loadUtils } = createRelayRuntime();

Object.assign(process.env, publicRelayEnvironment(process.env));
const PUBLIC_WALL = isPublicWallEnabled(process.env);
const PORT = envInt('YJS_PORT', 1234, { min: 0, max: 65535 });
const HOST = process.env.YJS_HOST || '127.0.0.1';
if (!isIP(HOST)) throw new Error('YJS_HOST must be an IPv4 or IPv6 address');
const DB_DIR = process.env.YJS_DB_DIR || './yjs-db';
const databaseSizeBytes = () => directorySizeSync(DB_DIR, { excludedRootDirectories: PUBLIC_WALL ? [PUBLIC_SNAPSHOT_DIRECTORY] : [] });
if (PUBLIC_WALL) claimPublicDirectory(DB_DIR);
const ALLOW_LEGACY_ROOMS = envBool('YJS_ALLOW_LEGACY_ROOMS');
const ALLOW_LEGACY_URL_TOKENS = envBool('YJS_ALLOW_LEGACY_URL_TOKENS');
const ALLOW_INSECURE_HTTP = envBool('YJS_ALLOW_INSECURE_HTTP');
// Only enable this when the relay is reachable exclusively through a trusted
// reverse proxy. Otherwise a direct client can forge CF-Connecting-IP/XFF.
const TRUST_PROXY = envBool('YJS_TRUST_PROXY');

const clientIpFromRequest = req => requestClientIp(req, TRUST_PROXY);

const SESSION_SIGNING_KEY = loadSessionSigningKey(DB_DIR);

const { setupWSConnection, setPersistence, docs, getYDoc, awarenessProtocol } = await loadUtils();

// Comma-separated exact Origin allowlist. Empty is fail-closed unless the
// explicit dev-only YJS_ALLOW_INSECURE_HTTP flag is enabled, in which case
// only localhost/127.0.0.1 HTTP origins are accepted.
const ALLOWED_ORIGINS = readAllowedOrigins(process.env.YJS_ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP);

const relayConfig = readRelayConfig();
fs.mkdirSync(relayConfig.UPLOADS_DIR, { recursive: true });
const uploadState = createUploadState(relayConfig);
const initialUploadUsage = uploadState.initialUsage;
const uploadBuckets = uploadState.buckets;

const ldb = new LeveldbPersistence(DB_DIR);
const accounting = createRoomAccounting({ databaseSizeBytes, MAX_DB_BYTES: relayConfig.MAX_DB_BYTES, MAX_PENDING_STORE_OPS: relayConfig.MAX_PENDING_STORE_OPS, MAX_PENDING_STORE_BYTES: relayConfig.MAX_PENDING_STORE_BYTES, MAX_ACTIVE_DOCUMENT_BYTES: relayConfig.MAX_ACTIVE_DOCUMENT_BYTES });
const { roomUsage } = accounting;

// Marks the one update we apply from disk during hydration, so the listener
// below can skip writing it straight back.
const HYDRATION_ORIGIN = Symbol('hydration');

const {
  getYDoc: checkedGetYDoc, storeUpdate: checkedStoreUpdate, clearDocument: checkedClearDocument,
  flushDocument: checkedFlushDocument, getAllDocNames: checkedGetAllDocNames, getMeta: checkedGetMeta, setMeta: checkedSetMeta,
} = checkedStorage(ldb, Y);

// One-shot wipe/retirement runs before room registration. If registration ran
// first, the old capability would remain in the in-memory maps and could mint
// a session that recreated the just-cleared document.
const WIPE = (process.env.YJS_WIPE_DOCS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
for (const name of WIPE) {
  await checkedClearDocument(name);
  console.log('[yjs] wiped doc', roomLogId(name));
}

const registryPersistence = {
  getAllDocNames: checkedGetAllDocNames,
  getMeta: checkedGetMeta,
  setMeta: checkedSetMeta,
  storeUpdate: checkedStoreUpdate,
  flushDocument: checkedFlushDocument,
  clearDocument: checkedClearDocument,
  durableMetaBatch: (docName, ops) => durableMetaBatch(ldb, docName, ops),
  hasCapacity: accounting.hasCapacity,
  reserveStore: accounting.reserveStore,
  measureDatabase: accounting.measureDatabase,
};
const roomRegistry = new RoomRegistry({
  persistence: registryPersistence, Y, maxRooms: relayConfig.MAX_REGISTERED_ROOMS,
  maxDatabaseBytes: relayConfig.MAX_DB_BYTES, signingKey: SESSION_SIGNING_KEY,
});
// Rooms in the deletion journal are fenced and never registered; recovery below finishes them.
const roomFence = new RoomFence();
const deletionJournal = new DeletionJournal(ldb);
const journaledDeletions = await deletionJournal.load();
await roomRegistry.hydrate(initialUploadUsage, new Set(journaledDeletions.keys()));
const publicWall = PUBLIC_WALL ? new RelayPublicWall(await provisionPublicWall(roomRegistry)) : null;
const publicHistory = PUBLIC_WALL ? new PublicWallHistory(DB_DIR, Y) : null;
const { registeredRoomsByHandle, roomUploadUsage } = roomRegistry;
const roomHandleForDoc = (docName) => roomRegistry.roomHandleForDoc(docName);

const markStorageFailure = createStorageFailureHandler({ accounting, bindings });

roomRegistry.on(REGISTRY_STORAGE_FAILURE_EVENT, markStorageFailure);
const accountStore = new AccountStore({ ldb, getMeta: checkedGetMeta, hasCapacity: registryPersistence.hasCapacity });
accountStore.on(ACCOUNT_STORAGE_FAILURE_EVENT, markStorageFailure);
await orphanRoomsOfDeletedAccounts({ registry: roomRegistry, accounts: accountStore, onStorageFailure: markStorageFailure });

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

const roomPolicy = createRoomPolicy(relayConfig);
const { destroyedDocs, capacityRejectedDocs, blockedRooms, blockRoom, isRoomBlocked } = roomPolicy;

const { roomPersistenceChurn, persistenceChurnFor, scheduleRoomCompaction, storeWrites, queueStoreUpdate } = createRelayPersistence({
  config: relayConfig, accounting, docs, Y, blockRoom, markStorageFailure,
  storage: { checkedFlushDocument, checkedStoreUpdate, databaseSizeBytes },
});

const { finalizeExpiredVotes, armVoteExpiry, voteExpiryTimers } = createVoteExpiry({
  Y, accounting, destroyedDocs, isRoomBlocked,
});

const { roomReady, persistence: roomPersistence } = createRoomState({
  Y, config: relayConfig, accounting, policy: roomPolicy,
  votes: { finalizeExpiredVotes, armVoteExpiry, voteExpiryTimers },
  storage: { checkedGetYDoc, ldb }, queueStoreUpdate, roomPersistenceChurn, markStorageFailure, HYDRATION_ORIGIN,
});
setPersistence(roomPersistence);

await migrateLegacyImages((process.env.YJS_MIGRATE_DOCS || '').split(',').map((entry) => entry.trim()).filter(Boolean), {
  Y, registry: roomRegistry, roomUploadUsage, uploadState, config: relayConfig,
  persistence: { getYDoc: checkedGetYDoc, storeUpdate: checkedStoreUpdate, setMeta: checkedSetMeta, flushDocument: checkedFlushDocument },
});


// null = normal room; a locked room's cookie is bound to its key epoch; an unreadable lock matches nothing (-1).
const CORRUPT_LOCK_EPOCH = -1;
const lockForDoc = (docName) => roomRegistry.lockFor(docName);
const roomKeyEpoch = (docName) => {
  const lock = lockForDoc(docName);
  if (!lock) return null;
  return lock === CORRUPT_LOCK ? CORRUPT_LOCK_EPOCH : lock.keyEpoch;
};
const roomSessions = new RoomSessions({
  signingKey: SESSION_SIGNING_KEY, rooms: registeredRoomsByHandle,
  ttlMs: relayConfig.ROOM_SESSION_TTL_MS, maxCookieHeaderBytes: relayConfig.MAX_COOKIE_HEADER_BYTES,
  allowInsecureHttp: ALLOW_INSECURE_HTTP, epochOf: roomKeyEpoch,
});
const createSessionCookie = roomSessions.createCookie.bind(roomSessions);
const authenticatedDocFromRequest = roomSessions.authenticate.bind(roomSessions);


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
const {
  takeCreateToken, takeSessionExchangeToken, failureAttemptAvailable, recordSessionFailure, takeWsUpgradeToken,
} = createAdmissionLimits(relayConfig, rateBuckets);


const wsTraffic = new RelayWsTraffic(relayConfig);

const imageReads = createImageReadBudgets(relayConfig);
const imageReadIpBuckets = imageReads.ipBuckets;
const imageReadRoomBuckets = imageReads.roomBuckets;

const uploads = createRelayUploads({
  config: relayConfig, state: uploadState, roomUploadUsage, imageReads,
  storage: { setMeta: checkedSetMeta },
  allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: ALLOW_INSECURE_HTTP, strictRasterValidation: PUBLIC_WALL, fence: roomFence,
});
uploadState.events.on(UPLOAD_STORAGE_FAILURE_EVENT, markStorageFailure);
const e2eBlobStore = new E2EBlobStore({ uploadsDir: relayConfig.UPLOADS_DIR, admission: uploads.admission, roomUploadUsage });

const relayProtocol = new RelayProtocol({
  maxStateVectorBytes: relayConfig.MAX_STATE_VECTOR_BYTES, maxUpdateBytes: relayConfig.MAX_UPDATE_BYTES,
  maxAwarenessMessageBytes: relayConfig.MAX_AWARENESS_MESSAGE_BYTES,
  maxAwarenessClientsPerRoom: relayConfig.MAX_AWARENESS_CLIENTS_PER_ROOM,
  maxAwarenessStateBytes: relayConfig.MAX_AWARENESS_STATE_BYTES,
});
const inspectProtocolMessage = relayProtocol.inspect.bind(relayProtocol);

const { planAwarenessUpdate, commitAwarenessPlan, releaseAwarenessForConnection } = createAwarenessPolicy({
  awarenessProtocol, MAX_AWARENESS_IDS_PER_CONNECTION: relayConfig.MAX_AWARENESS_IDS_PER_CONNECTION, MAX_AWARENESS_CLIENTS_PER_ROOM: relayConfig.MAX_AWARENESS_CLIENTS_PER_ROOM, MAX_AWARENESS_ROOM_BYTES: relayConfig.MAX_AWARENESS_ROOM_BYTES,
});

const reserveHttpRequest = createHttpRequestSlots({ maxRequests: relayConfig.MAX_HTTP_REQUESTS, maxRequestsPerIp: relayConfig.MAX_HTTP_REQUESTS_PER_IP });

if (publicWall) {
  const publicDoc = getYDoc(publicWall.docName);
  await roomReady.get(publicDoc);
  retainPublicDocument(publicDoc);
}
const rejectionCounters = createRejectionCounters((message, counts) => console.log(message, counts));
const { inspectMessage } = createWsAdmission({
  config: relayConfig, accounting, persistenceChurnFor, scheduleRoomCompaction,
  markStorageFailure, inspectProtocolMessage, planAwarenessUpdate, rejectionCounters, PUBLIC_WALL, Y,
});
const ACCOUNT_SIGNING_KEY = loadSigningKey(DB_DIR, ACCOUNT_SESSION_KEY);
const accountSessions = new AccountSessions({ signingKey: ACCOUNT_SIGNING_KEY, allowInsecureHttp: ALLOW_INSECURE_HTTP, maxCookieHeaderBytes: relayConfig.MAX_COOKIE_HEADER_BYTES });
const roomLockVerifier = new RoomLockVerifier();
const roomSessionRoutes = createRoomSessionRoutes({
  registry: roomRegistry, sessions: roomSessions, verifier: roomLockVerifier, accountSessions, accountStore,
  buckets: { takeCreateToken, takeSessionExchangeToken, failureAttemptAvailable, recordSessionFailure },
  config: { allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: ALLOW_INSECURE_HTTP, sessionTtlMs: relayConfig.ROOM_SESSION_TTL_MS, maxApiBodyBytes: relayConfig.MAX_API_BODY_BYTES },
  unavailable: () => accounting.shuttingDown || Boolean(accounting.storageFailure), onStorageFailure: markStorageFailure, fence: roomFence,
});
const plainRoomRefusal = (doc, docName) => (accounting.shuttingDown && new Error('shutting down')) || accounting.storageFailure
  || (capacityRejectedDocs.has(doc) && new Error('active document capacity reached')) || (isRoomBlocked(docName) && new Error('room unavailable')) || null;
const hasActiveRoomCapacity = () => docs.size + bindings.activeRooms() < relayConfig.MAX_ACTIVE_ROOMS; // the one cold-room admission: upgrades and renames
const titleWriter = createRoomTitleWriter({ docs, getYDoc, roomReady, fence: roomFence, refusal: plainRoomRefusal, admitsColdRoom: hasActiveRoomCapacity, storeWriteOf: (doc) => storeWrites.get(doc) });
const accountRooms = createAccountRoomRoutes({
  registry: roomRegistry, store: accountStore, maxBodyBytes: relayConfig.MAX_API_BODY_BYTES, onStorageFailure: markStorageFailure,
  deleteRoom: (docName) => bindings.deleteRoom(docName), readSummary: createRoomSummaryReader({ docs, roomReady, readStoredDoc: checkedGetYDoc }),
  writeTitle: (docName, title) => titleWriter.write(docName, title),
});
const authRoutes = createAuthRoutes({
  oauth: enabledOAuthConfig(process.env, { allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: ALLOW_INSECURE_HTTP, publicWall: PUBLIC_WALL, log: console }),
  sessions: accountSessions,
  accountKey: ACCOUNT_SIGNING_KEY, store: accountStore, ledger: new FlowLedger(), allowedOrigins: ALLOWED_ORIGINS,
  allowInsecureHttp: ALLOW_INSECURE_HTTP, maxCookieHeaderBytes: relayConfig.MAX_COOKIE_HEADER_BYTES, rejectionCounters, accountRooms,
});
const rejectUpgrade = (socket, status) => {
  rejectionCounters.upgrade(status);
  sendUpgradeRejection(socket, status);
};

const maintenance = new RelayMaintenance();
const guestSweep = new GuestRoomSweep({ registry: roomRegistry, docs, connections: wsTraffic.connectionsByRoom, publicWall: PUBLIC_WALL, log: console, deleteRoom: (docName) => bindings.deleteRoom(docName) }, readGuestSweepTiming(process.env, { allowInsecureHttp: ALLOW_INSECURE_HTTP }));
const maintainer = await startMaintainer(process.env, () => maintainerSnapshot({
  registry: roomRegistry, docs, connections: wsTraffic.connectionsByRoom, blockedRooms, roomUsage,
  ready: isRelayReady(accounting.storageFailure, accounting.shuttingDown), publicWall: PUBLIC_WALL,
  databaseBytes: accounting.dbUsageBytes, uploadBytes: uploadState.bytes,
  pendingStoreOps: accounting.pendingStoreOps, pendingStoreBytes: accounting.pendingStoreBytes, activeDocumentBytes: accounting.activeDocumentBytes,
  limits: { databaseBytes: relayConfig.MAX_DB_BYTES, uploadBytes: relayConfig.MAX_UPLOAD_STORAGE_BYTES, activeDocumentBytes: relayConfig.MAX_ACTIVE_DOCUMENT_BYTES, pendingStoreBytes: relayConfig.MAX_PENDING_STORE_BYTES, pendingStoreOps: relayConfig.MAX_PENDING_STORE_OPS },
}), { registry: roomRegistry, boardOrigin: ALLOWED_ORIGINS[0], publicWall: PUBLIC_WALL }, () => guestSweep.retireIdle(), accountStore);
maintenance.on(MAINTENANCE_STORAGE_FAILURE_EVENT, markStorageFailure);
const runMaintenance = () => maintenance.run({
  publicWall: publicWall && { docName: publicWall.docName, history: publicHistory },
  config: relayConfig, log: console, uploadBuckets, rateBuckets, imageReadIpBuckets, imageReadRoomBuckets,
  roomPersistenceChurn, docs, blockedRooms, uploadState, rejectionCounters,
  compaction: { schedule: scheduleRoomCompaction },
  votes: { finalize: finalizeExpiredVotes },
  storage: { measureDatabase: registryPersistence.measureDatabase, reconcileUploadUsage },
  e2eBlobs: bindings.e2eBlobs,
});
const maintenanceTimer = setInterval(() => { roomLockVerifier.sweep(); runMaintenance(); void bindings.recoverRooms(); void guestSweep.tick(); }, MAINTENANCE_INTERVAL_MS);
maintenanceTimer.unref();

const { dispatch } = createHttpDispatch({
  settings: { PUBLIC_WALL, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP, ROOM_SESSION_TTL_MS: relayConfig.ROOM_SESSION_TTL_MS }, accounting, rejectionCounters,
  traffic: { clientIpFromRequest, reserveHttpRequest, wsTraffic },
  sessions: { takeSessionExchangeToken, createSessionCookie, authenticatedDocFromRequest },
  rooms: { publicWall, docs, registeredRoomsByHandle },
  routes: { roomSessionRoutes, authRoutes },
  assets: { uploads, lockForDoc }, lateBindings: bindings,
});
const server = http.createServer({ maxHeaderSize: relayConfig.MAX_HEADER_BYTES }, dispatch);

server.requestTimeout = relayConfig.REQUEST_TIMEOUT_MS;
server.headersTimeout = relayConfig.HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = relayConfig.KEEP_ALIVE_TIMEOUT_MS;
server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
server.maxConnections = relayConfig.MAX_CONNECTIONS + relayConfig.MAX_HTTP_REQUESTS;
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
const wss = new WebSocketServer({ noServer: true, maxPayload: relayConfig.RL_MAX_BYTES });
roomRegistry.activity.watch(wss, (error) => roomRegistry.reportStorageFailure(error));
const e2eRoomLog = new E2ERoomLog({
  ldb, maxRoomBytes: relayConfig.MAX_DOCUMENT_BYTES, reserveStore: registryPersistence.reserveStore, hasCapacity: registryPersistence.hasCapacity,
  onError: markStorageFailure, deleteStagedBlobs: (_docName, rotationId) => e2eBlobStore.deleteStaged(rotationId),
  onBlobsRetired: (docName) => e2eBlobStore.trackRetired(docName), fence: roomFence,
});
const e2eRelay = createE2ERelay({
  traffic: wsTraffic, maxRoomBytes: relayConfig.MAX_DOCUMENT_BYTES, maxAppendBytes: relayConfig.RL_MAX_BYTES, onStorageFailure: markStorageFailure, touch: (docName) => roomRegistry.activity.touch(docName),
  roomLog: e2eRoomLog,
});
bindings.bind('activeRooms', () => e2eRelay.activeRooms());
const e2eBlobs = createE2EBlobs({
  config: relayConfig, allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: ALLOW_INSECURE_HTTP, uploads, store: e2eBlobStore,
  roomLog: e2eRoomLog, registry: roomRegistry, onStorageFailure: markStorageFailure, fence: roomFence,
});
bindings.bind('e2eBlobs', e2eBlobs);
const roomLockRoutes = createRoomLockRoutes({
  registry: roomRegistry, roomLog: e2eRoomLog, blobStore: e2eBlobStore, closeRoom: e2eRelay.closeRoom, verifier: roomLockVerifier, accountSessions, accountStore,
  config: { allowedOrigins: ALLOWED_ORIGINS, allowInsecureHttp: ALLOW_INSECURE_HTTP, maxApiBodyBytes: relayConfig.MAX_API_BODY_BYTES },
  unavailable: () => accounting.shuttingDown || Boolean(accounting.storageFailure), onStorageFailure: markStorageFailure, fence: roomFence,
});
bindings.bind('roomLockRoutes', roomLockRoutes);
const roomDeletion = new RoomDeletion({
  fence: roomFence, journal: deletionJournal, registry: roomRegistry, pending: journaledDeletions, onStorageFailure: markStorageFailure,
  plainRooms: createPlainRoomTeardown({ docs, roomReady, roomPersistenceChurn, blockedRooms }), e2eRooms: e2eRelay,
  files: createRoomFileRemover({ io: fs.promises, uploadsDir: relayConfig.UPLOADS_DIR, reconcileUploadUsage }),
});
bindings.bind('deleteRoom', docName => roomDeletion.deleteRoom(docName));
bindings.bind('recoverRooms', () => roomDeletion.recover());
const plainUpgrades = createPlainUpgrades({
  docs, getYDoc, roomReady, wss, fence: roomFence, reject: rejectUpgrade, timeoutMs: relayConfig.UPGRADE_TIMEOUT_MS, refusal: plainRoomRefusal,
});
roomRegistry.activity.watch(e2eRelay.wss, (error) => roomRegistry.reportStorageFailure(error));
const { handleConnection } = createWsConnectionHandler({
  config: relayConfig, accounting, docs, Y, PUBLIC_WALL, roomFence, wsTraffic, rejectionCounters,
  setupWSConnection, releaseAwarenessForConnection, inspectMessage, commitAwarenessPlan,
});
wss.on('connection', handleConnection);

const { handleUpgrade } = createUpgradeHandler({
  settings: { PUBLIC_WALL, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP, ALLOW_LEGACY_URL_TOKENS, ALLOW_LEGACY_ROOMS },
  roomRegistry, accounting, docs, roomFence, wsTraffic, isRoomBlocked, hasActiveRoomCapacity,
  takeWsUpgradeToken, clientIpFromRequest, authenticatedDocFromRequest, roomKeyEpoch, e2eRelay, plainUpgrades, rejectUpgrade,
});
server.on('upgrade', handleUpgrade);

// Graceful drain. Without this, `docker stop` kills the process while
// storeUpdate calls are still in flight, so the last edits before a deploy
// can be lost even though every client saw them.
const lifecycle = createRelayLifecycle({
  timeoutMs: relayConfig.SHUTDOWN_TIMEOUT_MS,
  log: console,
  errorId: (err) => roomLogId(String(err)),
  exit: (code) => process.exit(code),
  setExitCode: (code) => { process.exitCode = code; },
  onStart: (signal) => {
    accounting.shuttingDown = true;
    clearInterval(maintenanceTimer);
    maintainer?.close(); maintainer?.closeAllConnections();
    console.log('[yjs] draining', { signal, rooms: docs.size });
  },
  drain: async () => {
    const roomCount = docs.size;
    await e2eRelay.drain();
    await drainRelay({
      server, clients: wss.clients, httpGraceMs: relayConfig.HTTP_SHUTDOWN_GRACE_MS,
      isBusy: () => maintenance.running || roomRegistry.pendingRoomCreations > 0 || uploadState.active > 0 || accounting.pendingStoreOps > 0
        || accountStore.pendingOperations > 0 || authRoutes.pendingExchanges > 0,
      compactions: () => [...roomPersistenceChurn.values()].map((churn) => churn.compactionPromise).filter(Boolean),
      destroyStorage: async () => { await roomRegistry.activity.stop(); await accountStore.stop(); await ldb.destroy(); },
    });
    console.log('[yjs] drained', { rooms: roomCount });
  },
});
bindings.bind('shutdown', (...args) => lifecycle.shutdown(...args));
const shutdown = lifecycle.shutdown;
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on(UNHANDLED_REJECTION_EVENT, (err) => { lifecycle.fatal(UNHANDLED_REJECTION_EVENT, err); });
process.on(UNCAUGHT_EXCEPTION_EVENT, (err) => { lifecycle.fatal(UNCAUGHT_EXCEPTION_EVENT, err); });
await roomDeletion.recover();
if (await e2eBlobs.reconcileOrphans() > 0) await reconcileUploadUsage();
server.listen(PORT, HOST, () => logRelayBanner({
  server, PORT, HOST, DB_DIR, ALLOWED_ORIGINS, ALLOW_INSECURE_HTTP,
  ALLOW_LEGACY_ROOMS, ALLOW_LEGACY_URL_TOKENS, TRUST_PROXY, accounting, MAX_DB_BYTES: relayConfig.MAX_DB_BYTES, markStorageFailure,
}));
