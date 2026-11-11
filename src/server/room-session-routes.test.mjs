import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { AccountStore } from './account-store.js';
import { AccountSessions } from './auth-session.js';
import { RoomRegistry } from './relay-room-registry.js';
import { RoomSessions } from './relay-session.js';
import { checkedStorage, durableMetaBatch } from './relay-storage.js';
import { CORRUPT_LOCK, RoomLockVerifier, WRONG_PASSWORDS_PER_IP_ROOM } from './room-lock.js';
import { createRoomSessionRoutes } from './room-session-routes.js';
import { PLAN } from '../domain/plan-entitlements.js';
import { ROOM_SESSION_RENEWAL_SUFFIX } from '../domain/room-lock-contract.js';
import { RIGHT_KEY, WRONG_KEY, lockRecord } from './room-lock-fixtures.mjs';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const ORIGIN = 'https://board.example';
const IP = '203.0.113.7';
const KEY_BYTES = 32;
const TTL_MS = 60_000;
const COOKIE_HEADER_BYTES = 4096;
const MAX_BODY_BYTES = 1024;
const TOO_LARGE = 413;
const NOT_FOUND = 404;
const FIXED_NOW_MS = 1_800_000_000_000;
const MAX_ROOMS = 50;
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const OK = 200;
const CREATED = 201;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const CONFLICT = 409;
const TOO_MANY = 429;
const UNAVAILABLE = 503;

const lockParams = () => {
  const { salt, kdf, verifier, wrappedDek, wrapIv } = lockRecord();
  return { salt, kdf, verifier, wrappedDek, wrapIv };
};

async function fixture(t, { storedPlan } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'room-session-routes-'));
  const ldb = new LeveldbPersistence(directory);
  t.after(async () => { await ldb.destroy(); await rm(directory, { recursive: true, force: true }); });
  const storage = checkedStorage(ldb, Y);
  const registry = new RoomRegistry({
    persistence: {
      ...storage, durableMetaBatch: (doc, ops) => durableMetaBatch(ldb, doc, ops),
      hasCapacity: () => true, reserveStore: () => () => {}, measureDatabase: () => 0,
    },
    Y, maxRooms: MAX_ROOMS, maxDatabaseBytes: UNLIMITED, signingKey: randomBytes(KEY_BYTES), log: { warn() {}, error() {} },
  });
  await registry.hydrate({ complete: true, roomsByHandle: new Map() });
  const signingKey = randomBytes(KEY_BYTES);
  const sessions = new RoomSessions({
    signingKey, rooms: registry.registeredRoomsByHandle, ttlMs: TTL_MS, maxCookieHeaderBytes: COOKIE_HEADER_BYTES,
    allowInsecureHttp: false,
    epochOf: (doc) => { const lock = registry.lockFor(doc); return lock === CORRUPT_LOCK ? -1 : lock?.keyEpoch ?? null; },
  });
  const accountSessions = new AccountSessions({ signingKey: randomBytes(KEY_BYTES), allowInsecureHttp: false, maxCookieHeaderBytes: COOKIE_HEADER_BYTES });
  const realStore = new AccountStore({ ldb, getMeta: storage.getMeta, hasCapacity: () => true });
  // Stands in for a plan value the entitlement table does not know (setPlan refuses to store one).
  const accountStore = storedPlan === undefined ? realStore : {
    upsertFromGoogle: (profile) => realStore.upsertFromGoogle(profile),
    get: async (id) => ({ ...(await realStore.get(id)), plan: storedPlan }),
  };
  const failures = [];
  const routes = createRoomSessionRoutes({
    registry, sessions, verifier: new RoomLockVerifier(), accountSessions, accountStore,
    buckets: { takeCreateToken: () => 0, takeSessionExchangeToken: () => true, failureAttemptAvailable: () => true, recordSessionFailure: () => failures.push(1) },
    config: { allowedOrigins: [ORIGIN], allowInsecureHttp: false, sessionTtlMs: TTL_MS, maxApiBodyBytes: MAX_BODY_BYTES },
    unavailable: () => false, onStorageFailure() {},
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/api/rooms') void routes.handleCreateRoom(req, res, IP);
    else if (!routes.handle(req, res, req.url, { clientIp: IP, prefixed: false, hasQueryOrFragment: false })) {
      void routes.handleRoomSession(req, res, IP, false);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie) => fetch(`${base}${path}`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const signIn = async (email, plan) => {
    const account = await accountStore.upsertFromGoogle({ sub: `sub-${email}`, email, name: email });
    if (plan) await accountStore.setPlan(account.id, plan);
    const cookie = accountSessions.createCookie(account.id, account.sessionGeneration, '/api').split(';')[0];
    return { account, cookie };
  };
  return { registry, sessions, accountStore, post, signIn, signingKey, base, failures };
}

async function lockedRoom(f, owner) {
  const response = await f.post('/api/rooms', { lock: lockParams() }, owner.cookie);
  assert.equal(response.status, CREATED);
  return response.json();
}

const cookieHeaderOf = (response) => response.headers.getSetCookie()[0].split(';')[0];
const cookieRequest = (cookie) => ({ headers: { cookie } });

// The pre-change cookie format (10673b7:src/server/relay-session.js), built without the code under test.
const legacyCookie = (key, handle, expiresAt, docName) => {
  const signature = createHmac('sha256', key).update('room-session-v1\0').update(handle).update('\0')
    .update(String(expiresAt)).update('\0').update(docName).digest('base64url');
  const maxAge = Math.max(1, Math.floor((expiresAt - FIXED_NOW_MS) / 1000));
  return `rb_room_session=v1.${handle}.${expiresAt}.${signature}; Path=/rooms/${handle}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Secure`;
};

test('a normal room is created and exchanged exactly as before, with an unbound cookie', async (t) => {
  t.mock.method(Date, 'now', () => FIXED_NOW_MS);
  const f = await fixture(t);
  const created = await f.post('/api/rooms', {});
  assert.equal(created.status, CREATED);
  const room = await created.json();
  assert.deepEqual(Object.keys(room).sort(), ['code', 'token']);
  const exchanged = await f.post('/api/room-session', room);
  assert.equal(exchanged.status, OK);
  const body = await exchanged.json();
  assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'roomHandle']);
  const docName = f.registry.registeredDocForCapability(room.code, room.token);
  assert.equal(exchanged.headers.getSetCookie()[0], legacyCookie(f.signingKey, body.roomHandle, body.expiresAt, docName));
  assert.equal((await f.post('/api/rooms', { other: 1 })).status, BAD_REQUEST);
});

test('authKey on a normal room is a 400 and sets no cookie', async (t) => {
  const f = await fixture(t);
  const room = await (await f.post('/api/rooms', {})).json();
  const response = await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY });
  assert.equal(response.status, BAD_REQUEST);
  assert.deepEqual(response.headers.getSetCookie(), []);
});

test('locked creation: bad params 400, no account 401, unknown plan 403, free and pro 201', async (t) => {
  const f = await fixture(t);
  const free = await f.signIn('free@example.com');
  assert.equal((await f.post('/api/rooms', { lock: { ...lockParams(), verifier: 'x' } }, free.cookie)).status, BAD_REQUEST);
  assert.equal((await f.post('/api/rooms', { lock: lockParams(), extra: 1 }, free.cookie)).status, BAD_REQUEST);
  assert.equal((await f.post('/api/rooms', { lock: lockParams() })).status, UNAUTHORIZED);
  assert.equal((await f.post('/api/rooms', { lock: lockParams() }, 'rb_account=junk')).status, UNAUTHORIZED);
  const created = await f.post('/api/rooms', { lock: lockParams() }, free.cookie);
  assert.equal(created.status, CREATED);
  const room = await created.json();
  const docName = f.registry.registeredDocForCapability(room.code, room.token);
  assert.deepEqual(
    { ...f.registry.lockFor(docName), createdAt: 0 },
    { ...lockRecord({ ownerAccountId: free.account.id }), createdAt: 0 },
  );
  const pro = await f.signIn('pro@example.com', PLAN.PRO);
  assert.equal((await f.post('/api/rooms', { lock: lockParams() }, pro.cookie)).status, CREATED);
});

test('an unknown plan may not create a locked room', async (t) => {
  const f = await fixture(t, { storedPlan: 'enterprise' });
  const stranger = await f.signIn('stranger@example.com');
  const response = await f.post('/api/rooms', { lock: lockParams() }, stranger.cookie);
  assert.equal(response.status, FORBIDDEN);
});

test('a locked room answers 409 with only salt and kdf, and no cookie', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn('owner@example.com');
  const room = await lockedRoom(f, owner);
  const response = await f.post('/api/room-session', room);
  assert.equal(response.status, CONFLICT);
  const { salt, kdf } = lockParams();
  assert.deepEqual(await response.json(), { locked: true, salt, kdf });
  assert.deepEqual(response.headers.getSetCookie(), []);
});

test('the right authKey returns the wrapped key and an epoch-bound cookie; isOwner follows the account cookie', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn('owner@example.com');
  const other = await f.signIn('other@example.com');
  const room = await lockedRoom(f, owner);
  const docName = f.registry.registeredDocForCapability(room.code, room.token);
  const { wrappedDek, wrapIv } = lockParams();
  const asOwner = await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY }, owner.cookie);
  assert.equal(asOwner.status, OK);
  const body = await asOwner.json();
  assert.deepEqual(body.lock, { wrappedDek, wrapIv, keyEpoch: 0, lockRevision: 0, isOwner: true });
  const handle = body.roomHandle;
  assert.deepEqual(f.sessions.authenticate(cookieRequest(cookieHeaderOf(asOwner)), handle)?.docName, docName);
  const isOwnerFor = async (cookie) => (await (await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY }, cookie)).json()).lock.isOwner;
  assert.equal(await isOwnerFor(other.cookie), false);
  assert.equal(await isOwnerFor(undefined), false);
});

test('the session response carries the current lock revision, which advances with the record', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn('owner@example.com');
  const room = await lockedRoom(f, owner);
  const docName = f.registry.registeredDocForCapability(room.code, room.token);
  const revisionOf = async () => (await (await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY }, owner.cookie)).json()).lock.lockRevision;
  const before = await revisionOf();
  f.registry.publishLock(docName, { ...f.registry.lockFor(docName), lockRevision: before + 3 });
  assert.equal(await revisionOf(), before + 3);
});

test('a cookie issued at epoch 0 stops authenticating once the epoch is 1', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn('owner@example.com');
  const room = await lockedRoom(f, owner);
  const docName = f.registry.registeredDocForCapability(room.code, room.token);
  const response = await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY });
  const { roomHandle } = await response.json();
  const request = cookieRequest(cookieHeaderOf(response));
  assert.ok(f.sessions.authenticate(request, roomHandle));
  f.registry.publishLock(docName, { ...f.registry.lockFor(docName), keyEpoch: 1, lockRevision: 1 });
  assert.equal(f.sessions.authenticate(request, roomHandle), null);
  const renewed = await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY });
  assert.ok(f.sessions.authenticate(cookieRequest(cookieHeaderOf(renewed)), roomHandle), 'a fresh exchange binds to epoch 1');
});

test('a wrong authKey is a 403 without a cookie', async (t) => {
  const f = await fixture(t);
  const room = await lockedRoom(f, await f.signIn('owner@example.com'));
  const response = await f.post('/api/room-session', { ...room, authKey: WRONG_KEY });
  assert.equal(response.status, FORBIDDEN);
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal((await f.post('/api/room-session', { ...room, authKey: 'not-a-key' })).status, BAD_REQUEST);
});

test('after five wrong keys the next attempt is 429 with retry-after and no cookie, even for the right key', async (t) => {
  const f = await fixture(t);
  const room = await lockedRoom(f, await f.signIn('owner@example.com'));
  for (let attempt = 0; attempt < WRONG_PASSWORDS_PER_IP_ROOM; attempt += 1) {
    assert.equal((await f.post('/api/room-session', { ...room, authKey: WRONG_KEY })).status, FORBIDDEN);
  }
  for (const authKey of [WRONG_KEY, RIGHT_KEY]) {
    const limited = await f.post('/api/room-session', { ...room, authKey });
    assert.equal(limited.status, TOO_MANY);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.deepEqual(limited.headers.getSetCookie(), []);
  }
});

const renewalPath = (roomHandle) => `/rooms/${roomHandle}${ROOM_SESSION_RENEWAL_SUFFIX}`;

test('renewals with a valid room cookie and a stale authKey are 403 but not counted; the right key then gets 200', async (t) => {
  const f = await fixture(t);
  const room = await lockedRoom(f, await f.signIn('owner@example.com'));
  const unlocked = await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY });
  const { roomHandle } = await unlocked.json();
  const cookie = cookieHeaderOf(unlocked);
  for (let attempt = 0; attempt <= WRONG_PASSWORDS_PER_IP_ROOM; attempt += 1) {
    const renewal = await f.post(renewalPath(roomHandle), { ...room, authKey: WRONG_KEY }, cookie);
    assert.equal(renewal.status, FORBIDDEN);
    assert.deepEqual(renewal.headers.getSetCookie(), []);
  }
  const reunlocked = await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY });
  assert.equal(reunlocked.status, OK);
  const renewed = await f.post(renewalPath(roomHandle), { ...room, authKey: RIGHT_KEY }, cookie);
  assert.equal(renewed.status, OK, 'the room-scoped path also renews with the right key');
  assert.ok(f.sessions.authenticate(cookieRequest(cookieHeaderOf(renewed)), roomHandle));
});

test('a stale authKey on the renewal path is counted without a cookie, or with one from an older epoch', async (t) => {
  const f = await fixture(t);
  const room = await lockedRoom(f, await f.signIn('owner@example.com'));
  const docName = f.registry.registeredDocForCapability(room.code, room.token);
  const unlocked = await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY });
  const { roomHandle } = await unlocked.json();
  const oldEpochCookie = cookieHeaderOf(unlocked);
  f.registry.publishLock(docName, { ...f.registry.lockFor(docName), keyEpoch: 1, lockRevision: 1 });
  const cookies = [undefined, oldEpochCookie];
  for (let attempt = 0; attempt < WRONG_PASSWORDS_PER_IP_ROOM; attempt += 1) {
    const cookie = cookies[attempt % cookies.length];
    assert.equal((await f.post(renewalPath(roomHandle), { ...room, authKey: WRONG_KEY }, cookie)).status, FORBIDDEN);
  }
  assert.equal((await f.post('/api/room-session', { ...room, authKey: RIGHT_KEY })).status, TOO_MANY);
});

test('a room whose lock record is unreadable answers 503', async (t) => {
  const f = await fixture(t);
  const room = await lockedRoom(f, await f.signIn('owner@example.com'));
  f.registry.locksByDoc.set(f.registry.registeredDocForCapability(room.code, room.token), CORRUPT_LOCK);
  for (const body of [room, { ...room, authKey: RIGHT_KEY }]) {
    const response = await f.post('/api/room-session', body);
    assert.equal(response.status, UNAVAILABLE);
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
});

test('a present but non-string authKey is a 400 that does not charge the capability-failure budget', async (t) => {
  const f = await fixture(t);
  const normal = await (await f.post('/api/rooms', {})).json();
  const locked = await lockedRoom(f, await f.signIn('owner@example.com'));
  for (const room of [normal, locked]) {
    for (const authKey of [null, 7, {}, [], true]) {
      const response = await f.post('/api/room-session', { ...room, authKey });
      assert.equal(response.status, BAD_REQUEST);
      assert.deepEqual(response.headers.getSetCookie(), []);
    }
  }
  assert.deepEqual(f.failures, [], 'no failed-capability guess was recorded');
  const guess = await f.post('/api/room-session', { code: 'zzz', token: 'y'.repeat(12), authKey: RIGHT_KEY });
  assert.equal(guess.status, NOT_FOUND);
  assert.equal(f.failures.length, 1, 'a real capability miss is still charged');
});

test('a locked-create body is accepted at exactly 1 KiB and refused one byte over', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn('owner@example.com');
  const body = JSON.stringify({ lock: lockParams() });
  const send = (padding) => fetch(`${f.base}/api/rooms`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: owner.cookie },
    body: `${body}${' '.repeat(padding)}`,
  });
  const exact = MAX_BODY_BYTES - Buffer.byteLength(body);
  assert.ok(exact > 0, 'fixture fits under the limit');
  assert.equal((await send(exact)).status, CREATED);
  assert.equal((await send(exact + 1)).status, TOO_LARGE);
});
