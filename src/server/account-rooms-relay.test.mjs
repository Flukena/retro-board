import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { ORIGIN, PASSWORD, exchange, lockedRelay, post, signIn } from '../test-support/locked-room-harness.mjs';
import { HOOK_PRELOAD, hookOf } from '../test-support/relay-hook-client.mjs';
import { STORAGE_FAILURE_LOG } from './relay-lifecycle.js';
import { createRoomLock } from '../client/room-lock/e2e-crypto.js';
import { ROOM_KIND, ROOM_OWNER_META, ROOM_PATH_PREFIX, decodeOwnerRecord } from '../domain/room-ownership.js';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');

const WAIT_MS = 5_000;
const POLL_MS = 10;
const TITLE = 'Sprint 42 retro';
const ROOMS = '/api/account/rooms';
const UPGRADE_AND_RENAME_ENTRIES = 2;
const STATUS = Object.freeze({ OK: 200, CREATED: 201, NO_CONTENT: 204, NOT_FOUND: 404, UNAVAILABLE: 503 });
const ROOM_LOCK = await createRoomLock(PASSWORD);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Polls `read` until `reached(value)`, failing after WAIT_MS instead of hanging.
async function until(read, reached = Boolean, label = 'condition') {
  const deadline = Date.now() + WAIT_MS;
  let value = await read();
  while (!reached(value)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(POLL_MS);
    value = await read();
  }
  return value;
}

async function hookedRelay(t, { env = {}, root = null } = {}) {
  const relayEnv = await lockedRelay(t, env, { preload: HOOK_PRELOAD, root });
  const { call } = await hookOf(relayEnv.relay);
  return { ...relayEnv, hook: call };
}

async function createOwnedRoom({ relay }, cookie, body = {}) {
  const created = await post(relay, '/api/rooms', body, cookie);
  assert.equal(created.status, STATUS.CREATED, relay.output());
  return created.json();
}

const roomSession = async ({ relay }, room) => exchange(relay, room, null);
const listRooms = async (relay, cookie) => {
  const response = await fetch(`${relay.url}${ROOMS}`, { headers: { cookie } });
  assert.equal(response.status, STATUS.OK, relay.output());
  return (await response.json()).rooms;
};
const rename = (relay, code, cookie, title = TITLE) => post(relay, `${ROOMS}/${code}/title`, { title }, cookie);
const removeRoom = (relay, code, cookie) => post(relay, `${ROOMS}/${code}/delete`, { confirmCode: code }, cookie);

/** A plain board peer: a Y.Doc synced through y-websocket with the room's session cookie. */
function openPeer(t, relay, session) {
  const doc = new Y.Doc();
  const PeerSocket = class extends WebSocket {
    constructor(url) { super(url, { origin: ORIGIN, headers: { cookie: session.cookie } }); }
  };
  const provider = new WebsocketProvider(`${relay.wsUrl}/rooms`, session.handle, doc, { WebSocketPolyfill: PeerSocket, disableBc: true });
  t.after(() => { provider.destroy(); doc.destroy(); });
  return { doc, provider, synced: until(() => provider.synced, Boolean, 'peer sync') };
}

const upgradeStatus = (ws) => new Promise((resolve, reject) => {
  ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
  ws.once('open', () => { ws.close(); reject(new Error('upgrade unexpectedly succeeded')); });
  ws.once('error', () => { /* unexpected-response is authoritative */ });
});

const peerTitle = (peer) => peer.doc.getMap('meta').get('title');

async function ownerRecordOf(dbDir, docName) {
  const ldb = new LeveldbPersistence(dbDir);
  try {
    return decodeOwnerRecord(await ldb.getMeta(docName, ROOM_OWNER_META));
  } finally {
    await ldb.destroy();
  }
}

test('renaming a resident room reaches the connected peer and leaves its undo stack alone', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  const session = await roomSession(env, await createOwnedRoom(env, cookie));
  const peer = openPeer(t, env.relay, session);
  await peer.synced;
  const meta = peer.doc.getMap('meta');
  const undo = new Y.UndoManager(meta, { trackedOrigins: new Set(['local']) });
  peer.doc.transact(() => meta.set('note', 'mine'), 'local');
  assert.equal(undo.undoStack.length, 1);

  const renamed = await rename(env.relay, session.code, cookie);
  assert.equal(renamed.status, STATUS.OK, env.relay.output());
  assert.deepEqual(await renamed.json(), { title: TITLE });
  await until(() => peerTitle(peer), (title) => title === TITLE, 'the title at the peer');
  assert.equal(undo.undoStack.length, 1, 'the relay rename is not on the peer undo stack');
  undo.undo();
  assert.equal(meta.get('note'), undefined);
  assert.equal(meta.get('title'), TITLE);
  assert.equal((await env.hook('state', session.docName)).resident, true, 'a room with a peer stays loaded');
  const [listed] = await listRooms(env.relay, cookie);
  assert.equal(listed.title, TITLE);
});

test('a cold-room rename racing the first connection lands on the one live doc the peer joins', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  const session = await roomSession(env, await createOwnedRoom(env, cookie));
  await env.hook('hold', session.docName);
  const renaming = rename(env.relay, session.code, cookie);
  assert.equal((await env.hook('entered', session.docName)).entered, true);
  const peer = openPeer(t, env.relay, session);
  await until(async () => (await env.hook('entries', session.docName)).entries, (entries) => entries >= UPGRADE_AND_RENAME_ENTRIES, 'upgrade');
  await env.hook('release', session.docName);
  assert.equal((await renaming).status, STATUS.OK, env.relay.output());
  await peer.synced;
  await until(() => peerTitle(peer), (title) => title === TITLE, 'the title at the joining peer');
  assert.equal((await env.hook('state', session.docName)).resident, true);
});

test('a cold-room rename is unloaded afterwards and survives a restart', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  const room = await createOwnedRoom(env, cookie);
  const session = await roomSession(env, room);
  assert.equal((await rename(env.relay, room.code, cookie)).status, STATUS.OK, env.relay.output());
  await until(async () => (await env.hook('state', session.docName)).resident, (resident) => !resident, 'unload');
  await env.relay.stop();

  const restarted = await lockedRelay(t, {}, { root: env.relay.root });
  const [listed] = await listRooms(restarted.relay, await signIn(restarted));
  assert.equal(listed.code, room.code);
  assert.equal(listed.title, TITLE);
});

test('a rename racing a delete never resurrects the room', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  const room = await createOwnedRoom(env, cookie);
  const session = await roomSession(env, room);
  await env.hook('hold', session.docName);
  const renaming = rename(env.relay, room.code, cookie);
  assert.equal((await env.hook('entered', session.docName)).entered, true);
  const deleting = removeRoom(env.relay, room.code, cookie);
  assert.equal((await env.hook('fenced', session.docName)).fenced, true);
  await env.hook('release', session.docName);
  assert.equal((await renaming).status, STATUS.NOT_FOUND);
  assert.equal((await deleting).status, STATUS.NO_CONTENT, env.relay.output());
  assert.equal((await rename(env.relay, room.code, cookie)).status, STATUS.NOT_FOUND);
  assert.deepEqual(await listRooms(env.relay, cookie), []);
  await env.relay.stop();

  const restarted = await lockedRelay(t, {}, { root: env.relay.root });
  assert.deepEqual(await listRooms(restarted.relay, await signIn(restarted)), []);
  assert.equal(await ownerRecordOf(env.relay.dbDir, session.docName), null);
});

test('a rename whose store write fails answers 503', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  const room = await createOwnedRoom(env, cookie);
  await env.hook('fail-store');
  assert.equal((await rename(env.relay, room.code, cookie)).status, STATUS.UNAVAILABLE);
});

test('a list whose stored title cannot be read answers 503, never a room without a title', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  await createOwnedRoom(env, cookie);
  await env.hook('fail-read');
  const response = await fetch(`${env.relay.url}${ROOMS}`, { headers: { cookie } });
  assert.equal(response.status, STATUS.UNAVAILABLE);
  await until(() => env.relay.output().includes(STORAGE_FAILURE_LOG), Boolean, 'the storage failure latch');
});

test('at the active-room cap a cold rename answers 503 and lets no second room in', async (t) => {
  const env = await hookedRelay(t, { env: { YJS_MAX_ACTIVE_ROOMS: '1' } });
  const cookie = await signIn(env);
  const busy = await roomSession(env, await createOwnedRoom(env, cookie));
  const cold = await roomSession(env, await createOwnedRoom(env, cookie));
  await openPeer(t, env.relay, busy).synced;
  assert.equal((await rename(env.relay, cold.code, cookie)).status, STATUS.UNAVAILABLE, env.relay.output());
  assert.equal((await env.hook('state', cold.docName)).resident, false);
  const refused = await upgradeStatus(new WebSocket(`${env.relay.wsUrl}/rooms/${cold.handle}`, {
    origin: ORIGIN, headers: { cookie: cold.cookie },
  }));
  assert.equal(refused, STATUS.UNAVAILABLE);
  assert.equal((await rename(env.relay, busy.code, cookie)).status, STATUS.OK, 'the resident room already holds its slot');
});

test('the list links a Poker room under /p/ and a locked room under /b/ with no title', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  const poker = await createOwnedRoom(env, cookie, { kind: ROOM_KIND.POKER });
  const locked = await createOwnedRoom(env, cookie, { lock: ROOM_LOCK.lock });
  const rooms = new Map((await listRooms(env.relay, cookie)).map((room) => [room.code, room]));
  assert.equal(rooms.get(poker.code).link, `${ROOM_PATH_PREFIX[ROOM_KIND.POKER]}${poker.code}#${poker.token}`);
  assert.equal(rooms.get(poker.code).kind, ROOM_KIND.POKER);
  assert.equal(rooms.get(locked.code).link, `${ROOM_PATH_PREFIX[ROOM_KIND.BOARD]}${locked.code}#${locked.token}`);
  assert.equal(rooms.get(locked.code).locked, true);
  assert.equal(rooms.get(locked.code).title, null);
});

test('a deleted room leaves its owner list and is no longer loaded, even with a peer attached', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  const room = await createOwnedRoom(env, cookie);
  const session = await roomSession(env, room);
  const peer = openPeer(t, env.relay, session);
  await peer.synced;
  assert.equal((await removeRoom(env.relay, room.code, cookie)).status, STATUS.NO_CONTENT, env.relay.output());
  assert.deepEqual(await listRooms(env.relay, cookie), []);
  assert.equal((await env.hook('state', session.docName)).resident, false);
});

test('deleting the account orphans its rooms durably; they are kept, not guest rooms', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  const room = await createOwnedRoom(env, cookie);
  const session = await roomSession(env, room);
  assert.equal((await post(env.relay, '/api/account/delete', {}, cookie)).status, STATUS.NO_CONTENT);
  await env.relay.stop();
  const record = await ownerRecordOf(env.relay.dbDir, session.docName);
  assert.equal(record.accountId, null);
  assert.equal(typeof record.orphanedAt, 'number');
});

test('a crash between the account delete and its orphaning is finished at the next startup', async (t) => {
  const env = await hookedRelay(t, { env: { TEST_KILL_BEFORE_ORPHAN: '1' } });
  const cookie = await signIn(env);
  const room = await createOwnedRoom(env, cookie);
  const session = await roomSession(env, room);
  await post(env.relay, '/api/account/delete', {}, cookie).catch(() => null);
  await env.relay.exited;
  const before = await ownerRecordOf(env.relay.dbDir, session.docName);
  assert.equal(typeof before.accountId, 'string', 'the crash left the room owned by a deleted account');

  const restarted = await lockedRelay(t, {}, { root: env.relay.root });
  await restarted.relay.stop();
  const after = await ownerRecordOf(env.relay.dbDir, session.docName);
  assert.equal(after.accountId, null);
  assert.equal(typeof after.orphanedAt, 'number');
});

test('a room created while its account was being deleted is orphaned at the next startup', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  await env.hook('hold-create');
  const creating = post(env.relay, '/api/rooms', {}, cookie);
  assert.equal((await env.hook('create-held')).held, true);
  assert.equal((await post(env.relay, '/api/account/delete', {}, cookie)).status, STATUS.NO_CONTENT);
  await env.hook('release-create');
  const created = await creating;
  assert.equal(created.status, STATUS.CREATED, env.relay.output());
  const session = await roomSession(env, await created.json());
  await env.relay.stop();
  assert.equal(typeof (await ownerRecordOf(env.relay.dbDir, session.docName)).accountId, 'string');

  const restarted = await lockedRelay(t, {}, { root: env.relay.root });
  await restarted.relay.stop();
  const record = await ownerRecordOf(env.relay.dbDir, session.docName);
  assert.equal(record.accountId, null);
  assert.equal(typeof record.orphanedAt, 'number');
});

test('the owner list of a new account never shows rooms of a deleted one', async (t) => {
  const env = await hookedRelay(t);
  const cookie = await signIn(env);
  await createOwnedRoom(env, cookie);
  assert.equal((await post(env.relay, '/api/account/delete', {}, cookie)).status, STATUS.NO_CONTENT);
  assert.deepEqual(await listRooms(env.relay, await signIn(env)), []);
});
