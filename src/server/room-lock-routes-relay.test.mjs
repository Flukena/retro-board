import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import WebSocket from 'ws';
import { tempRoot } from '../test-support/relay-harness.mjs';
import { ORIGIN, PASSWORD, cookiePair, createLockedRoom, lockedRelay, post, signIn } from '../test-support/locked-room-harness.mjs';
import { createNextRoomKey, createRoomLock, rewrapRoomLock } from '../client/room-lock/e2e-crypto.js';
import { E2E_FRAME, decodeServerFrame, encodeFrame } from '../domain/e2e-envelope.js';
import { ROOM_SESSION_RENEWAL_SUFFIX } from '../domain/room-lock-contract.js';
import { WRONG_PASSWORDS_PER_IP_ROOM } from './room-lock.js';

const NEXT_PASSWORD = 'another long passphrase 2';
const KEY_ROTATED_CLOSE = 4001;
const HEADER_LENGTH_BYTES = 4;
const WAIT_MS = 5_000;
const IDLE_MS = 300;
const STATUS = Object.freeze({ OK: 200, NO_CONTENT: 204, UNAUTHORIZED: 401, FORBIDDEN: 403, CREATED: 201 });
const FRAME_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024 });
const ROOM_LOCK = await createRoomLock(PASSWORD);
const NEXT_KEY = await createNextRoomKey(NEXT_PASSWORD);
const SNAPSHOT = new Uint8Array(48).fill(7);
const BLOB = new Uint8Array(64).fill(5);

const lockUrl = (relay, room, action) => `${relay.url}/api/rooms/${room.handle}/lock/${action}`;
const e2eUrl = (relay, room) => `${relay.wsUrl}/rooms/${room.handle}/e2e`;
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

const upgradeStatus = (url, cookie) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { origin: ORIGIN, headers: { cookie } });
  ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
  ws.once('open', () => { ws.close(); reject(new Error('upgrade unexpectedly succeeded')); });
  ws.once('error', () => {});
});

/** Opens the encrypted socket and collects frames until SYNCED. */
async function join(relay, room, cookie = room.cookie) {
  const ws = new WebSocket(e2eUrl(relay, room), { origin: ORIGIN, headers: { cookie } });
  const frames = [];
  ws.on('message', (data) => frames.push(decodeServerFrame(new Uint8Array(data), FRAME_LIMITS)));
  const closed = once(ws, 'close').then(([code, reason]) => ({ code, reason: String(reason) }));
  await once(ws, 'open');
  const deadline = Date.now() + WAIT_MS;
  while (!frames.some((frame) => frame?.type === E2E_FRAME.SYNCED)) {
    if (Date.now() > deadline) throw new Error('never synced');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { ws, frames, closed };
}

const ownerPost = (env, room, action, body, ownerCookie) => post(env.relay, `/api/rooms/${room.handle}/lock/${action}`, body, ownerCookie);

const commit = (env, room, rotation, ownerCookie, overrides = {}) => {
  const header = Buffer.from(JSON.stringify({
    oldAuthKey: ROOM_LOCK.authKey, rotationId: rotation.rotationId, expectedHead: rotation.head, knownSnapshotBase: 0, keyEpoch: 1, lock: NEXT_KEY.lock, keepBlobs: [], ...overrides,
  }));
  const prefix = Buffer.alloc(HEADER_LENGTH_BYTES);
  prefix.writeUInt32BE(header.length);
  return fetch(lockUrl(env.relay, room, 'rotate/commit'), {
    method: 'POST', headers: { origin: ORIGIN, cookie: ownerCookie, 'content-type': 'application/octet-stream' },
    body: Buffer.concat([prefix, header, Buffer.from(SNAPSHOT)]),
  });
};

const exchangeStatus = async (env, room, authKey) => {
  const response = await post(env.relay, '/api/room-session', { code: room.code, token: room.token, authKey });
  return { response, status: response.status };
};

test('a committed rotation closes sockets with 4001, ends old cookies and keys, and the log is the new snapshot', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env, ROOM_LOCK);
  const ownerCookie = await signIn(env);
  const blobId = randomUUID();
  const upload = await fetch(`${env.relay.url}/rooms/${room.handle}/e2e-blobs`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: room.cookie, 'content-type': 'application/octet-stream', 'x-blob-id': blobId }, body: BLOB,
  });
  assert.equal(upload.status, STATUS.CREATED, env.relay.output());
  const member = await join(env.relay, room);
  member.ws.send(encodeFrame(E2E_FRAME.APPEND, { clientRef: 1, ciphertext: new Uint8Array(9).fill(2) }));

  const begun = await ownerPost(env, room, 'rotate/begin', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 }, ownerCookie);
  assert.equal(begun.status, STATUS.OK);
  const rotation = await begun.json();
  const stage = (id) => fetch(`${env.relay.url}/rooms/${room.handle}/e2e-blobs`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: room.cookie, 'content-type': 'application/octet-stream', 'x-blob-id': id, 'x-blob-stage': rotation.rotationId }, body: BLOB,
  });
  const keptId = randomUUID();
  const droppedId = randomUUID();
  assert.equal((await stage(keptId)).status, STATUS.CREATED);
  assert.equal((await stage(droppedId)).status, STATUS.CREATED);
  const stale = await commit(env, room, { ...rotation, rotationId: randomUUID() }, ownerCookie);
  assert.equal(stale.status, 409);
  const done = await commit(env, room, rotation, ownerCookie, { keepBlobs: [keptId] });
  assert.equal(done.status, STATUS.NO_CONTENT, env.relay.output());
  assert.deepEqual(await member.closed, { code: KEY_ROTATED_CLOSE, reason: 'key rotated' });
  const files = (await readdir(joinPath(env.relay.root, 'uploads'))).filter((name) => name.endsWith('.e2e')).sort();
  assert.deepEqual(files, [blobId, keptId].map((id) => `${room.handle}.${id}.e2e`).sort(), 'the unkept staged file is gone, the old-epoch file stays');

  assert.equal(await upgradeStatus(e2eUrl(env.relay, room), room.cookie), STATUS.UNAUTHORIZED, 'old cookie');
  assert.equal((await exchangeStatus(env, room, ROOM_LOCK.authKey)).status, STATUS.FORBIDDEN, 'old authKey');
  const fresh = await exchangeStatus(env, room, NEXT_KEY.authKey);
  assert.equal(fresh.status, STATUS.OK);
  const body = await fresh.response.json();
  assert.equal(body.lock.keyEpoch, 1);
  assert.equal(body.lock.wrappedDek, NEXT_KEY.lock.wrappedDek);
  assert.equal(body.lock.isOwner, false, 'no account cookie on the exchange');

  const newCookie = cookiePair(fresh.response.headers.get('set-cookie'));
  const reader = await join(env.relay, room, newCookie);
  assert.deepEqual(reader.frames.map(({ type }) => type), [E2E_FRAME.SNAPSHOT_OUT, E2E_FRAME.SYNCED]);
  assert.ok(sameBytes(reader.frames[0].ciphertext, SNAPSHOT));
  const oldBlob = await fetch(`${env.relay.url}/rooms/${room.handle}/e2e-blobs/${blobId}`, { headers: { origin: ORIGIN, cookie: newCookie } });
  assert.equal(oldBlob.status, STATUS.OK, 'old-epoch blob stays readable with the new cookie');
  assert.ok(sameBytes(new Uint8Array(await oldBlob.arrayBuffer()), BLOB));
  reader.ws.close();
});

test('the committed rotation survives a hard kill of the relay', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const room = await createLockedRoom(env, ROOM_LOCK);
  const ownerCookie = await signIn(env);
  const rotation = await (await ownerPost(env, room, 'rotate/begin', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 }, ownerCookie)).json();
  assert.equal((await commit(env, room, rotation, ownerCookie)).status, STATUS.NO_CONTENT);
  await env.relay.stop('SIGKILL');
  const reopened = await lockedRelay(t, {}, { root });
  assert.equal((await exchangeStatus(reopened, room, ROOM_LOCK.authKey)).status, STATUS.FORBIDDEN);
  const fresh = await exchangeStatus(reopened, room, NEXT_KEY.authKey);
  assert.equal(fresh.status, STATUS.OK);
  assert.equal((await fresh.response.json()).lock.keyEpoch, 1);
});

test('a password change swaps the key but leaves open sockets and cookies working', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env, ROOM_LOCK);
  const ownerCookie = await signIn(env);
  const member = await join(env.relay, room);
  const change = await rewrapRoomLock({ currentPassword: PASSWORD, lock: ROOM_LOCK.lock, newPassword: NEXT_PASSWORD });
  const changed = await ownerPost(env, room, 'password', { oldAuthKey: change.oldAuthKey, expectedRevision: 0, lock: change.lock }, ownerCookie);
  assert.equal(changed.status, STATUS.OK, env.relay.output());
  assert.deepEqual(await changed.json(), { lockRevision: 1 });
  assert.equal((await exchangeStatus(env, room, change.oldAuthKey)).status, STATUS.FORBIDDEN);
  const fresh = await exchangeStatus(env, room, change.authKey);
  assert.equal(fresh.status, STATUS.OK);
  assert.equal((await fresh.response.json()).lock.keyEpoch, 0);
  const outcome = await Promise.race([member.closed, new Promise((resolve) => setTimeout(resolve, IDLE_MS, 'still open'))]);
  assert.equal(outcome, 'still open');
  member.ws.send(encodeFrame(E2E_FRAME.APPEND, { clientRef: 1, ciphertext: new Uint8Array(9).fill(2) }));
  const deadline = Date.now() + WAIT_MS;
  while (!member.frames.some((frame) => frame?.type === E2E_FRAME.ACK) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(member.frames.some((frame) => frame?.type === E2E_FRAME.ACK), 'the open cookie still appends');
  member.ws.close();
});

test('a member renewing on the room-scoped path with a stale key is refused but never locked out', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env, ROOM_LOCK);
  const renewalUrl = `${env.relay.url}/rooms/${room.handle}${ROOM_SESSION_RENEWAL_SUFFIX}`;
  const preflight = await fetch(renewalUrl, {
    method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.status, STATUS.NO_CONTENT);
  const body = (authKey) => ({ code: room.code, token: room.token, authKey });
  for (let attempt = 0; attempt <= WRONG_PASSWORDS_PER_IP_ROOM; attempt += 1) {
    assert.equal((await post(env.relay, renewalUrl.slice(env.relay.url.length), body(NEXT_KEY.authKey), room.cookie)).status, STATUS.FORBIDDEN);
  }
  assert.equal((await post(env.relay, '/api/room-session', body(ROOM_LOCK.authKey))).status, STATUS.OK);
});

test('the lock routes answer a credentialed preflight and refuse requests without the account cookie', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env, ROOM_LOCK);
  const preflight = await fetch(lockUrl(env.relay, room, 'rotate/commit'), {
    method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(preflight.status, STATUS.NO_CONTENT);
  assert.match(preflight.headers.get('access-control-allow-headers'), /content-type/i);
  assert.equal((await ownerPost(env, room, 'rotate/begin', { oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 })).status, STATUS.UNAUTHORIZED);
});
