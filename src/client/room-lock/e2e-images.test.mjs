import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { PASSWORD, createLockedRoom, lockedRelay } from '../../test-support/locked-room-harness.mjs';
import { installBrowserStandIn } from '../../test-support/browser-stand-in.mjs';
import { listImageSources, rewriteImageSources } from '../session/item-image-sources.js';
import { e2eAad } from '../../domain/room-lock-contract.js';
import { createNextRoomKey, createRoomLock, encryptFrame } from './e2e-crypto.js';
import { clearRoomKey, getRoomKey, unlockRoom } from './lock-session.js';
import {
  decryptImageBytes, encryptImageForUpload, readE2EImage, readE2EImageBytes, resolveE2EImage, uploadEncryptedImage,
} from './e2e-images.js';
import { repairOldEpochImages, repairOldEpochImagesOnce } from './e2e-image-repair.js';

const ROOM_LOCK = await createRoomLock(PASSWORD);
const LOCK_HINT = { salt: ROOM_LOCK.lock.salt, kdf: ROOM_LOCK.lock.kdf };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const SECRET_MARKER = Buffer.from('SECRET-PIXELS-MARKER');
const IMAGE = Buffer.concat([PNG, SECRET_MARKER]);
const imageBlob = (type = 'image/png') => new Blob([IMAGE], { type });
const OLD_EPOCH = 0;
const NEW_EPOCH = 1;

async function openRoom(t) {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env, ROOM_LOCK);
  const { sent } = installBrowserStandIn(t, env.relay.url, ROOM_LOCK.authKey);
  t.after(clearRoomKey);
  await unlockRoom({ code: room.code, token: room.token, password: PASSWORD, lockHint: LOCK_HINT });
  return { env, room, sent, key: getRoomKey() };
}

const bytesOf = async (blob) => Buffer.from(await blob.arrayBuffer());

test('an upload sends only ciphertext: no plaintext image bytes, and the id travels in the header', async (t) => {
  const { sent, key } = await openRoom(t);
  const src = await uploadEncryptedImage(imageBlob(), { key });
  const upload = sent.find((request) => request.url.endsWith('/e2e-blobs') && request.method === 'POST');
  assert.ok(upload, 'the blob was posted to e2e-blobs');
  const body = Buffer.from(upload.body);
  assert.equal(body.includes(SECRET_MARKER), false, 'the marker bytes never leave the browser');
  assert.equal(body.includes(PNG.subarray(0, 8)), false, 'not even the PNG signature');
  assert.equal(sent.some((request) => request.url.endsWith('/upload')), false, 'the plaintext upload route is never used');
  assert.equal(src, `/rooms/${key.roomHandle}/e2e-blobs/${src.split('/').pop()}`);
});

test('a stored image resolves back to the right type and exact bytes', async (t) => {
  const { key } = await openRoom(t);
  const src = await uploadEncryptedImage(imageBlob('image/png'), { key });
  const blob = await readE2EImageBytes(src, { key });
  assert.equal(blob.type, 'image/png');
  assert.ok((await bytesOf(blob)).equals(IMAGE));
});

test('only allowed image types are encrypted, and ciphertext that carries another type is broken, not rendered', async (t) => {
  const { key } = await openRoom(t);
  const id = globalThis.crypto.randomUUID();
  const type = new TextEncoder().encode('image/svg+xml');
  const forged = new Uint8Array([type.length, ...type, 1, 2, 3]);
  const frame = await encryptFrame(key.dek, e2eAad(key.roomHandle, key.keyEpoch, 'blob', id), forged);
  await assert.rejects(decryptImageBytes(frame, `/rooms/${key.roomHandle}/e2e-blobs/${id}`, key), { code: 'broken-image' });
  await assert.rejects(encryptImageForUpload(new Blob(['<svg/>'], { type: 'image/svg+xml' }), key), /unsupported image type/);
  await assert.rejects(encryptImageForUpload(new Blob(['x'], { type: '' }), key), /unsupported image type/);
});

test('a blob whose id was swapped fails decryption', async (t) => {
  const { key } = await openRoom(t);
  const { bytes, id } = await encryptImageForUpload(imageBlob(), key);
  const otherSrc = `/rooms/${key.roomHandle}/e2e-blobs/${globalThis.crypto.randomUUID()}`;
  await assert.rejects(decryptImageBytes(bytes, otherSrc, key), { name: 'RoomKeyError' });
  const own = await decryptImageBytes(bytes, `/rooms/${key.roomHandle}/e2e-blobs/${id}`, key);
  assert.equal(own.epoch, key.keyEpoch);
  const wrongRoom = `/rooms/${'z'.repeat(32)}/e2e-blobs/${id}`;
  await assert.rejects(decryptImageBytes(bytes, wrongRoom, key), { name: 'RoomKeyError' });
});

test('a blob of an earlier epoch opens through the held previous key and reports its epoch', async (t) => {
  const { key: first } = await openRoom(t);
  const next = await createNextRoomKey('another long password');
  const key = { ...first, keyEpoch: NEW_EPOCH, dek: next.dek, previousKeys: new Map([[OLD_EPOCH, first.dek]]) };
  const oldSrc = await uploadEncryptedImage(imageBlob(), { key: { ...first, keyEpoch: OLD_EPOCH } });
  const newSrc = await uploadEncryptedImage(imageBlob(), { key });
  assert.equal((await readE2EImage(oldSrc, { key })).epoch, OLD_EPOCH);
  assert.equal((await readE2EImage(newSrc, { key })).epoch, NEW_EPOCH);
  const withoutOld = { ...key, previousKeys: new Map() };
  await assert.rejects(readE2EImage(oldSrc, { key: withoutOld }), { name: 'RoomKeyError' });
});

test('card leases share one fetch per source and revoke the blob URL with the last release', async (t) => {
  const { key, sent } = await openRoom(t);
  const src = await uploadEncryptedImage(imageBlob(), { key });
  const revoked = [];
  const realRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => { revoked.push(url); realRevoke(url); };
  t.after(() => { URL.revokeObjectURL = realRevoke; });
  const before = sent.length;
  const first = resolveE2EImage(src);
  const second = resolveE2EImage(src);
  const [a, b] = await Promise.all([first.url, second.url]);
  assert.equal(a, b);
  assert.match(a, /^blob:/);
  assert.equal(sent.slice(before).filter((request) => request.url.includes('/e2e-blobs/')).length, 1);
  first.release();
  first.release();
  assert.deepEqual(revoked, [], 'still held by the second card');
  second.release();
  await first.url;
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(revoked, [a]);
});

function boardWith(srcs, roomHandle) {
  const doc = new Y.Doc();
  const items = doc.getMap('items');
  srcs.forEach((src, index) => {
    const item = new Y.Map();
    item.set('type', 'image');
    item.set('src', src);
    items.set(`i${index}`, item);
  });
  const storage = {
    listImageSources: () => listImageSources(items),
    rewriteImageSources: (map) => rewriteImageSources(doc, items, map, 'image-repair', roomHandle),
  };
  const srcOf = (id) => items.get(id).get('src');
  const add = (id, src) => {
    const item = new Y.Map();
    item.set('type', 'image');
    item.set('src', src);
    items.set(id, item);
  };
  return { doc, items, storage, srcOf, add };
}

async function twoEpochRoom(t) {
  const { key: first, sent } = await openRoom(t);
  const next = await createNextRoomKey('another long password');
  const key = { ...first, keyEpoch: NEW_EPOCH, dek: next.dek, previousKeys: new Map([[OLD_EPOCH, first.dek]]) };
  const oldKey = { ...first, keyEpoch: OLD_EPOCH };
  return { key, oldKey, sent };
}

test('repair moves an old-epoch image to a new id under the new key and rewrites every item that shows it', async (t) => {
  const { key, oldKey } = await twoEpochRoom(t);
  const oldSrc = await uploadEncryptedImage(imageBlob(), { key: oldKey });
  const currentSrc = await uploadEncryptedImage(imageBlob(), { key });
  const board = boardWith([oldSrc, currentSrc, oldSrc], key.roomHandle);
  let transactions = 0;
  board.doc.on('afterTransaction', (tr) => { if (tr.changed.size) transactions += 1; });
  const result = await repairOldEpochImagesOnce({ storage: board.storage, key });
  assert.deepEqual(result, { repaired: 2, broken: 0, failed: 0 });
  assert.equal(transactions, 1, 'all rewrites share one local transaction');
  assert.notEqual(board.srcOf('i0'), oldSrc);
  assert.equal(board.srcOf('i0'), board.srcOf('i2'));
  assert.equal(board.srcOf('i1'), currentSrc, 'a current-epoch image is untouched');
  const moved = await readE2EImage(board.srcOf('i0'), { key: { ...key, previousKeys: new Map() } });
  assert.equal(moved.epoch, NEW_EPOCH, 'the new copy opens with the new key alone');
  assert.ok((await bytesOf(moved.blob)).equals(IMAGE));
  assert.equal(key.previousKeys.has(OLD_EPOCH), true, 'earlier keys stay for the whole page lifetime');
});

test('repair counts a transport failure as failed, and a missing blob or an undecryptable image as broken', async (t) => {
  const { key, oldKey } = await twoEpochRoom(t);
  const oldSrc = await uploadEncryptedImage(imageBlob(), { key: oldKey });
  const missing = `/rooms/${key.roomHandle}/e2e-blobs/${globalThis.crypto.randomUUID()}`;
  const result = await repairOldEpochImagesOnce({ storage: boardWith([oldSrc, missing], key.roomHandle).storage, key });
  assert.deepEqual(result, { repaired: 1, broken: 1, failed: 0 }, 'a swept blob is never retried');
  const unreachable = await uploadEncryptedImage(imageBlob(), { key: oldKey });
  const pageFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).endsWith(unreachable.split('/').pop()) ? Promise.reject(new TypeError('network down')) : pageFetch(url, init));
  let offline;
  try {
    offline = await repairOldEpochImagesOnce({ storage: boardWith([unreachable], key.roomHandle).storage, key });
  } finally {
    globalThis.fetch = pageFetch;
  }
  assert.deepEqual(offline, { repaired: 0, broken: 0, failed: 1 }, 'a transport failure is retried later');
  const stranger = await createNextRoomKey('yet another password');
  const foreign = await uploadEncryptedImage(imageBlob(), { key: { ...key, dek: stranger.dek } });
  const broken = await repairOldEpochImagesOnce({ storage: boardWith([foreign], key.roomHandle).storage, key });
  assert.deepEqual(broken, { repaired: 0, broken: 1, failed: 0 });
});

test('a deleted then undone old reference is still repaired later, because earlier keys are kept', async (t) => {
  const { key, oldKey } = await twoEpochRoom(t);
  const oldSrc = await uploadEncryptedImage(imageBlob(), { key: oldKey });
  const board = boardWith([oldSrc], key.roomHandle);
  const undo = new Y.UndoManager(board.items);
  board.items.delete('i0');
  assert.deepEqual(await repairOldEpochImagesOnce({ storage: board.storage, key }), { repaired: 0, broken: 0, failed: 0 });
  undo.undo();
  assert.equal(board.srcOf('i0'), oldSrc, 'undo brings the old reference back');
  assert.ok(key.previousKeys.has(OLD_EPOCH));
  assert.equal((await readE2EImage(oldSrc, { key })).epoch, OLD_EPOCH, 'it still renders');
  assert.deepEqual(await repairOldEpochImagesOnce({ storage: board.storage, key }), { repaired: 1, broken: 0, failed: 0 });
});

test('an item whose source changed during repair is left alone', async (t) => {
  const { key, oldKey } = await twoEpochRoom(t);
  const oldSrc = await uploadEncryptedImage(imageBlob(), { key: oldKey });
  const other = await uploadEncryptedImage(imageBlob(), { key });
  const board = boardWith([oldSrc], key.roomHandle);
  const racing = { ...board.storage, rewriteImageSources: (map) => {
    board.items.get('i0').set('src', other);
    return board.storage.rewriteImageSources(map);
  } };
  assert.deepEqual(await repairOldEpochImagesOnce({ storage: racing, key }), { repaired: 0, broken: 0, failed: 0 });
  assert.equal(board.srcOf('i0'), other);
});

test('the rewrite refuses sources that are not canonical encrypted sources of this room', async (t) => {
  const { key } = await twoEpochRoom(t);
  const own = (id = globalThis.crypto.randomUUID()) => `/rooms/${key.roomHandle}/e2e-blobs/${id}`;
  const board = boardWith([own()], key.roomHandle);
  const good = own();
  const cases = [
    new Map([[board.srcOf('i0'), `/rooms/${'z'.repeat(32)}/e2e-blobs/${globalThis.crypto.randomUUID()}`]]),
    new Map([[board.srcOf('i0'), 'javascript:alert(1)']]),
    new Map([[board.srcOf('i0'), `/yjs${good}`]]),
    new Map([[board.srcOf('i0'), own('not-a-uuid')]]),
    new Map([[`/rooms/${'z'.repeat(32)}/e2e-blobs/${globalThis.crypto.randomUUID()}`, good]]),
    new Map([['/images/abcdef12.png', good]]),
  ];
  const before = board.srcOf('i0');
  for (const replacements of cases) assert.throws(() => board.storage.rewriteImageSources(replacements), RangeError);
  assert.equal(board.srcOf('i0'), before);
});

test('repair never runs twice at once: a second request joins the running one', async (t) => {
  const { key, oldKey } = await twoEpochRoom(t);
  const oldSrc = await uploadEncryptedImage(imageBlob(), { key: oldKey });
  const board = boardWith([oldSrc], key.roomHandle);
  const options = { storage: board.storage, key };
  const first = repairOldEpochImages(options);
  const second = repairOldEpochImages(options);
  assert.equal(first, second);
  await first;
  assert.notEqual(board.srcOf('i0'), oldSrc);
});

test('without earlier keys repair does nothing', async (t) => {
  const { key } = await openRoom(t);
  const board = boardWith([`/rooms/${key.roomHandle}/e2e-blobs/${globalThis.crypto.randomUUID()}`], key.roomHandle);
  assert.deepEqual(await repairOldEpochImagesOnce({ storage: board.storage, key }), { repaired: 0, broken: 0, failed: 0 });
});
