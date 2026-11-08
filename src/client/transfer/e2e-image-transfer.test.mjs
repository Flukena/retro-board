import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, createLockedRoom, createNormalRoom, lockedRelay } from '../../test-support/locked-room-harness.mjs';
import { installBrowserStandIn } from '../../test-support/browser-stand-in.mjs';
import { createRoomLock } from '../room-lock/e2e-crypto.js';
import { clearRoomKey, unlockRoom } from '../room-lock/lock-session.js';
import { readE2EImageBytes, uploadEncryptedImage } from '../room-lock/e2e-images.js';
import { clearRoomSession, establishRoomSession } from '../session/room-session.js';
import { createPortableJsonBackupArtifact } from './board-backup.js';
import { createBoardArchiveArtifact, readBoardArchive } from './board-archive.js';
import { restoreBackupImages } from './backup-images.js';
import { readBoardImport } from './board-transfer.js';
import { readBackupImage, safeRuntimeImageSource } from './image-upload.js';

const ROOM_LOCK = await createRoomLock(PASSWORD);
const LOCK_HINT = { salt: ROOM_LOCK.lock.salt, kdf: ROOM_LOCK.lock.kdf };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const MARKER = Buffer.from('SECRET-PIXELS-MARKER');
const IMAGE = Buffer.concat([PNG, MARKER]);
const NATURAL_SIZE_PX = 1;
const ITEM_SIZE_PX = 120;

const imageItem = (id, src) => ({ id, type: 'image', x: 10, y: 20, w: ITEM_SIZE_PX, h: ITEM_SIZE_PX, src, natW: NATURAL_SIZE_PX, natH: NATURAL_SIZE_PX });
const boardOptions = (items) => ({ fallbackBoardCode: 'ROOMA', board: { items }, votes: new Map(), comments: new Map(), moods: {}, customTemplates: [] });

async function enter(room) {
  clearRoomKey();
  clearRoomSession();
  await unlockRoom({ code: room.code, token: room.token, password: PASSWORD, lockHint: LOCK_HINT });
}

async function twoLockedRooms(t) {
  const env = await lockedRelay(t);
  const roomA = await createLockedRoom(env, ROOM_LOCK);
  const roomB = await createLockedRoom(env, ROOM_LOCK);
  const { sent } = installBrowserStandIn(t, env.relay.url, ROOM_LOCK.authKey);
  t.after(clearRoomKey);
  return { env, roomA, roomB, sent };
}

// The seam the board uses (`window.storage.uploadImage`) encrypts in a locked room; storage-bridge.test.js covers the bridge itself.
const lockedUpload = (blob) => uploadEncryptedImage(blob);
const restore = (manifest, extra) => restoreBackupImages(manifest.items, {
  readImage: readBackupImage,
  prepareImage: async (blob) => ({ blob, nw: NATURAL_SIZE_PX, nh: NATURAL_SIZE_PX }),
  uploadImage: lockedUpload,
  resolveSource: safeRuntimeImageSource,
  ...extra,
});

async function exportedFrom(roomA) {
  await enter(roomA);
  const src = await uploadEncryptedImage(new Blob([IMAGE], { type: 'image/png' }));
  const items = [imageItem('one', src), imageItem('two', src)];
  return { src, items };
}

test('a normal room never fetches an encrypted image path', async (t) => {
  const env = await lockedRelay(t);
  const room = await createNormalRoom(env.relay);
  const { sent } = installBrowserStandIn(t, env.relay.url, null);
  await establishRoomSession(room.code, room.token);
  const before = sent.length;
  const foreign = `/rooms/${room.handle}/e2e-blobs/${globalThis.crypto.randomUUID()}`;
  assert.equal(safeRuntimeImageSource(foreign), null);
  await assert.rejects(readBackupImage(foreign), /another room or server/);
  assert.equal(sent.length, before, 'no request was made');
});

test('JSON export of a locked room carries the decrypted image and imports into another locked room as new ciphertext', async (t) => {
  const { roomA, roomB, sent } = await twoLockedRooms(t);
  const { items } = await exportedFrom(roomA);
  const artifact = await createPortableJsonBackupArtifact(boardOptions(items), readBackupImage);
  assert.match(artifact.contents, /data:image\/png;base64,/);
  assert.ok(Buffer.from(artifact.contents.match(/base64,([A-Za-z0-9+/=]+)/)[1], 'base64').equals(IMAGE));

  await enter(roomB);
  const manifest = await readBoardImport(new File([artifact.contents], 'board.json', { type: 'application/json' }));
  const restored = (await restore(manifest)).filter((item) => item.type === 'image');
  assert.equal(restored.length, 2);
  for (const item of restored) assert.match(item.src, new RegExp(`^/rooms/${roomB.handle}/e2e-blobs/`));
  assert.ok((await readE2EImageBytes(restored[0].src).then((blob) => blob.arrayBuffer()).then(Buffer.from)).equals(IMAGE));
  for (const request of sent.filter((r) => r.method === 'POST' && r.url.includes('/e2e-blobs'))) {
    assert.equal(Buffer.from(request.body).includes(MARKER), false, 'no upload carried plaintext');
  }
});

test('ZIP export of a locked room imports into another locked room', async (t) => {
  const { roomA, roomB } = await twoLockedRooms(t);
  const { items } = await exportedFrom(roomA);
  const artifact = await createBoardArchiveArtifact(boardOptions(items), readBackupImage);
  await enter(roomB);
  const manifest = await readBoardArchive(artifact.blob);
  const restored = (await restore(manifest, { readImageBlob: manifest.readImageBlob })).filter((item) => item.type === 'image');
  assert.equal(restored.length, 2);
  assert.match(restored[0].src, new RegExp(`^/rooms/${roomB.handle}/e2e-blobs/`));
  const opened = Buffer.from(await (await readE2EImageBytes(restored[1].src)).arrayBuffer());
  assert.ok(opened.equals(IMAGE));
});

test('importing a source that points at another locked room is refused instead of fetched', async (t) => {
  const { roomA, roomB, sent } = await twoLockedRooms(t);
  const { items } = await exportedFrom(roomA);
  await enter(roomB);
  const before = sent.length;
  const manifest = { items };
  await assert.rejects(restore(manifest), /another room or server/);
  assert.equal(sent.slice(before).some((request) => request.url.includes('/e2e-blobs/')), false);
});
