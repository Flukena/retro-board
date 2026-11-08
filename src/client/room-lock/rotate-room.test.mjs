import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { InboundGate, ownerBoard } from '../../test-support/owner-board-harness.mjs';
import { delivered, synced, textOf, until } from '../../test-support/e2e-room-fixture.mjs';
import { ORIGIN, PASSWORD } from '../../test-support/locked-room-harness.mjs';
import { createRoomLock } from './e2e-crypto.js';
import { getRoomKey, reunlock } from './lock-session.js';
import { readE2EImage, uploadEncryptedImage } from './e2e-images.js';
import { createRoomLockApi } from './room-lock-api.js';
import { ROTATION_FAILURE, rotateRoom } from './rotate-room.js';

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
  const response = await board.relayFetch(`${board.env.relay.url}${src}`, { headers: { origin: ORIGIN, cookie: board.browser.cookieHeader() } });
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
    appliedSeq: 0, head: 0, appliedSnapshotBase: 0, pendingDelivery: 0, ...overrides,
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

test('the new password must differ from the current one', async () => {
  const api = recordingApi();
  await assert.rejects(rotateRoom({
    currentPassword: PASSWORD, newPassword: PASSWORD, key: offlineKey(), storage: stuckSource(), api, clock: fakeClock(),
  }), RangeError);
  assert.deepEqual(api.calls, []);
});
