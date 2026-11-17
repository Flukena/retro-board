import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountStore } from './account-store.js';
import { AccountSessions } from './auth-session.js';
import { E2ERoomLog, E2E_FROZEN, MAX_FREEZE_TTL_MS } from './e2e-room-log.js';
import { RoomRegistry } from './relay-room-registry.js';
import { checkedStorage, durableMetaBatch } from './relay-storage.js';
import { ROOM_LOCK_META, RoomLockVerifier, WRONG_PASSWORDS_PER_IP_ROOM, decodeLockRecord } from './room-lock.js';
import { KEY_ROTATED_CLOSE_CODE, createRoomLockRoutes } from './room-lock-routes.js';
import { MAX_COMMIT_HEADER_BYTES } from './room-lock-commit-body.js';
import { createNextRoomKey, createRoomLock, rewrapRoomLock } from '../client/room-lock/e2e-crypto.js';
import { encodeBase64Url } from '../domain/room-lock-contract.js';
import { RoomFence } from './room-fence.js';
import { DeletionJournal, RoomDeletion } from './room-deletion.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const ORIGIN = 'https://board.example';
const IP = '203.0.113.9';
const KEY_BYTES = 32;
const COOKIE_HEADER_BYTES = 4096;
const MAX_BODY_BYTES = 4096;
const MAX_ROOM_BYTES = 1024 * 1024;
const MAX_ROOMS = 50;
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const EPOCH = 0;
const PASSWORD = 'correct horse battery staple';
const NEXT_PASSWORD = 'another long passphrase 2';
const HEADER_LENGTH_BYTES = 4;
const EARLY_RESPONSE_MS = 2000;
const STATUS = Object.freeze({
  OK: 200, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  TOO_LARGE: 413, TOO_MANY: 429, UNAVAILABLE: 503,
});
// One PBKDF2 derivation per key for the whole file.
const ROOM_LOCK = await createRoomLock(PASSWORD);
const NEXT_KEY = await createNextRoomKey(NEXT_PASSWORD);
const SNAPSHOT = new Uint8Array(64).fill(9);
const bytesOf = (length, fill = 1) => new Uint8Array(length).fill(fill);

async function fixture(t, { maxBodyBytes = MAX_BODY_BYTES } = {}) {
  const settled = { calls: [], fail: false };
  const directory = await mkdtemp(join(tmpdir(), 'room-lock-routes-'));
  const ldb = new LeveldbPersistence(directory);
  t.after(async () => { await ldb.destroy().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const storage = checkedStorage(ldb, Y);
  const registry = new RoomRegistry({
    persistence: {
      ...storage, durableMetaBatch: (doc, ops) => durableMetaBatch(ldb, doc, ops),
      hasCapacity: () => true, reserveStore: () => () => {}, measureDatabase: () => 0,
    },
    Y, maxRooms: MAX_ROOMS, maxDatabaseBytes: UNLIMITED, signingKey: randomBytes(KEY_BYTES), log: { warn() {}, error() {} },
  });
  await registry.hydrate({ complete: true, roomsByHandle: new Map() });
  const accountSessions = new AccountSessions({ signingKey: randomBytes(KEY_BYTES), allowInsecureHttp: false, maxCookieHeaderBytes: COOKIE_HEADER_BYTES });
  const accountStore = new AccountStore({ ldb, getMeta: storage.getMeta, hasCapacity: () => true });
  const flaky = { failWrites: false, getMeta: (...a) => ldb.getMeta(...a), getMetas: (...a) => ldb.getMetas(...a), _transact: (fn) => (flaky.failWrites ? Promise.resolve(null) : ldb._transact(fn)) };
  const timers = [];
  const staged = [];
  const fence = new RoomFence();
  const roomLog = new E2ERoomLog({
    fence,
    ldb: flaky, maxRoomBytes: MAX_ROOM_BYTES, reserveStore: () => () => {}, hasCapacity: () => true,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimer() {},
    deleteStagedBlobs: (doc, rotationId) => staged.push(rotationId),
  });
  const verifier = new RoomLockVerifier();
  const closed = [];
  const routes = createRoomLockRoutes({
    registry, roomLog,
    blobStore: { settleStaged: async (...args) => { settled.calls.push(args); if (settled.fail) throw new Error('disk gone'); } },
    closeRoom: (doc, code, reason) => closed.push({ doc, code, reason }), verifier, accountSessions, accountStore,
    config: { allowedOrigins: [ORIGIN], allowInsecureHttp: false, maxApiBodyBytes: maxBodyBytes },
    unavailable: () => false, onStorageFailure() {}, fence,
  });
  const server = http.createServer((req, res) => {
    if (!routes.handle(req, res, req.url, { clientIp: IP, hasQueryOrFragment: false })) { res.writeHead(STATUS.NOT_FOUND); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const signIn = async (email) => {
    const account = await accountStore.upsertFromGoogle({ sub: `sub-${email}`, email, name: email });
    return { account, cookie: accountSessions.createCookie(account.id, account.sessionGeneration, '/api').split(';')[0] };
  };
  const createRoom = async (owner, lock = null) => {
    const record = lock === null ? null : { v: 1, ...ROOM_LOCK.lock, keyEpoch: EPOCH, ownerAccountId: owner.account.id, createdAt: Date.now(), lockRevision: 0 };
    const { code, token } = await registry.createRoom({ lock: record });
    const docName = registry.registeredDocForCapability(code, token);
    return { docName, handle: registry.roomHandleForDoc(docName) };
  };
  const send = (path, { cookie, body, headers = {} }) => fetch(`${base}${path}`, {
    method: 'POST', headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers }, body,
  });
  const postJson = (room, action, body, cookie) => send(`/api/rooms/${room.handle}/lock/${action}`, {
    cookie, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const postCommit = (room, header, snapshot, cookie, { headerLength } = {}) => {
    const json = Buffer.from(JSON.stringify(header));
    const prefix = Buffer.alloc(HEADER_LENGTH_BYTES);
    prefix.writeUInt32BE(headerLength ?? json.length);
    return send(`/api/rooms/${room.handle}/lock/rotate/commit`, {
      cookie, body: Buffer.concat([prefix, json, Buffer.from(snapshot)]), headers: { 'content-type': 'application/octet-stream' },
    });
  };
  const storedLock = async (room) => decodeLockRecord(await ldb.getMeta(room.docName, ROOM_LOCK_META));
  return { directory, settled, base, registry, roomLog, verifier, ldb, flaky, timers, staged, closed, signIn, createRoom, postJson, postCommit, storedLock, fence };
}

async function lockedRoom(t) {
  const f = await fixture(t);
  const owner = await f.signIn('owner@example.com');
  const room = await f.createRoom(owner, ROOM_LOCK);
  return { ...f, owner, room };
}

const begin = async (f, expectedRevision = 0) => {
  const response = await f.postJson(f.room, 'rotate/begin', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision }, f.owner.cookie);
  assert.equal(response.status, STATUS.OK);
  return response.json();
};

const commitHeader = (rotation, overrides = {}) => ({
  oldAuthKey: ROOM_LOCK.authKey, rotationId: rotation.rotationId, expectedHead: rotation.head, knownSnapshotBase: 0, keyEpoch: 1, lock: NEXT_KEY.lock, keepBlobs: [], ...overrides,
});

const stageBlob = (f, rotation, id = randomUUID(), epoch = 1) => f.roomLog.addBlob(f.room.docName, { id, bytes: 10, epoch, stagedFor: rotation.rotationId }).then(() => id);

test('every route refuses a missing account, a non-owner, a normal room and an unknown room', async (t) => {
  const f = await lockedRoom(t);
  const stranger = await f.signIn('stranger@example.com');
  const normal = await f.createRoom(f.owner, null);
  const body = { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 };
  assert.equal((await f.postJson(f.room, 'rotate/begin', body)).status, STATUS.UNAUTHORIZED);
  assert.equal((await f.postJson(f.room, 'rotate/begin', body, 'rb_account=junk')).status, STATUS.UNAUTHORIZED);
  assert.equal((await f.postJson(f.room, 'rotate/begin', body, stranger.cookie)).status, STATUS.FORBIDDEN);
  assert.equal((await f.postJson(normal, 'rotate/begin', body, f.owner.cookie)).status, STATUS.NOT_FOUND);
  assert.equal((await f.postJson({ handle: 'x'.repeat(32) }, 'rotate/begin', body, f.owner.cookie)).status, STATUS.NOT_FOUND);
  // A non-owner can never freeze the room or touch the verifier.
  assert.equal((await f.postJson(f.room, 'password', { ...body, lock: NEXT_KEY.lock }, stranger.cookie)).status, STATUS.FORBIDDEN);
  assert.equal((await f.postCommit(f.room, commitHeader({ rotationId: randomUUID(), head: 0 }), SNAPSHOT, stranger.cookie)).status, STATUS.FORBIDDEN);
  assert.equal((await f.storedLock(f.room)).lockRevision, 0);
  assert.equal((await f.roomLog.append(f.room.docName, bytesOf(3), EPOCH)).seq, 1);
});

test('a wrong oldAuthKey is 403 on every route and the sixth wrong try is 429 with retry-after', async (t) => {
  const f = await lockedRoom(t);
  const wrong = encodeBase64Url(bytesOf(KEY_BYTES, 8));
  assert.equal((await f.postJson(f.room, 'password', { oldAuthKey: wrong, expectedRevision: 0, lock: NEXT_KEY.lock }, f.owner.cookie)).status, STATUS.FORBIDDEN);
  const rotation = await begin(f);
  assert.equal((await f.postJson(f.room, 'rotate/abort', { oldAuthKey: wrong, rotationId: rotation.rotationId }, f.owner.cookie)).status, STATUS.FORBIDDEN);
  assert.equal((await f.postCommit(f.room, commitHeader(rotation, { oldAuthKey: wrong }), SNAPSHOT, f.owner.cookie)).status, STATUS.FORBIDDEN);
  assert.equal((await f.postJson(f.room, 'rotate/abort', { oldAuthKey: wrong, rotationId: rotation.rotationId }, f.owner.cookie)).status, STATUS.FORBIDDEN);
  assert.equal((await f.postJson(f.room, 'rotate/abort', { oldAuthKey: wrong, rotationId: rotation.rotationId }, f.owner.cookie)).status, STATUS.FORBIDDEN);
  assert.equal(WRONG_PASSWORDS_PER_IP_ROOM, 5);
  const limited = await f.postJson(f.room, 'rotate/abort', { oldAuthKey: wrong, rotationId: rotation.rotationId }, f.owner.cookie);
  assert.equal(limited.status, STATUS.TOO_MANY);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  // The right key is limited too while the window is full, and the freeze is still in place.
  assert.equal((await f.postJson(f.room, 'rotate/abort', { oldAuthKey: ROOM_LOCK.authKey, rotationId: rotation.rotationId }, f.owner.cookie)).status, STATUS.TOO_MANY);
  await assert.rejects(f.roomLog.append(f.room.docName, bytesOf(1), EPOCH), (e) => e.code === E2E_FROZEN);
});

test('malformed bodies are 400 and oversized JSON is 413', async (t) => {
  const f = await lockedRoom(t);
  const good = { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 };
  assert.equal((await f.postJson(f.room, 'rotate/begin', { ...good, extra: 1 }, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  assert.equal((await f.postJson(f.room, 'rotate/begin', { oldAuthKey: 'short', expectedRevision: 0 }, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  assert.equal((await f.postJson(f.room, 'rotate/begin', { ...good, expectedRevision: -1 }, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  assert.equal((await f.postJson(f.room, 'password', { ...good, lock: { ...NEXT_KEY.lock, verifier: 'x' } }, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  assert.equal((await f.postJson(f.room, 'rotate/abort', { oldAuthKey: ROOM_LOCK.authKey, rotationId: 'nope' }, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  assert.equal((await f.postJson(f.room, 'rotate/begin', { ...good, pad: 'x'.repeat(MAX_BODY_BYTES) }, f.owner.cookie)).status, STATUS.TOO_LARGE);
});

test('password change keeps the epoch, bumps the revision once, and swaps which key verifies', async (t) => {
  const f = await lockedRoom(t);
  const change = await rewrapRoomLock({ currentPassword: PASSWORD, lock: ROOM_LOCK.lock, newPassword: NEXT_PASSWORD });
  const response = await f.postJson(f.room, 'password', { oldAuthKey: change.oldAuthKey, expectedRevision: 0, lock: change.lock }, f.owner.cookie);
  assert.equal(response.status, STATUS.OK);
  assert.deepEqual(await response.json(), { lockRevision: 1 });
  const stored = await f.storedLock(f.room);
  assert.deepEqual([stored.keyEpoch, stored.lockRevision, stored.ownerAccountId], [0, 1, f.owner.account.id]);
  assert.equal(stored.wrappedDek, change.lock.wrappedDek);
  assert.equal(f.registry.lockFor(f.room.docName).lockRevision, 1, 'published to memory');
  assert.equal(f.verifier.check(IP, f.room.docName, stored, change.authKey), 'ok');
  assert.equal(f.verifier.check(IP, f.room.docName, stored, ROOM_LOCK.authKey), 'wrong');
  assert.deepEqual(f.closed, [], 'a password change does not close sockets');
  // Sending the stale revision or the old key again is refused.
  const stale = await f.postJson(f.room, 'password', { oldAuthKey: change.authKey, expectedRevision: 0, lock: NEXT_KEY.lock }, f.owner.cookie);
  assert.equal(stale.status, STATUS.CONFLICT);
  const oldKey = await f.postJson(f.room, 'password', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 1, lock: NEXT_KEY.lock }, f.owner.cookie);
  assert.equal(oldKey.status, STATUS.FORBIDDEN);
});

test('begin freezes appends for 120 s, a second begin is 409, and abort resumes and deletes staged blobs', async (t) => {
  const f = await lockedRoom(t);
  await f.roomLog.append(f.room.docName, bytesOf(3), EPOCH);
  const rotation = await begin(f);
  assert.deepEqual(Object.keys(rotation).sort(), ['expiresInMs', 'head', 'lockRevision', 'rotationId']);
  assert.equal(rotation.head, 1);
  assert.equal(rotation.expiresInMs, MAX_FREEZE_TTL_MS);
  assert.equal(f.timers.at(-1).ms, MAX_FREEZE_TTL_MS);
  await assert.rejects(f.roomLog.append(f.room.docName, bytesOf(1), EPOCH), (e) => e.code === E2E_FROZEN);
  const again = await f.postJson(f.room, 'rotate/begin', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 }, f.owner.cookie);
  assert.equal(again.status, STATUS.CONFLICT);
  const pwd = await f.postJson(f.room, 'password', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0, lock: NEXT_KEY.lock }, f.owner.cookie);
  assert.equal(pwd.status, STATUS.CONFLICT, 'password change is refused during a freeze');
  const other = await f.postJson(f.room, 'rotate/abort', { oldAuthKey: ROOM_LOCK.authKey, rotationId: randomUUID() }, f.owner.cookie);
  assert.equal(other.status, STATUS.CONFLICT);
  const stagedId = await stageBlob(f, rotation);
  const aborted = await f.postJson(f.room, 'rotate/abort', { oldAuthKey: ROOM_LOCK.authKey, rotationId: rotation.rotationId }, f.owner.cookie);
  assert.equal(aborted.status, STATUS.NO_CONTENT);
  assert.deepEqual(f.staged, [rotation.rotationId]);
  assert.equal((await f.roomLog.blobs(f.room.docName)).some((entry) => entry.id === stagedId), false);
  assert.equal((await f.roomLog.append(f.room.docName, bytesOf(1), EPOCH)).seq, 2);
});

test('a freeze that reaches its TTL releases by itself', async (t) => {
  const f = await lockedRoom(t);
  await begin(f);
  f.timers.at(-1).fn();
  await f.roomLog.whenIdle();
  assert.equal((await f.roomLog.append(f.room.docName, bytesOf(1), EPOCH)).seq, 1);
});

test('begin with a stale revision is 409', async (t) => {
  const f = await lockedRoom(t);
  const response = await f.postJson(f.room, 'rotate/begin', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 5 }, f.owner.cookie);
  assert.equal(response.status, STATUS.CONFLICT);
});

test('commit swaps snapshot, lock and keys in one step, closes sockets with 4001 and keeps old blobs for the grace', async (t) => {
  const f = await lockedRoom(t);
  await f.roomLog.append(f.room.docName, bytesOf(5), EPOCH);
  const oldBlob = randomUUID();
  await f.roomLog.addBlob(f.room.docName, { id: oldBlob, bytes: 10, epoch: 0 });
  const createdAt = (await f.storedLock(f.room)).createdAt;
  const rotation = await begin(f);
  const keptBlob = await stageBlob(f, rotation);
  const response = await f.postCommit(f.room, commitHeader(rotation, { keepBlobs: [keptBlob] }), SNAPSHOT, f.owner.cookie);
  assert.equal(response.status, STATUS.NO_CONTENT);
  assert.deepEqual(f.closed, [{ doc: f.room.docName, code: KEY_ROTATED_CLOSE_CODE, reason: 'key rotated' }]);
  const stored = await f.storedLock(f.room);
  assert.deepEqual([stored.keyEpoch, stored.lockRevision, stored.ownerAccountId], [1, 1, f.owner.account.id]);
  assert.deepEqual(f.registry.lockFor(f.room.docName), stored);
  assert.equal(stored.verifier, NEXT_KEY.lock.verifier);
  assert.equal(stored.createdAt, createdAt, 'createdAt is kept');
  assert.deepEqual(f.settled.calls, [[rotation.rotationId, [keptBlob]]], 'discarded staged files are settled after the commit');
  assert.equal(f.verifier.check(IP, f.room.docName, stored, NEXT_KEY.authKey), 'ok');
  assert.equal(f.verifier.check(IP, f.room.docName, stored, ROOM_LOCK.authKey), 'wrong');
  const state = await f.roomLog.open(f.room.docName);
  assert.deepEqual(state.updates, []);
  assert.deepEqual([state.snapshot.baseSeq, [...state.snapshot.bytes]], [1, [...SNAPSHOT]]);
  const blobs = Object.fromEntries((await f.roomLog.blobs(f.room.docName)).map((entry) => [entry.id, entry]));
  assert.ok(blobs[oldBlob].retiredAt !== undefined, 'old-epoch blob is retired, not deleted');
  assert.equal(blobs[keptBlob].stagedFor, null);
  assert.equal(blobs[keptBlob].retiredAt, undefined);
  assert.equal((await f.roomLog.append(f.room.docName, bytesOf(1), stored.keyEpoch)).seq, 2, 'appends at the new epoch resume after the commit');
});

test('commit is 409 for a wrong head, rotationId, epoch or a rotation that was never begun, and leaves the freeze', async (t) => {
  const f = await lockedRoom(t);
  const rotation = await begin(f);
  const refused = [
    commitHeader(rotation, { expectedHead: rotation.head + 1 }),
    commitHeader(rotation, { rotationId: randomUUID() }),
    commitHeader(rotation, { keyEpoch: 2 }),
    commitHeader(rotation, { keyEpoch: 0 }),
  ];
  for (const header of refused) assert.equal((await f.postCommit(f.room, header, SNAPSHOT, f.owner.cookie)).status, STATUS.CONFLICT);
  assert.equal((await f.storedLock(f.room)).keyEpoch, 0);
  assert.deepEqual(f.closed, []);
  await assert.rejects(f.roomLog.append(f.room.docName, bytesOf(1), EPOCH), (e) => e.code === E2E_FROZEN);
});

test('a committer that missed the stored snapshot is 409 and the snapshot, lock and freeze stay', async (t) => {
  const f = await lockedRoom(t);
  for (let i = 0; i < 2; i += 1) await f.roomLog.append(f.room.docName, bytesOf(4), EPOCH);
  await f.roomLog.snapshot(f.room.docName, 2, bytesOf(6), 0, EPOCH);
  const rotation = await begin(f);
  const missed = await f.postCommit(f.room, commitHeader(rotation, { knownSnapshotBase: 0 }), SNAPSHOT, f.owner.cookie);
  assert.equal(missed.status, STATUS.CONFLICT);
  assert.equal((await f.storedLock(f.room)).keyEpoch, 0);
  assert.equal((await f.roomLog.open(f.room.docName)).snapshot.baseSeq, 2);
  assert.deepEqual(f.closed, []);
  await assert.rejects(f.roomLog.append(f.room.docName, bytesOf(1), EPOCH), (e) => e.code === E2E_FROZEN);
  const current = await f.postCommit(f.room, commitHeader(rotation, { knownSnapshotBase: 2 }), SNAPSHOT, f.owner.cookie);
  assert.equal(current.status, STATUS.NO_CONTENT);
});

test('keepBlobs must be staged for this rotation: unknown, committed or duplicate ids are refused', async (t) => {
  const f = await lockedRoom(t);
  const committed = randomUUID();
  await f.roomLog.addBlob(f.room.docName, { id: committed, bytes: 10, epoch: 0 });
  const rotation = await begin(f);
  const staged = await stageBlob(f, rotation);
  for (const keepBlobs of [[randomUUID()], [committed], [staged, randomUUID()]]) {
    assert.equal((await f.postCommit(f.room, commitHeader(rotation, { keepBlobs }), SNAPSHOT, f.owner.cookie)).status, STATUS.CONFLICT);
  }
  for (const keepBlobs of [[staged, staged], ['not-a-uuid'], 'all']) {
    assert.equal((await f.postCommit(f.room, commitHeader(rotation, { keepBlobs }), SNAPSHOT, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  }
  assert.equal((await f.storedLock(f.room)).keyEpoch, 0);
  const ok = await f.postCommit(f.room, commitHeader(rotation, { keepBlobs: [staged] }), SNAPSHOT, f.owner.cookie);
  assert.equal(ok.status, STATUS.NO_CONTENT);
});

test('a staged blob the client does not keep leaves the inventory at commit', async (t) => {
  const f = await lockedRoom(t);
  const rotation = await begin(f);
  const dropped = await stageBlob(f, rotation);
  const ok = await f.postCommit(f.room, commitHeader(rotation), SNAPSHOT, f.owner.cookie);
  assert.equal(ok.status, STATUS.NO_CONTENT);
  assert.equal((await f.roomLog.blobs(f.room.docName)).some((entry) => entry.id === dropped), false);
});

test('commit body limits: header over 1 MiB, empty snapshot and oversized snapshot are 413; malformed is 400', async (t) => {
  const f = await lockedRoom(t);
  const rotation = await begin(f);
  const header = commitHeader(rotation);
  assert.equal((await f.postCommit(f.room, header, SNAPSHOT, f.owner.cookie, { headerLength: MAX_COMMIT_HEADER_BYTES + 1 })).status, STATUS.TOO_LARGE);
  assert.equal((await f.postCommit(f.room, header, new Uint8Array(0), f.owner.cookie)).status, STATUS.TOO_LARGE);
  assert.equal((await f.postCommit(f.room, header, new Uint8Array(f.roomLog.maxSnapshotBytes + 1), f.owner.cookie)).status, STATUS.TOO_LARGE);
  assert.equal((await f.postCommit(f.room, header, SNAPSHOT, f.owner.cookie, { headerLength: 99_999 })).status, STATUS.BAD_REQUEST);
  assert.equal((await f.postCommit(f.room, { ...header, extra: 1 }, SNAPSHOT, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  const withoutBase = Object.fromEntries(Object.entries(header).filter(([key]) => key !== 'knownSnapshotBase'));
  assert.equal((await f.postCommit(f.room, withoutBase, SNAPSHOT, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  assert.equal((await f.postCommit(f.room, { ...header, knownSnapshotBase: -1 }, SNAPSHOT, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  assert.equal((await f.postCommit(f.room, { ...header, lock: { ...NEXT_KEY.lock, wrapIv: 'x' } }, SNAPSHOT, f.owner.cookie)).status, STATUS.BAD_REQUEST);
  assert.equal((await f.storedLock(f.room)).keyEpoch, 0);
});

test('a storage failure during commit is 503 with the old lock, log and freeze intact', async (t) => {
  const f = await lockedRoom(t);
  await f.roomLog.append(f.room.docName, bytesOf(4), EPOCH);
  const rotation = await begin(f);
  f.flaky.failWrites = true;
  const response = await f.postCommit(f.room, commitHeader(rotation), SNAPSHOT, f.owner.cookie);
  f.flaky.failWrites = false;
  assert.equal(response.status, STATUS.UNAVAILABLE);
  const stored = await f.storedLock(f.room);
  assert.deepEqual([stored.keyEpoch, stored.lockRevision], [0, 0]);
  assert.equal(f.registry.lockFor(f.room.docName).keyEpoch, 0);
  assert.deepEqual(f.closed, []);
  const state = await f.roomLog.open(f.room.docName);
  assert.deepEqual([state.snapshot, state.updates.length], [null, 1]);
  const retry = await f.postCommit(f.room, commitHeader(rotation), SNAPSHOT, f.owner.cookie);
  assert.equal(retry.status, STATUS.NO_CONTENT, 'the same rotation can still be committed');
});

test('a password change racing a rotation commit: exactly one wins and lock and ciphertext agree', async (t) => {
  const f = await lockedRoom(t);
  const change = await rewrapRoomLock({ currentPassword: PASSWORD, lock: ROOM_LOCK.lock, newPassword: 'third long passphrase 3' });
  const rotation = await begin(f);
  const [commit, password] = await Promise.all([
    f.postCommit(f.room, commitHeader(rotation), SNAPSHOT, f.owner.cookie),
    f.postJson(f.room, 'password', { oldAuthKey: change.oldAuthKey, expectedRevision: 0, lock: change.lock }, f.owner.cookie),
  ]);
  assert.equal(password.status, STATUS.CONFLICT);
  assert.equal(commit.status, STATUS.NO_CONTENT);
  const stored = await f.storedLock(f.room);
  assert.deepEqual([stored.keyEpoch, stored.lockRevision, stored.verifier], [1, 1, NEXT_KEY.lock.verifier]);
  assert.equal((await f.roomLog.open(f.room.docName)).snapshot.baseSeq, 0);
});

test('a password change that landed first makes the rotation begun for the old revision stale', async (t) => {
  const f = await lockedRoom(t);
  const change = await rewrapRoomLock({ currentPassword: PASSWORD, lock: ROOM_LOCK.lock, newPassword: 'third long passphrase 3' });
  const [password, started] = await Promise.all([
    f.postJson(f.room, 'password', { oldAuthKey: change.oldAuthKey, expectedRevision: 0, lock: change.lock }, f.owner.cookie),
    f.postJson(f.room, 'rotate/begin', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 }, f.owner.cookie),
  ]);
  assert.equal(password.status, STATUS.OK);
  assert.equal(started.status, STATUS.CONFLICT);
  await f.roomLog.append(f.room.docName, bytesOf(1), EPOCH);
});

test('a staged-file cleanup failure after a durable commit does not fail the 204', async (t) => {
  const f = await lockedRoom(t);
  f.settled.fail = true;
  const rotation = await begin(f);
  assert.equal((await f.postCommit(f.room, commitHeader(rotation), SNAPSHOT, f.owner.cookie)).status, STATUS.NO_CONTENT);
  assert.equal((await f.storedLock(f.room)).keyEpoch, 1);
});

test('the password route has its own 1 KiB cap even when the shared API cap is larger', async (t) => {
  const f = await fixture(t, { maxBodyBytes: 16 * 1024 });
  const owner = await f.signIn('owner@example.com');
  const room = await f.createRoom(owner, ROOM_LOCK);
  const change = await rewrapRoomLock({ currentPassword: PASSWORD, lock: ROOM_LOCK.lock, newPassword: NEXT_PASSWORD });
  const padded = { oldAuthKey: change.oldAuthKey, expectedRevision: 0, lock: change.lock, pad: 'x'.repeat(1024) };
  assert.equal((await f.postJson(room, 'password', padded, owner.cookie)).status, STATUS.TOO_LARGE);
  const plain = { oldAuthKey: change.oldAuthKey, expectedRevision: 0, lock: change.lock };
  assert.equal((await f.postJson(room, 'password', plain, owner.cookie)).status, STATUS.OK);
});

// A chunked request that never ends: the refusal must arrive while the client is still "sending".
async function earlyStatus(f, room, ownerCookie, chunks) {
  const url = new URL(`${f.base}/api/rooms/${room.handle}/lock/rotate/commit`);
  const req = http.request(url, { method: 'POST', headers: { origin: ORIGIN, cookie: ownerCookie, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
  req.on('error', () => {});
  const responded = once(req, 'response');
  for (const chunk of chunks) req.write(chunk);
  const timeout = new Promise((_, reject) => { setTimeout(() => reject(new Error('no early response')), EARLY_RESPONSE_MS); });
  const [response] = await Promise.race([responded, timeout]);
  response.resume();
  req.destroy();
  return response.statusCode;
}

const lengthPrefix = (length) => { const prefix = Buffer.alloc(HEADER_LENGTH_BYTES); prefix.writeUInt32BE(length); return prefix; };

test('a commit with a bad header length, header or oversized snapshot is refused before the body ends', async (t) => {
  const f = await lockedRoom(t);
  const rotation = await begin(f);
  const header = Buffer.from(JSON.stringify(commitHeader(rotation)));
  assert.equal(await earlyStatus(f, f.room, f.owner.cookie, [lengthPrefix(MAX_COMMIT_HEADER_BYTES + 1)]), STATUS.TOO_LARGE);
  const garbage = Buffer.from('{not json');
  assert.equal(await earlyStatus(f, f.room, f.owner.cookie, [lengthPrefix(garbage.length), garbage]), STATUS.BAD_REQUEST);
  const huge = Buffer.alloc(f.roomLog.maxSnapshotBytes + 1, 1);
  assert.equal(await earlyStatus(f, f.room, f.owner.cookie, [lengthPrefix(header.length), header, huge]), STATUS.TOO_LARGE);
  assert.equal((await f.storedLock(f.room)).keyEpoch, 0);
});

test('a crash after the durable commit batch and before publish reopens to one consistent new state', async (t) => {
  const f = await lockedRoom(t);
  await f.roomLog.append(f.room.docName, bytesOf(5), EPOCH);
  const oldBlob = randomUUID();
  await f.roomLog.addBlob(f.room.docName, { id: oldBlob, bytes: 10, epoch: 0 });
  const rotation = await begin(f);
  const keptBlob = await stageBlob(f, rotation);
  f.registry.publishLock = () => { throw new Error('crash before publish'); };
  const response = await f.postCommit(f.room, commitHeader(rotation, { keepBlobs: [keptBlob] }), SNAPSHOT, f.owner.cookie);
  assert.equal(response.status, STATUS.UNAVAILABLE);
  assert.deepEqual(f.closed, []);
  await f.ldb.destroy();
  const reopened = new LeveldbPersistence(f.directory);
  t.after(() => reopened.destroy());
  const lock = decodeLockRecord(await reopened.getMeta(f.room.docName, ROOM_LOCK_META));
  assert.deepEqual([lock.keyEpoch, lock.lockRevision, lock.verifier], [1, 1, NEXT_KEY.lock.verifier]);
  const log = new E2ERoomLog({ ldb: reopened, maxRoomBytes: MAX_ROOM_BYTES, reserveStore: () => () => {}, hasCapacity: () => true });
  const state = await log.open(f.room.docName);
  assert.deepEqual(state.updates, []);
  assert.deepEqual([state.snapshot.baseSeq, [...state.snapshot.bytes]], [1, [...SNAPSHOT]]);
  const blobs = Object.fromEntries(state.blobs.map((entry) => [entry.id, entry]));
  assert.ok(blobs[oldBlob].retiredAt !== undefined);
  assert.equal(blobs[keptBlob].stagedFor, null);
});

const HELD_POLL_MS = 5;
const SPLIT_AT_BYTES = 8;

/** Sends the headers and the first bytes of a body, holding the rest until `finish()`. */
function pausedPost(f, path, headers, body) {
  const request = http.request(`${f.base}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-length': body.length, ...headers } });
  const status = new Promise((resolve, reject) => {
    request.on('response', (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  request.write(body.subarray(0, SPLIT_AT_BYTES));
  return { status, finish: () => request.end(body.subarray(SPLIT_AT_BYTES)) };
}

// Resolves once some operation holds a fence entry on the room (the paused route has been admitted).
async function entryHeld(fence, docName) {
  const deadline = Date.now() + EARLY_RESPONSE_MS;
  while (await fence.drained(docName, 0)) {
    if (Date.now() > deadline) throw new Error('no entry was taken');
    await new Promise((resolve) => { setTimeout(resolve, HELD_POLL_MS); });
  }
}

const deleterOf = (f) => new RoomDeletion({
  fence: f.fence, journal: new DeletionJournal(f.ldb), registry: f.registry,
  plainRooms: { retire: async () => {} }, e2eRooms: { retireRoom: (docName) => f.roomLog.retire(docName) },
  files: async () => 0, onStorageFailure() {}, log: { error() {}, warn() {} },
});

async function assertDeletedWithoutLock(f, deleting) {
  assert.deepEqual(await deleting, { deleted: true, files: 0 });
  assert.equal(f.registry.isLocked(f.room.docName), false, 'no lock was re-published');
  assert.equal(f.registry.lockFor(f.room.docName), null);
  assert.equal((await f.ldb.getMetas(f.room.docName)).size, 0, 'no row remains');
}

test('a password change paused during a delete answers 404, re-publishes no lock, and leaves no row', async (t) => {
  const f = await lockedRoom(t);
  const change = await rewrapRoomLock({ currentPassword: PASSWORD, lock: ROOM_LOCK.lock, newPassword: NEXT_PASSWORD });
  const body = Buffer.from(JSON.stringify({ oldAuthKey: change.oldAuthKey, expectedRevision: 0, lock: change.lock }));
  const paused = pausedPost(f, `/api/rooms/${f.room.handle}/lock/password`, { cookie: f.owner.cookie, 'content-type': 'application/json' }, body);
  await entryHeld(f.fence, f.room.docName);
  const deleting = deleterOf(f).deleteRoom(f.room.docName);
  paused.finish();
  assert.equal(await paused.status, STATUS.NOT_FOUND);
  await assertDeletedWithoutLock(f, deleting);
});

test('a rotation commit paused during a delete answers 404, re-publishes no lock, and leaves no row', async (t) => {
  const f = await lockedRoom(t);
  const rotation = await begin(f);
  const json = Buffer.from(JSON.stringify(commitHeader(rotation)));
  const prefix = Buffer.alloc(HEADER_LENGTH_BYTES);
  prefix.writeUInt32BE(json.length);
  const body = Buffer.concat([prefix, json, Buffer.from(SNAPSHOT)]);
  const paused = pausedPost(f, `/api/rooms/${f.room.handle}/lock/rotate/commit`, { cookie: f.owner.cookie, 'content-type': 'application/octet-stream' }, body);
  await entryHeld(f.fence, f.room.docName);
  const deleting = deleterOf(f).deleteRoom(f.room.docName);
  paused.finish();
  assert.equal(await paused.status, STATUS.NOT_FOUND);
  await assertDeletedWithoutLock(f, deleting);
  assert.deepEqual(f.closed, [], 'no key-rotated close was sent for a deleted room');
});

test('a commit already queued when the delete starts lands, but the route answers 404 and does not re-publish', async (t) => {
  const f = await lockedRoom(t);
  const rotation = await begin(f);
  const verify = f.verifier.check.bind(f.verifier);
  let deleting = null;
  // The delete starts while the commit is inside the log chain, verifying the password.
  f.verifier.check = (...args) => {
    deleting ??= deleterOf(f).deleteRoom(f.room.docName);
    return verify(...args);
  };
  const response = await f.postCommit(f.room, commitHeader(rotation), SNAPSHOT, f.owner.cookie);
  assert.equal(response.status, STATUS.NOT_FOUND);
  await assertDeletedWithoutLock(f, deleting);
});
