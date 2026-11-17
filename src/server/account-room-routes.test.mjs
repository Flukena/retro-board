import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createAuthRoutes } from './auth-routes.js';
import { AccountStore } from './account-store.js';
import { ACCOUNT_SESSION_TTL_MS, AccountSessions } from './auth-session.js';
import { FlowLedger } from './auth-google.js';
import { STORAGE_FAILURE_CODE, checkedStorage, durableMetaBatch, storageOperationError } from './relay-storage.js';
import { RoomRegistry } from './relay-room-registry.js';
import { lockRecord } from './room-lock-fixtures.mjs';
import { pausedPost } from '../test-support/paused-request.mjs';
import { RETENTION_CLASS, ROOM_KIND } from '../domain/room-ownership.js';
import { BOARD_TITLE_MAX_LENGTH } from '../domain/security-boundaries.js';
import { ACCOUNT_ROOM_ACTIONS_PER_MINUTE, createAccountRoomRoutes } from './account-room-routes.js';
import { TITLE_WRITE_STATUS } from './room-title-writer.js';
import { roomCodeOf } from './room-links.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const BOARD_ORIGIN = 'https://board.example';
const OTHER_ORIGIN = 'https://evil.example';
const MAX_COOKIE_HEADER_BYTES = 4096;
const MAX_BODY_BYTES = 4096;
const KEY_BYTES = 32;
const MAX_ROOMS = 50;
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const QUIET = Object.freeze({ warn() {}, error() {}, log() {} });
const NO_USAGE = { complete: true, roomsByHandle: new Map() };
const OAUTH = Object.freeze({ clientId: 'client-1', clientSecret: 'secret-1', redirectUri: `${BOARD_ORIGIN}/api/auth/google/callback` });
const OWNER_PROFILE = Object.freeze({ sub: 'google-owner', email: 'owner@example.com', name: 'Owner' });
const OTHER_PROFILE = Object.freeze({ sub: 'google-other', email: 'other@example.com', name: 'Other' });
const ROOMS = '/api/account/rooms';
const TITLE = 'Sprint 42 retro';
const MISSING_CODE = 'Nope2345';
const STATUS = Object.freeze({
  OK: 200, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409, TOO_MANY: 429, UNAVAILABLE: 503,
});
// Headers that legitimately differ between any two responses.
const VOLATILE_HEADERS = new Set(['date', 'keep-alive', 'connection']);

const titlePath = (code) => `${ROOMS}/${code}/title`;
const deletePath = (code) => `${ROOMS}/${code}/delete`;
const cookieValue = (setCookie) => setCookie.split(';')[0];

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'account-rooms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function openRegistry(dir) {
  const ldb = new LeveldbPersistence(join(dir, 'db'));
  const registry = new RoomRegistry({
    persistence: {
      ...checkedStorage(ldb, Y), durableMetaBatch: (docName, ops) => durableMetaBatch(ldb, docName, ops),
      hasCapacity: () => true, reserveStore: () => () => {}, measureDatabase: () => 0,
    },
    Y, maxRooms: MAX_ROOMS, maxDatabaseBytes: UNLIMITED, signingKey: Buffer.alloc(KEY_BYTES), log: QUIET,
  });
  await registry.hydrate(NO_USAGE);
  return { ldb, registry };
}

/** Records every title write and delete; their answers can be swapped per test. */
function roomPorts() {
  const ports = {
    titles: new Map(), writes: [], deletes: [], storageFailures: [],
    writeResult: TITLE_WRITE_STATUS.OK, deleteResult: () => Promise.resolve({ deleted: true, files: 0 }),
  };
  ports.readTitle = async (docName) => ports.titles.get(docName) ?? null;
  ports.writeTitle = async (docName, title) => { ports.writes.push([docName, title]); return ports.writeResult; };
  ports.deleteRoom = (docName) => { ports.deletes.push(docName); return ports.deleteResult(); };
  return ports;
}

async function startRoutes(t) {
  const dir = await tempDir(t);
  const { ldb, registry } = await openRegistry(dir);
  const store = new AccountStore({ ldb, getMeta: checkedStorage(ldb, Y).getMeta, hasCapacity: () => true });
  t.after(() => ldb.destroy());
  const accountKey = randomBytes(KEY_BYTES);
  const sessions = new AccountSessions({ signingKey: accountKey, allowInsecureHttp: false, maxCookieHeaderBytes: MAX_COOKIE_HEADER_BYTES });
  const ports = roomPorts();
  const accountRooms = createAccountRoomRoutes({
    registry, store, maxBodyBytes: MAX_BODY_BYTES, log: QUIET, onStorageFailure: (error) => ports.storageFailures.push(error.code),
    readTitle: (docName) => ports.readTitle(docName), writeTitle: ports.writeTitle, deleteRoom: ports.deleteRoom,
  });
  const routes = createAuthRoutes({
    oauth: OAUTH, accountKey, sessions, store, ledger: new FlowLedger(), allowedOrigins: [BOARD_ORIGIN], allowInsecureHttp: false,
    maxCookieHeaderBytes: MAX_COOKIE_HEADER_BYTES, fetchImpl: null, rejectionCounters: { increment() {} }, accountRooms,
  });
  const lifecycle = { unavailable: false };
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!routes.handle(req, res, pathname, { prefixed: false, clientIp: '203.0.113.1', unavailable: () => lifecycle.unavailable })) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const signIn = async (profile) => {
    const account = await store.upsertFromGoogle(profile);
    return { account, cookie: cookieValue(sessions.createCookie(account.id, account.sessionGeneration, '/api')) };
  };
  const createRoom = async (owner) => {
    const room = await registry.createRoom(owner);
    return { ...room, docName: registry.registeredDocForCapability(room.code, room.token) };
  };
  return { base, registry, store, sessions, ports, signIn, createRoom, lifecycle };
}

const get = (ctx, path, { cookie, origin } = {}) => fetch(`${ctx.base}${path}`, {
  headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
});
const post = (ctx, path, body, { cookie, origin = BOARD_ORIGIN } = {}) => fetch(`${ctx.base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
  body: JSON.stringify(body),
});
const rename = (ctx, code, cookie, title = TITLE, options = {}) => post(ctx, titlePath(code), { title }, { cookie, ...options });
const remove = (ctx, code, cookie, confirmCode = code, options = {}) => post(ctx, deletePath(code), { confirmCode }, { cookie, ...options });

async function snapshot(response) {
  const headers = [...response.headers].filter(([name]) => !VOLATILE_HEADERS.has(name));
  return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()).toString('base64') };
}

const ownedBoard = (account) => ({ owner: { kind: ROOM_KIND.BOARD, accountId: account.id } });

test('the owner lists their rooms newest first, with kind-aware links, live titles and no title for locked rooms', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  const board = await ctx.createRoom(ownedBoard(account));
  const poker = await ctx.createRoom({ owner: { kind: ROOM_KIND.POKER, accountId: account.id } });
  const locked = await ctx.createRoom({ lock: lockRecord({ ownerAccountId: account.id }) });
  await ctx.createRoom({ owner: { kind: ROOM_KIND.BOARD, accountId: null } });
  ctx.ports.titles.set(board.docName, TITLE);
  ctx.ports.titles.set(locked.docName, 'must never be read');

  const response = await get(ctx, ROOMS, { cookie });
  assert.equal(response.status, STATUS.OK);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { rooms } = await response.json();
  assert.deepEqual(new Set(rooms.map((room) => room.code)), new Set([board.code, poker.code, locked.code]));
  const byCode = new Map(rooms.map((room) => [room.code, room]));
  assert.deepEqual(Object.keys(byCode.get(board.code)).sort(), ['code', 'createdAt', 'kind', 'lastActiveAt', 'link', 'locked', 'title'].sort());
  assert.deepEqual(byCode.get(board.code), {
    ...byCode.get(board.code), kind: ROOM_KIND.BOARD, locked: false, title: TITLE, link: `/b/${board.code}#${board.token}`,
  });
  assert.equal(byCode.get(poker.code).link, `/p/${poker.code}#${poker.token}`);
  assert.equal(byCode.get(poker.code).kind, ROOM_KIND.POKER);
  assert.deepEqual({ ...byCode.get(locked.code) }, {
    ...byCode.get(locked.code), locked: true, title: null, link: `/b/${locked.code}#${locked.token}`,
  });
  const created = rooms.map((room) => room.createdAt);
  assert.deepEqual(created, [...created].sort((a, b) => b - a), 'newest first');
  assert.equal(rooms.length, 3, 'a guest room is never listed');
});

test('a same-origin GET without Origin is answered; an allowed Origin gets credential CORS; a foreign one is refused', async (t) => {
  const ctx = await startRoutes(t);
  const { cookie } = await ctx.signIn(OWNER_PROFILE);
  assert.equal((await get(ctx, ROOMS, { cookie })).status, STATUS.OK);
  const allowed = await get(ctx, ROOMS, { cookie, origin: BOARD_ORIGIN });
  assert.equal(allowed.status, STATUS.OK);
  assert.equal(allowed.headers.get('access-control-allow-origin'), BOARD_ORIGIN);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  assert.equal((await get(ctx, ROOMS, { cookie, origin: OTHER_ORIGIN })).status, STATUS.FORBIDDEN);
});

test('writes need an allowed Origin, and the preflight answers like the account preflight', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  const room = await ctx.createRoom(ownedBoard(account));
  for (const path of [titlePath(room.code), deletePath(room.code), ROOMS]) {
    const preflight = await fetch(`${ctx.base}${path}`, { method: 'OPTIONS', headers: { origin: BOARD_ORIGIN } });
    assert.equal(preflight.status, STATUS.NO_CONTENT, path);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-origin'), BOARD_ORIGIN);
    const foreign = await fetch(`${ctx.base}${path}`, { method: 'OPTIONS', headers: { origin: OTHER_ORIGIN } });
    assert.equal(foreign.status, STATUS.FORBIDDEN, path);
  }
  for (const origin of [OTHER_ORIGIN, null]) {
    assert.equal((await rename(ctx, room.code, cookie, TITLE, { origin })).status, STATUS.FORBIDDEN);
    assert.equal((await remove(ctx, room.code, cookie, room.code, { origin })).status, STATUS.FORBIDDEN);
  }
  assert.equal((await get(ctx, titlePath(room.code), { cookie })).status, STATUS.METHOD_NOT_ALLOWED);
  assert.deepEqual(ctx.ports.writes, []);
  assert.deepEqual(ctx.ports.deletes, []);
});

test('signed out, expired, revoked and deleted-account cookies get 401 on every route and change nothing', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  const room = await ctx.createRoom(ownedBoard(account));
  const expiredAt = Date.now() - ACCOUNT_SESSION_TTL_MS - 1;
  t.mock.method(Date, 'now', () => expiredAt);
  const expired = cookieValue(ctx.sessions.createCookie(account.id, account.sessionGeneration, '/api'));
  Date.now.mock.restore();
  const assertRefused = async (label, refusedCookie) => {
    for (const response of [
      await get(ctx, ROOMS, { cookie: refusedCookie }),
      await rename(ctx, room.code, refusedCookie),
      await remove(ctx, room.code, refusedCookie),
    ]) {
      assert.equal(response.status, STATUS.UNAUTHORIZED, label);
      assert.equal(response.headers.get('cache-control'), 'no-store', label);
    }
  };
  await assertRefused('signed out', null);
  await assertRefused('expired', expired);
  await ctx.store.bumpSessionGeneration(account.id);
  await assertRefused('revoked', cookie);
  const current = await ctx.store.get(account.id);
  const fresh = cookieValue(ctx.sessions.createCookie(account.id, current.sessionGeneration, '/api'));
  await ctx.store.delete(account.id);
  await assertRefused('deleted account', fresh);
  assert.deepEqual(ctx.ports.writes, []);
  assert.deepEqual(ctx.ports.deletes, []);
});

test("another account's room, a missing room, a guessed code and a room with no owner all get the same 404", async (t) => {
  const ctx = await startRoutes(t);
  const owner = await ctx.signIn(OWNER_PROFILE);
  const other = await ctx.signIn(OTHER_PROFILE);
  const owned = await ctx.createRoom(ownedBoard(owner.account));
  const unowned = await ctx.createRoom();
  const probes = [owned.code, MISSING_CODE, unowned.code, 'not*a*code'];
  const responses = [];
  for (const code of probes) {
    responses.push(await snapshot(await rename(ctx, code, other.cookie)));
    responses.push(await snapshot(await remove(ctx, code, other.cookie)));
  }
  assert.equal(responses[0].status, STATUS.NOT_FOUND);
  for (const response of responses) assert.deepEqual(response, responses[0]);
  assert.deepEqual((await (await get(ctx, ROOMS, { cookie: other.cookie })).json()).rooms, []);
  assert.deepEqual(ctx.ports.writes, []);
  assert.deepEqual(ctx.ports.deletes, []);
});

test('the owner renames through the title writer; locked rooms, bad titles and writer outcomes map to their answers', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  const room = await ctx.createRoom(ownedBoard(account));
  const locked = await ctx.createRoom({ lock: lockRecord({ ownerAccountId: account.id }) });

  const renamed = await rename(ctx, room.code, cookie);
  assert.equal(renamed.status, STATUS.OK);
  assert.deepEqual(await renamed.json(), { title: TITLE });
  assert.deepEqual(ctx.ports.writes, [[room.docName, TITLE]]);

  const lockedRename = await rename(ctx, locked.code, cookie);
  assert.equal(lockedRename.status, STATUS.CONFLICT);
  assert.deepEqual(await lockedRename.json(), { error: 'locked-room' });
  for (const title of ['', ' padded ', 'x'.repeat(BOARD_TITLE_MAX_LENGTH + 1), 42]) {
    assert.equal((await rename(ctx, room.code, cookie, title)).status, STATUS.BAD_REQUEST, String(title).slice(0, 12));
  }
  assert.equal((await post(ctx, titlePath(room.code), { title: TITLE, extra: 1 }, { cookie })).status, STATUS.BAD_REQUEST);
  assert.equal(ctx.ports.writes.length, 1);

  ctx.ports.writeResult = TITLE_WRITE_STATUS.UNAVAILABLE;
  assert.equal((await rename(ctx, room.code, cookie)).status, STATUS.UNAVAILABLE);
  ctx.ports.writeResult = TITLE_WRITE_STATUS.NOT_FOUND;
  const deletedMeanwhile = await snapshot(await rename(ctx, room.code, cookie));
  assert.deepEqual(deletedMeanwhile, await snapshot(await rename(ctx, MISSING_CODE, cookie)));
});

test('delete needs the matching confirm code, and the deleter outcome maps to 204, 404 or 503', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  const room = await ctx.createRoom(ownedBoard(account));
  assert.equal((await remove(ctx, room.code, cookie, 'Wrong234')).status, STATUS.BAD_REQUEST);
  assert.equal((await post(ctx, deletePath(room.code), {}, { cookie })).status, STATUS.BAD_REQUEST);
  assert.deepEqual(ctx.ports.deletes, []);

  ctx.ports.deleteResult = () => Promise.resolve({ deleted: false, status: STATUS.UNAVAILABLE });
  assert.equal((await remove(ctx, room.code, cookie)).status, STATUS.UNAVAILABLE);
  ctx.ports.deleteResult = () => Promise.reject(new Error('disk gone'));
  assert.equal((await remove(ctx, room.code, cookie)).status, STATUS.UNAVAILABLE);
  ctx.ports.deleteResult = () => Promise.resolve({ deleted: false, status: STATUS.NOT_FOUND });
  assert.equal((await remove(ctx, room.code, cookie)).status, STATUS.NOT_FOUND);
  ctx.ports.deleteResult = () => Promise.resolve({ deleted: true, files: 0 });
  const deleted = await remove(ctx, room.code, cookie);
  assert.equal(deleted.status, STATUS.NO_CONTENT);
  assert.deepEqual(ctx.ports.deletes, Array(4).fill(room.docName));
});

test('a stopped account store answers 503 instead of acting', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  const room = await ctx.createRoom(ownedBoard(account));
  await ctx.store.stop();
  assert.equal((await rename(ctx, room.code, cookie)).status, STATUS.UNAVAILABLE);
  assert.equal((await remove(ctx, room.code, cookie)).status, STATUS.UNAVAILABLE);
  assert.equal((await get(ctx, ROOMS, { cookie })).status, STATUS.UNAVAILABLE);
  assert.deepEqual(ctx.ports.writes, []);
  assert.deepEqual(ctx.ports.deletes, []);
});

test('a relay that is shutting down or failed answers 503 on every room route', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  const room = await ctx.createRoom(ownedBoard(account));
  ctx.lifecycle.unavailable = true;
  assert.equal((await get(ctx, ROOMS, { cookie })).status, STATUS.UNAVAILABLE);
  assert.equal((await rename(ctx, room.code, cookie)).status, STATUS.UNAVAILABLE);
  assert.equal((await remove(ctx, room.code, cookie)).status, STATUS.UNAVAILABLE);
  assert.deepEqual(ctx.ports.writes, []);
  assert.deepEqual(ctx.ports.deletes, []);
});

test('a storage failure while reading titles answers 503 and is latched, never listed as a room without a title', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  await ctx.createRoom(ownedBoard(account));
  ctx.ports.readTitle = async () => { throw storageOperationError('getYDoc failed'); };
  assert.equal((await get(ctx, ROOMS, { cookie })).status, STATUS.UNAVAILABLE);
  assert.deepEqual(ctx.ports.storageFailures, [STORAGE_FAILURE_CODE]);
});

// Resolves once the request has been authenticated: the relay is then waiting for the rest of the body.
function authenticated(store) {
  const read = store.get.bind(store);
  let reached;
  const promise = new Promise((resolve) => { reached = resolve; });
  store.get = async (id) => {
    const account = await read(id);
    reached();
    return account;
  };
  return promise;
}

for (const [label, pathOf, bodyOf] of [
  ['rename', titlePath, () => ({ title: TITLE })],
  ['delete', deletePath, (code) => ({ confirmCode: code })],
]) {
  test(`a ${label} paused after authentication, racing logout-all, gets 401 and changes nothing`, async (t) => {
    const ctx = await startRoutes(t);
    const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
    const room = await ctx.createRoom(ownedBoard(account));
    const admitted = authenticated(ctx.store);
    const paused = pausedPost(`${ctx.base}${pathOf(room.code)}`, {
      headers: { origin: BOARD_ORIGIN, cookie, 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(bodyOf(room.code))),
    });
    await admitted;
    await ctx.store.bumpSessionGeneration(account.id, { expectedGeneration: account.sessionGeneration });
    paused.finish();
    assert.equal(await paused.status, STATUS.UNAUTHORIZED);
    assert.deepEqual(ctx.ports.writes, []);
    assert.deepEqual(ctx.ports.deletes, []);
  });
}

test('each account has its own bucket of 30 room actions a minute; past it, 429 with retry-after', async (t) => {
  const ctx = await startRoutes(t);
  const owner = await ctx.signIn(OWNER_PROFILE);
  const other = await ctx.signIn(OTHER_PROFILE);
  const room = await ctx.createRoom(ownedBoard(owner.account));
  for (let index = 0; index < ACCOUNT_ROOM_ACTIONS_PER_MINUTE; index += 1) {
    assert.equal((await rename(ctx, room.code, owner.cookie)).status, STATUS.OK, `action ${index}`);
  }
  const limited = await rename(ctx, room.code, owner.cookie);
  assert.equal(limited.status, STATUS.TOO_MANY);
  assert.match(limited.headers.get('retry-after'), /^\d+$/);
  assert.equal((await remove(ctx, room.code, owner.cookie)).status, STATUS.TOO_MANY);
  assert.equal(ctx.ports.deletes.length, 0);
  assert.equal((await get(ctx, ROOMS, { cookie: other.cookie })).status, STATUS.OK, 'another account is not limited');
  assert.equal(ACCOUNT_ROOM_ACTIONS_PER_MINUTE, 30);
});

test('deleting the account orphans every room it owned; they stay kept and leave its list', async (t) => {
  const ctx = await startRoutes(t);
  const { account, cookie } = await ctx.signIn(OWNER_PROFILE);
  const board = await ctx.createRoom(ownedBoard(account));
  const locked = await ctx.createRoom({ lock: lockRecord({ ownerAccountId: account.id }) });
  const deleted = await post(ctx, '/api/account/delete', {}, { cookie });
  assert.equal(deleted.status, STATUS.NO_CONTENT);
  assert.deepEqual(ctx.registry.roomsOwnedBy(account.id), []);
  for (const docName of [board.docName, locked.docName]) {
    const ownership = ctx.registry.ownershipOf(docName);
    assert.equal(ownership.ownerAccountId, null);
    assert.equal(ownership.retention, RETENTION_CLASS.KEPT);
    assert.equal(typeof ownership.record.orphanedAt, 'number');
  }
  assert.equal(roomCodeOf(board.docName), board.code);
});
