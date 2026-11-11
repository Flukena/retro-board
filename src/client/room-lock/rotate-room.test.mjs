import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { InboundGate, ownerBoard, peerSession } from '../../test-support/owner-board-harness.mjs';
import { installBrowserStandIn } from '../../test-support/browser-stand-in.mjs';
import { E2E_FRAME, decodeServerFrame, encodeFrame } from '../../domain/e2e-envelope.js';
import { delivered, synced, textOf, until } from '../../test-support/e2e-room-fixture.mjs';
import { ORIGIN, PASSWORD } from '../../test-support/locked-room-harness.mjs';
import { e2eAad } from '../../domain/room-lock-contract.js';
import { createNextRoomKey, createRoomLock, encryptFrame } from './e2e-crypto.js';
import { getRoomKey, reunlock } from './lock-session.js';
import { readE2EImage, uploadEncryptedImage } from './e2e-images.js';
import { LOCK_ACTION_ERROR, createRoomLockApi, lockActionErrorForStatus } from './room-lock-api.js';
import { ROTATION_FAILURE, ROTATION_WAIT_TIMEOUT_MS, rotateRoom } from './rotate-room.js';

const ROOM_LOCK = await createRoomLock(PASSWORD);
const NEW_PASSWORD = 'a brand new passphrase';
const THIRD_PASSWORD = 'yet another passphrase';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const IMAGE = Buffer.concat([PNG, Buffer.from('ROTATED-PIXELS')]);
const RELEASE_AFTER_FREEZE_MS = 200;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const NEXT_EPOCH = 1;

const type = (page, text) => page.doc.getText('text').insert(page.doc.getText('text').length, text);

function addImage(page, id, src) {
  const item = new Y.Map();
  item.set('type', 'image');
  item.set('src', src);
  page.doc.getMap('items').set(id, item);
}

const srcOf = (page, id) => page.doc.getMap('items').get(id)?.get('src');
const blobIdOf = (src) => src.split('/').pop();

async function boardWithPeer(t, relayEnv) {
  const board = await ownerBoard(t, { roomLock: ROOM_LOCK, password: PASSWORD, relayEnv });
  const gate = new InboundGate();
  const owner = board.openOwnerPage({ gate });
  const peer = await board.openPeerPage(PASSWORD);
  await synced(owner, peer);
  const api = createRoomLockApi(getRoomKey().roomHandle);
  const rotate = (overrides = {}) => rotateRoom({
    currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: getRoomKey(), storage: owner.storage, api, ...overrides,
  });
  return { board, gate, owner, peer, api, rotate };
}

/** After a commit: every page saw 4001 and re-unlocks with the new password (the owner through lock-session). */
async function reunlockEveryone({ owner, peer }, password = NEW_PASSWORD) {
  await until(() => owner.rotations === 1 && peer.rotations === 1, 'every socket closed with 4001');
  await reunlock(password);
  await peer.reunlock(password);
  await synced(owner, peer);
}

async function blobStatus(board, src) {
  const url = `${board.env.relay.url}${src}`;
  const response = await board.relayFetch(url, { headers: { origin: ORIGIN, cookie: board.browser.cookieHeader(url) } });
  await response.body?.cancel();
  return response.status;
}

const rejectsWithKind = (promise, kind) => assert.rejects(promise, (error) => error.name === 'RotationError' && error.kind === kind);

test('remove everyone keeps a peer edit accepted during the drain and one sent while frozen; all re-unlock with the new password', async (t) => {
  const { board, gate, owner, peer, api, rotate } = await boardWithPeer(t);
  type(owner, 'owner ');
  await delivered(owner);
  await until(() => textOf(peer) === 'owner ', 'peer has the owner edit');
  gate.hold();
  type(peer, 'drained ');
  await delivered(peer);
  const begin = async (args) => {
    const rotation = await api.beginRotation(args);
    type(peer, 'frozen ');
    setTimeout(() => gate.release(), RELEASE_AFTER_FREEZE_MS);
    return rotation;
  };
  const result = await rotate({ api: { ...api, beginRotation: begin } });
  assert.deepEqual(result, { keyEpoch: NEXT_EPOCH });
  await reunlockEveryone({ owner, peer });
  assert.equal(getRoomKey().keyEpoch, NEXT_EPOCH);
  await delivered(peer);
  const late = await board.openPeerPage(NEW_PASSWORD);
  await synced(late);
  await until(() => textOf(late) === 'owner drained frozen ', 'a new member reads every acknowledged and frozen edit');
  await assert.rejects(board.openPeerPage(PASSWORD), { status: FORBIDDEN });
});

test('images are re-encrypted as staged copies, the detached doc points at them, and they open with the new key', async (t) => {
  const { board, owner, peer, api, rotate } = await boardWithPeer(t);
  const oldSrc = await uploadEncryptedImage(new Blob([IMAGE], { type: 'image/png' }), { key: getRoomKey() });
  addImage(owner, 'img', oldSrc);
  await delivered(owner);
  let header;
  const commitRotation = (sent, snapshot) => {
    header = sent;
    return api.commitRotation(sent, snapshot);
  };
  await rotate({ api: { ...api, commitRotation } });
  assert.equal(srcOf(owner, 'img'), oldSrc, 'the live doc is never rewritten by the rotation itself');
  await reunlockEveryone({ owner, peer });
  const late = await board.openPeerPage(NEW_PASSWORD);
  await synced(late);
  const newSrc = srcOf(late, 'img');
  assert.notEqual(newSrc, oldSrc);
  assert.deepEqual(header.keepBlobs, [blobIdOf(newSrc)]);
  assert.equal(header.knownSnapshotBase, 0);
  await until(() => srcOf(owner, 'img') === newSrc, 'the owner page follows the new snapshot');
  const image = await readE2EImage(newSrc, { key: getRoomKey() });
  assert.equal(image.epoch, NEXT_EPOCH);
  assert.ok(Buffer.from(await image.blob.arrayBuffer()).equals(IMAGE));
});

test('a stale commit aborts with "board changed": the live doc is unchanged, the freeze and staged copies are gone, a retry works', async (t) => {
  const { board, owner, peer, api, rotate } = await boardWithPeer(t);
  const oldSrc = await uploadEncryptedImage(new Blob([IMAGE], { type: 'image/png' }), { key: getRoomKey() });
  addImage(owner, 'img', oldSrc);
  type(owner, 'before ');
  await delivered(owner);
  await until(() => textOf(peer) === 'before ', 'peer caught up');
  const live = Y.encodeStateAsUpdate(owner.doc);
  const staged = [];
  const images = {
    read: readE2EImage,
    upload: async (blob, options) => {
      const src = await uploadEncryptedImage(blob, options);
      staged.push(src);
      return src;
    },
  };
  const staleCommit = (header, snapshot) => api.commitRotation({ ...header, knownSnapshotBase: header.knownSnapshotBase + 1 }, snapshot);
  await rejectsWithKind(rotate({ api: { ...api, commitRotation: staleCommit }, images }), ROTATION_FAILURE.BOARD_CHANGED);
  assert.deepEqual(Y.encodeStateAsUpdate(owner.doc), live, 'the live doc was never touched');
  assert.equal(srcOf(owner, 'img'), oldSrc);
  assert.equal(staged.length, 1);
  assert.equal(await blobStatus(board, staged[0]), NOT_FOUND, 'the abort deleted the staged copy');
  type(peer, 'after-abort ');
  await delivered(peer);
  await until(() => textOf(owner) === 'before after-abort ', 'the abort released the freeze');
  await rotate();
  await reunlockEveryone({ owner, peer });
  type(peer, 'second ');
  await delivered(peer);
  await until(() => textOf(owner) === 'before after-abort second ', 'owner read the new log');
  // The stored snapshot base is now the first rotation's head: a second rotation must claim exactly that base.
  assert.ok(owner.storage.rotationSource().appliedSnapshotBase > 0);
  await rotate({ currentPassword: NEW_PASSWORD, newPassword: THIRD_PASSWORD, key: getRoomKey() });
  await until(() => owner.rotations === 2, 'second rotation closed the sockets');
});

test('without room storage for the staged copies the rotation aborts with the quota message and leaves the board as it was', async (t) => {
  const { owner, peer, rotate } = await boardWithPeer(t, { YJS_MAX_ROOM_UPLOAD_FILES: '1' });
  const oldSrc = await uploadEncryptedImage(new Blob([IMAGE], { type: 'image/png' }), { key: getRoomKey() });
  addImage(owner, 'img', oldSrc);
  await delivered(owner);
  const live = Y.encodeStateAsUpdate(owner.doc);
  await rejectsWithKind(rotate(), ROTATION_FAILURE.STORAGE_FULL);
  assert.deepEqual(Y.encodeStateAsUpdate(owner.doc), live);
  type(peer, 'still writable');
  await delivered(peer);
  await until(() => textOf(owner) === 'still writable', 'the abort released the freeze');
  assert.equal(owner.rotations, 0);
  assert.equal(getRoomKey().keyEpoch, 0);
});

test('a wrong current password is refused at begin and nothing is frozen', async (t) => {
  const { owner, peer, rotate } = await boardWithPeer(t);
  await rejectsWithKind(rotate({ currentPassword: `${PASSWORD} typo` }), ROTATION_FAILURE.WRONG_PASSWORD);
  type(peer, 'not frozen');
  await delivered(peer);
  await until(() => textOf(owner) === 'not frozen', 'appends still flow');
});

/** A clock whose sleep moves time on at once, so the 60 s waits run instantly. */
function fakeClock() {
  let at = 0;
  return { now: () => at, sleep: async (ms) => { at += ms; } };
}

function recordingApi(rotation) {
  const calls = [];
  const record = (name, result) => async (...args) => { calls.push([name, ...args]); return result; };
  return {
    calls,
    beginRotation: record('begin', rotation),
    commitRotation: record('commit'),
    abortRotation: record('abort'),
  };
}

const offlineKey = () => ({
  roomHandle: 'Abcdefghijklmnopqrstuvwxyz012345', keyEpoch: 0, lockRevision: 0, lock: { salt: ROOM_LOCK.lock.salt, kdf: ROOM_LOCK.lock.kdf },
});
const stuckSource = (overrides) => ({
  rotationSource: () => ({
    encodeState: () => Y.encodeStateAsUpdate(new Y.Doc()), roomHandle: offlineKey().roomHandle, keyEpoch: 0,
    appliedSeq: 0, head: 0, appliedSnapshotBase: 0, pendingDelivery: 0, skippedSeq: null, synced: true, ...overrides,
  }),
});

test('edits this page cannot deliver within the timeout fail the drain before anything is frozen', async () => {
  const api = recordingApi();
  await rejectsWithKind(rotateRoom({
    currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: offlineKey(), storage: stuckSource({ pendingDelivery: 1 }), api, clock: fakeClock(),
  }), ROTATION_FAILURE.DRAIN_TIMEOUT);
  assert.deepEqual(api.calls, [], 'no begin, so no freeze to undo');
});

test('a page that never reads up to the frozen head aborts the freeze and commits nothing', async () => {
  const rotationId = globalThis.crypto.randomUUID();
  const api = recordingApi({ head: 5, rotationId, lockRevision: 0 });
  await rejectsWithKind(rotateRoom({
    currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: offlineKey(), storage: stuckSource({ appliedSeq: 4, head: 5 }), api, clock: fakeClock(),
  }), ROTATION_FAILURE.CATCH_UP_TIMEOUT);
  assert.deepEqual(api.calls.map(([name]) => name), ['begin', 'abort']);
  assert.equal(api.calls[1][1].rotationId, rotationId);
});

// A caught-up page: the commit is sent at once. `commit` and `abort` stand in for the relay's answers.
const commitWith = ({ commit, abort }) => {
  const rotationId = globalThis.crypto.randomUUID();
  const api = { ...recordingApi({ head: 0, rotationId, lockRevision: 0 }), commitRotation: commit, abortRotation: abort };
  return rotateRoom({
    currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: offlineKey(), storage: stuckSource(), api, clock: fakeClock(),
  });
};
const refusedAbort = async () => { throw lockActionErrorForStatus(CONFLICT); };
const COMMIT_PATH_RE = /\/lock\/rotate\/commit$/;

/**
 * The page's network drops the commit at the HTTP boundary: `afterRelay` lets the relay handle it and loses the
 * response, otherwise the request never reaches the relay. The real room-lock-api sees only the failed fetch.
 */
function dropCommit(t, { afterRelay }) {
  const pageFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!COMMIT_PATH_RE.test(String(url))) return pageFetch(url, init);
    if (afterRelay) await (await pageFetch(url, init)).body?.cancel();
    throw new TypeError('network connection lost');
  };
  t.after(() => { globalThis.fetch = pageFetch; });
}

test('a commit the relay applied but whose response was lost reports that the new password may be active', async (t) => {
  const { board, owner, peer, rotate } = await boardWithPeer(t);
  dropCommit(t, { afterRelay: true });
  await rejectsWithKind(rotate(), ROTATION_FAILURE.UNKNOWN_OUTCOME);
  await reunlockEveryone({ owner, peer });
  await assert.rejects(board.openPeerPage(PASSWORD), { status: FORBIDDEN }, 'the rotation did land');
});

test('a commit lost before it reached the relay is a plain failure: the abort released the freeze', async (t) => {
  const { board, rotate } = await boardWithPeer(t);
  dropCommit(t, { afterRelay: false });
  await rejectsWithKind(rotate(), ROTATION_FAILURE.UNAVAILABLE);
  const peer = await board.openPeerPage(PASSWORD);
  assert.equal(peer.key().keyEpoch, 0, 'the old password still opens the room');
});

test('a commit the relay answered with a refusal is a known failure even when the abort is refused too', async () => {
  const refusedCommit = async () => { throw lockActionErrorForStatus(CONFLICT); };
  await rejectsWithKind(commitWith({ commit: refusedCommit, abort: refusedAbort }), ROTATION_FAILURE.BOARD_CHANGED);
});

test('the new password must differ from the current one', async () => {
  const api = recordingApi();
  await assert.rejects(rotateRoom({
    currentPassword: PASSWORD, newPassword: PASSWORD, key: offlineKey(), storage: stuckSource(), api, clock: fakeClock(),
  }), RangeError);
  assert.deepEqual(api.calls, []);
});

const FRAME_LIMITS = Object.freeze({ maxBytes: 1024 * 1024 });
const UNREADABLE_CIPHERTEXT_BYTES = 64;
// Decodes as no Yjs update ("Unexpected end of array").
const NOT_A_YJS_UPDATE = Uint8Array.of(255, 255, 255, 255);
const CONFLICT = 409;
const SHORT_TIMEOUT_MS = 200;

/** Appends `ciphertext` as a member with a broken client would; resolves once the relay acknowledged it. */
async function appendRaw(board, ciphertext) {
  const { cookie } = await peerSession(board.env.relay, board.room, PASSWORD);
  const ws = new WebSocket(`${board.env.relay.wsUrl}/rooms/${getRoomKey().roomHandle}/e2e`, { origin: ORIGIN, headers: { cookie } });
  const acked = new Promise((resolve) => {
    ws.on('message', (data) => { if (decodeServerFrame(new Uint8Array(data), FRAME_LIMITS)?.type === E2E_FRAME.ACK) resolve(); });
  });
  await once(ws, 'open');
  ws.send(encodeFrame(E2E_FRAME.APPEND, { clientRef: 1, ciphertext }));
  await acked;
  ws.close();
}

// Opens under the room key but is no Yjs update: a page that could read it might still hold content it carries.
const undecodableEntry = () => {
  const key = getRoomKey();
  return encryptFrame(key.dek, e2eAad(key.roomHandle, key.keyEpoch, 'update'), NOT_A_YJS_UPDATE);
};

test('an acknowledged entry the owner page cannot apply aborts the rotation instead of dropping it from the snapshot', async (t) => {
  const { board, gate, owner, peer, api, rotate } = await boardWithPeer(t);
  gate.hold();
  await appendRaw(board, await undecodableEntry());
  const begin = async (args, options) => {
    const rotation = await api.beginRotation(args, options);
    gate.release();
    return rotation;
  };
  let committed = false;
  const commitRotation = async (...args) => { committed = true; return api.commitRotation(...args); };
  await rejectsWithKind(rotate({ api: { ...api, beginRotation: begin, commitRotation } }), ROTATION_FAILURE.INCOMPLETE);
  assert.equal(committed, false);
  assert.notEqual(owner.storage.rotationSource().skippedSeq, null);
  type(peer, 'released');
  await delivered(peer);
  assert.equal(getRoomKey().keyEpoch, 0);
  await rejectsWithKind(rotate(), ROTATION_FAILURE.INCOMPLETE);
});

test('an entry no member can decrypt does not block the rotation; the board rotates without it', async (t) => {
  const { board, owner, peer, rotate } = await boardWithPeer(t);
  type(owner, 'kept');
  await delivered(owner);
  await appendRaw(board, new Uint8Array(UNREADABLE_CIPHERTEXT_BYTES).fill(3));
  await rotate();
  await reunlockEveryone({ owner, peer });
  const late = await board.openPeerPage(NEW_PASSWORD);
  await synced(late);
  assert.equal(textOf(late), 'kept');
});

test('the owner typing during the freeze keeps the edit (re-sent under the new key); a plain image upload then gets 409', async (t) => {
  const { board, owner, peer, api, rotate } = await boardWithPeer(t);
  type(owner, 'before ');
  await delivered(owner);
  let uploadStatus = null;
  const begin = async (args, options) => {
    const rotation = await api.beginRotation(args, options);
    type(owner, 'during ');
    uploadStatus = await uploadEncryptedImage(new Blob([IMAGE], { type: 'image/png' }), { key: getRoomKey() }).catch((error) => error.status);
    return rotation;
  };
  await rotate({ api: { ...api, beginRotation: begin } });
  assert.equal(uploadStatus, CONFLICT, 'the board shows its upload-failed notice for this');
  await reunlockEveryone({ owner, peer });
  await delivered(owner);
  const late = await board.openPeerPage(NEW_PASSWORD);
  await synced(late);
  await until(() => textOf(late) === 'before during ', 'the frozen local edit reached the new epoch');
});

test('an image whose blob is gone and one no held key opens keep their sources; the rest rotate', async (t) => {
  const { board, owner, peer, rotate } = await boardWithPeer(t);
  const handle = getRoomKey().roomHandle;
  const good = await uploadEncryptedImage(new Blob([IMAGE], { type: 'image/png' }), { key: getRoomKey() });
  const foreign = await createNextRoomKey('a key nobody here holds');
  const unreadable = await uploadEncryptedImage(new Blob([IMAGE], { type: 'image/png' }), { key: { roomHandle: handle, keyEpoch: 0, dek: foreign.dek } });
  const gone = `/rooms/${handle}/e2e-blobs/${globalThis.crypto.randomUUID()}`;
  addImage(owner, 'good', good);
  addImage(owner, 'unreadable', unreadable);
  addImage(owner, 'gone', gone);
  await delivered(owner);
  await rotate();
  await reunlockEveryone({ owner, peer });
  const late = await board.openPeerPage(NEW_PASSWORD);
  await synced(late);
  assert.notEqual(srcOf(late, 'good'), good);
  assert.equal(srcOf(late, 'unreadable'), unreadable);
  assert.equal(srcOf(late, 'gone'), gone);
});

test('cancelling after begin aborts the freeze and never commits', async () => {
  const rotationId = globalThis.crypto.randomUUID();
  const api = recordingApi({ head: 5, rotationId, lockRevision: 0 });
  const cancel = new AbortController();
  const beginRotation = api.beginRotation;
  api.beginRotation = async (...args) => {
    const rotation = await beginRotation(...args);
    cancel.abort();
    return rotation;
  };
  const clock = fakeClock();
  await rejectsWithKind(rotateRoom({
    currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: offlineKey(), storage: stuckSource({ appliedSeq: 4, head: 5 }), api,
    clock, signal: cancel.signal,
  }), ROTATION_FAILURE.CANCELLED);
  assert.deepEqual(api.calls.map(([name]) => name), ['begin', 'abort']);
  assert.ok(clock.now() < ROTATION_WAIT_TIMEOUT_MS, 'the cancel ends the wait at once, not at its timeout');
});

test('a page hide after begin sends a keepalive abort and stops the run before any commit', async () => {
  const rotationId = globalThis.crypto.randomUUID();
  const api = recordingApi({ head: 5, rotationId, lockRevision: 0 });
  let hide = null;
  const onTerminate = (handler) => { hide = handler; return () => { hide = null; }; };
  const beginRotation = api.beginRotation;
  api.beginRotation = async (...args) => {
    const rotation = await beginRotation(...args);
    setTimeout(() => hide());
    return rotation;
  };
  await rejectsWithKind(rotateRoom({
    currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: offlineKey(), storage: stuckSource({ appliedSeq: 4, head: 5 }), api, onTerminate,
  }), ROTATION_FAILURE.CANCELLED);
  const aborts = api.calls.filter(([name]) => name === 'abort');
  assert.deepEqual(aborts[0].slice(1), [{ oldAuthKey: aborts[0][1].oldAuthKey, rotationId }, { keepalive: true }]);
  assert.equal(api.calls.some(([name]) => name === 'commit'), false);
  assert.equal(hide, null, 'the page-hide hook is removed when the run ends');
});

test('an image read that stalls past its deadline aborts the rotation', async () => {
  const rotationId = globalThis.crypto.randomUUID();
  const api = recordingApi({ head: 0, rotationId, lockRevision: 0 });
  const doc = new Y.Doc();
  const item = new Y.Map();
  item.set('type', 'image');
  item.set('src', `/rooms/${offlineKey().roomHandle}/e2e-blobs/${globalThis.crypto.randomUUID()}`);
  doc.getMap('items').set('img', item);
  const stalled = { read: (_src, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); }), upload: null };
  await rejectsWithKind(rotateRoom({
    currentPassword: PASSWORD, newPassword: NEW_PASSWORD, key: offlineKey(), api, images: stalled, imageTimeoutMs: SHORT_TIMEOUT_MS,
    storage: stuckSource({ encodeState: () => Y.encodeStateAsUpdate(doc) }),
  }), ROTATION_FAILURE.UNAVAILABLE);
  assert.deepEqual(api.calls.map(([name]) => name), ['begin', 'abort']);
});

test('a lock response whose body stalls fails at the request deadline', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"head":');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  installBrowserStandIn(t, `http://127.0.0.1:${server.address().port}`);
  const api = createRoomLockApi(offlineKey().roomHandle, { timeoutMs: SHORT_TIMEOUT_MS });
  await assert.rejects(api.beginRotation({ oldAuthKey: ROOM_LOCK.authKey, expectedRevision: 0 }),
    (error) => error.name === 'RoomLockActionError' && error.kind === LOCK_ACTION_ERROR.UNAVAILABLE);
});
