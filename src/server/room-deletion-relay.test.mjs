import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { tempRoot } from '../test-support/relay-harness.mjs';
import { pausedPost } from '../test-support/paused-request.mjs';
import {
  ORIGIN, PASSWORD, createNormalRoom, exchange, lockedRelay, post, signIn,
} from '../test-support/locked-room-harness.mjs';
import { createRoomLock } from '../client/room-lock/e2e-crypto.js';
import { E2E_BLOB_ID_HEADER, E2E_BLOB_STAGE_HEADER } from '../domain/room-lock-contract.js';
import { ROOM_DELETED_CLOSE_CODE } from '../domain/room-ownership.js';
import { DELETION_JOURNAL_DOC } from './room-deletion.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const syncProtocol = require('y-protocols/sync');
const encoding = require('lib0/encoding');

const HOOK_URL = new URL('../test-support/room-deletion-hook.mjs', import.meta.url).href;
const HOOK_PRELOAD = `import ${JSON.stringify(HOOK_URL)};`;
const HOOK_PORT_RE = /\[deletion-hook\] port (\d+)/;
const WAIT_MS = 5_000;
const POLL_MS = 10;
// Well under the 10 s drain timeout and ws's 30 s close-handshake timeout: an uncooperative peer cannot stall delete.
const PROMPT_DELETE_MS = 3_000;
const STATUS = Object.freeze({ OK: 200, NOT_FOUND: 404, SWITCHING: 101 });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const BLOB_BYTES = 64;
const MESSAGE_SYNC = 0;
const WS_BINARY_FIN = 0x82;
const WS_MASK_BIT = 0x80;
const WS_SHORT_LENGTH_LIMIT = 126;
const WS_MASK_BYTES = 4;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;
const ROOM_LOCK = await createRoomLock(PASSWORD);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function hookOf(relay) {
  const deadline = Date.now() + WAIT_MS;
  let match = relay.output().match(HOOK_PORT_RE);
  while (!match) {
    if (Date.now() > deadline) throw new Error(`no deletion hook\n${relay.output()}`);
    await sleep(POLL_MS);
    match = relay.output().match(HOOK_PORT_RE);
  }
  const call = async (action, docName) => (await fetch(`http://127.0.0.1:${match[1]}/${action}?doc=${encodeURIComponent(docName)}`, { method: 'POST' })).json();
  return { call };
}

const startDeletable = (t, options = {}) => lockedRelay(t, options.env, { preload: HOOK_PRELOAD, root: options.root });

const plainSocket = (relay, room) => new WebSocket(`${relay.wsUrl}/rooms/${room.handle}`, { origin: ORIGIN, headers: { cookie: room.cookie } });
const e2eSocket = (relay, room) => new WebSocket(`${relay.wsUrl}/rooms/${room.handle}/e2e`, { origin: ORIGIN, headers: { cookie: room.cookie } });
const closeCodeOf = (ws) => once(ws, 'close').then(([code]) => code);
const upgradeStatus = (ws) => new Promise((resolve, reject) => {
  ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
  ws.once('open', () => { ws.close(); reject(new Error('upgrade unexpectedly succeeded')); });
  ws.once('error', () => { /* unexpected-response is authoritative */ });
});

async function lockedRoomWithOwner(env) {
  const account = await signIn(env);
  const response = await post(env.relay, '/api/rooms', { lock: ROOM_LOCK.lock }, account);
  assert.equal(response.status, 201, env.relay.output());
  return { ...(await exchange(env.relay, await response.json(), ROOM_LOCK.authKey)), account };
}

const uploadHeaders = (room, extra) => ({ origin: ORIGIN, cookie: room.cookie, ...extra });

// Rows and journal are read from the stopped relay's database.
async function assertNoRows(relay, docName) {
  await relay.stop();
  const ldb = new LeveldbPersistence(relay.dbDir);
  try {
    assert.equal((await ldb.getMetas(docName)).size, 0, 'no meta row remains');
    const doc = await ldb.getYDoc(docName);
    assert.equal(doc.store.clients.size, 0, 'no update row remains');
    doc.destroy();
    assert.equal((await ldb.getMetas(DELETION_JOURNAL_DOC)).size, 0, 'the journal entry is gone');
  } finally {
    await ldb.destroy();
  }
}

async function assertNoFilesOf(relay, handle) {
  const names = await readdir(join(relay.root, 'uploads'));
  assert.deepEqual(names.filter((name) => name.startsWith(handle)), []);
}

test('delete closes a connected plain peer and an encrypted peer with 4004; session, upgrade and upload then answer 404', async (t) => {
  const env = await startDeletable(t);
  const { relay } = env;
  const hook = await hookOf(relay);
  const plain = await createNormalRoom(relay);
  const locked = await lockedRoomWithOwner(env);
  const plainPeer = plainSocket(relay, plain);
  const e2ePeer = e2eSocket(relay, locked);
  await Promise.all([once(plainPeer, 'open'), once(e2ePeer, 'open')]);
  const plainClosed = closeCodeOf(plainPeer);
  const e2eClosed = closeCodeOf(e2ePeer);

  assert.deepEqual(await hook.call('delete', plain.docName), { deleted: true, files: 0 });
  assert.deepEqual(await hook.call('delete', locked.docName), { deleted: true, files: 0 });
  assert.equal(await plainClosed, ROOM_DELETED_CLOSE_CODE);
  assert.equal(await e2eClosed, ROOM_DELETED_CLOSE_CODE);
  assert.deepEqual(await hook.call('state', plain.docName), { resident: false });

  assert.equal((await post(relay, '/api/room-session', { code: plain.code, token: plain.token })).status, STATUS.NOT_FOUND);
  assert.equal((await post(relay, '/api/room-session', { code: locked.code, token: locked.token, authKey: ROOM_LOCK.authKey })).status, STATUS.NOT_FOUND);
  assert.equal(await upgradeStatus(plainSocket(relay, plain)), STATUS.NOT_FOUND);
  assert.equal(await upgradeStatus(e2eSocket(relay, locked)), STATUS.NOT_FOUND);
  const upload = await fetch(`${relay.url}/rooms/${plain.handle}/upload`, {
    method: 'POST', headers: uploadHeaders(plain, { 'content-type': 'image/png' }), body: PNG,
  });
  assert.equal(upload.status, STATUS.NOT_FOUND);
  await assertNoRows(relay, plain.docName);
});

test('a paused image upload and a paused staged blob upload during delete answer 404 and leave no file', async (t) => {
  const env = await startDeletable(t);
  const { relay } = env;
  const hook = await hookOf(relay);
  const plain = await createNormalRoom(relay);
  const locked = await lockedRoomWithOwner(env);
  const begin = await post(relay, `/api/rooms/${locked.handle}/lock/rotate/begin`, { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 }, locked.account);
  assert.equal(begin.status, STATUS.OK);
  const { rotationId } = await begin.json();

  const image = pausedPost(`${relay.url}/rooms/${plain.handle}/upload`, {
    headers: uploadHeaders(plain, { 'content-type': 'image/png' }), body: PNG,
  });
  const blob = pausedPost(`${relay.url}/rooms/${locked.handle}/e2e-blobs`, {
    headers: uploadHeaders(locked, {
      'content-type': 'application/octet-stream', [E2E_BLOB_ID_HEADER]: randomUUID(), [E2E_BLOB_STAGE_HEADER]: rotationId,
    }),
    body: randomBytes(BLOB_BYTES),
  });
  // Both uploads were admitted (each holds its room's fence entry) before either delete starts.
  assert.deepEqual(await hook.call('entered', plain.docName), { entered: true });
  assert.deepEqual(await hook.call('entered', locked.docName), { entered: true });
  const deletions = [hook.call('delete', plain.docName), hook.call('delete', locked.docName)];
  assert.deepEqual(await hook.call('fenced', plain.docName), { fenced: true });
  assert.deepEqual(await hook.call('fenced', locked.docName), { fenced: true });
  image.finish();
  blob.finish();
  assert.deepEqual(await Promise.all([image.status, blob.status]), [STATUS.NOT_FOUND, STATUS.NOT_FOUND]);
  assert.deepEqual(await Promise.all(deletions), [{ deleted: true, files: 0 }, { deleted: true, files: 0 }]);
  await assertNoFilesOf(relay, plain.handle);
  await assertNoFilesOf(relay, locked.handle);
});

test('an upgrade stalled in hydration during delete is refused, and no doc is left behind', async (t) => {
  const { relay } = await startDeletable(t);
  const hook = await hookOf(relay);
  const room = await createNormalRoom(relay);
  await hook.call('hold', room.docName);
  const stalled = plainSocket(relay, room);
  const refused = upgradeStatus(stalled);
  // The upgrade was admitted (it holds the room's fence entry until attach) and created the doc it waits on.
  assert.deepEqual(await hook.call('entered', room.docName), { entered: true });
  assert.deepEqual(await hook.call('state', room.docName), { resident: true }, 'the upgrade created the doc and waits');
  const deleting = hook.call('delete', room.docName);
  assert.deepEqual(await hook.call('fenced', room.docName), { fenced: true });
  await hook.call('release', room.docName);
  assert.equal(await refused, STATUS.NOT_FOUND);
  assert.deepEqual(await deleting, { deleted: true, files: 0 });
  assert.deepEqual(await hook.call('state', room.docName), { resident: false });
  await assertNoRows(relay, room.docName);
});

// A masked binary WebSocket frame, as a client must send it.
function clientFrame(payload) {
  const mask = randomBytes(WS_MASK_BYTES);
  const length = payload.length < WS_SHORT_LENGTH_LIMIT
    ? Buffer.from([WS_BINARY_FIN, WS_MASK_BIT | payload.length])
    : Buffer.concat([Buffer.from([WS_BINARY_FIN, WS_MASK_BIT | WS_SHORT_LENGTH_LIMIT]), Buffer.from([payload.length >> BITS_PER_BYTE, payload.length & BYTE_MASK])]);
  return Buffer.concat([length, mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % WS_MASK_BYTES]))]);
}

function syncUpdateFrame(key) {
  const doc = new Y.Doc();
  doc.getMap('items').set(key, 'x');
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return clientFrame(Buffer.from(encoding.toUint8Array(encoder)));
}

/** A raw client that completes the handshake and then never answers a close frame. */
async function uncooperativePeer(t, relay, room) {
  const socket = net.connect(new URL(relay.url).port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write([
    `GET /rooms/${room.handle} HTTP/1.1`, `Host: 127.0.0.1`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', `Origin: ${ORIGIN}`, `Cookie: ${room.cookie}`, '', '',
  ].join('\r\n'));
  const [head] = await once(socket, 'data');
  assert.match(head.toString('latin1'), new RegExp(`^HTTP/1.1 ${STATUS.SWITCHING}`));
  return socket;
}

test('a peer that ignores the close handshake does not stall delete, and nothing it sends afterwards is stored', async (t) => {
  const { relay } = await startDeletable(t);
  const hook = await hookOf(relay);
  const room = await createNormalRoom(relay);
  const peer = await uncooperativePeer(t, relay, room);
  peer.write(syncUpdateFrame('before'));
  await sleep(POLL_MS * 10);
  const started = Date.now();
  assert.deepEqual(await hook.call('delete', room.docName), { deleted: true, files: 0 });
  assert.ok(Date.now() - started < PROMPT_DELETE_MS, 'delete did not wait for the close handshake');
  for (const key of ['after-1', 'after-2', 'after-3']) peer.write(syncUpdateFrame(key));
  await sleep(POLL_MS * 10);
  assert.deepEqual(await hook.call('state', room.docName), { resident: false });
  await assertNoRows(relay, room.docName);
});

test('a relay killed right after the journal put never serves the room again, and the next start removes rows, files and journal', async (t) => {
  const root = await tempRoot(t);
  const first = await startDeletable(t, { root, env: { TEST_KILL_AFTER_JOURNAL_PUT: '1' } });
  const hook = await hookOf(first.relay);
  const room = await createNormalRoom(first.relay);
  const image = await fetch(`${first.relay.url}/rooms/${room.handle}/upload`, {
    method: 'POST', headers: uploadHeaders(room, { 'content-type': 'image/png' }), body: PNG,
  });
  assert.equal(image.status, STATUS.OK);
  await hook.call('delete', room.docName).catch(() => null);
  await first.relay.exited;
  await writeFile(join(root, 'uploads', `${room.handle}.${randomUUID()}.e2e`), randomBytes(BLOB_BYTES));

  const second = await lockedRelay(t, {}, { root });
  assert.equal((await post(second.relay, '/api/room-session', { code: room.code, token: room.token })).status, STATUS.NOT_FOUND);
  await assertNoFilesOf(second.relay, room.handle);
  await assertNoRows(second.relay, room.docName);
});
