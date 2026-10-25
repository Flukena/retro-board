import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomRegistry, ROOM_HANDLE_META, ROOM_REGISTRATION_META } from './relay-room-registry.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const SESSION_SIGNING_KEY = Buffer.alloc(32, 1);
const IMAGE_ID = 'abcdef01.png';
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RESTORED_ITEM_COUNT = 2;

async function committedRooms(directory) {
  const db = new LeveldbPersistence(directory);
  try {
    const names = [];
    for (const name of await db.getAllDocNames()) {
      if (await db.getMeta(name, ROOM_REGISTRATION_META) === 1) names.push(name);
    }
    return names;
  } finally { await db.destroy(); }
}

test('restore refuses a running relay, restores exact state, rotates the handle and rejects private data', async t => {
  const { restorePublicWall } = await import('./public-wall-restore.js');
  const { claimPublicDirectory } = await import('./public-wall-history.js');
  const root = await mkdtemp(join(tmpdir(), 'wall-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicDir = join(root, 'public');
  claimPublicDirectory(publicDir);
  const db = new LeveldbPersistence(publicDir);
  const registry = new RoomRegistry({ persistence: {
    hasCapacity: () => true, reserveStore: () => () => {}, measureDatabase: () => 0,
    getAllDocNames: () => db.getAllDocNames(), getMeta: (...args) => db.getMeta(...args),
    storeUpdate: (...args) => db.storeUpdate(...args), setMeta: (...args) => db.setMeta(...args),
    flushDocument: (...args) => db.flushDocument(...args), clearDocument: (...args) => db.clearDocument(...args),
  }, Y, maxRooms: 1, maxDatabaseBytes: 1000000, signingKey: SESSION_SIGNING_KEY });
  await registry.createRoom();
  const [name] = registry.registeredDocs;
  const handle = registry.roomHandleForDoc(name);
  const uploadsDirectory = join(root, 'public-uploads');
  await mkdir(uploadsDirectory);
  const originalImage = join(uploadsDirectory, `${handle}.${IMAGE_ID}`);
  await writeFile(originalImage, IMAGE_BYTES);
  const snapshotDir = join(publicDir, 'snapshots');
  await mkdir(snapshotDir);
  const snapshot = join(snapshotDir, 'wall-1700000000000.bin');
  const doc = new Y.Doc();
  doc.getMap('meta').set('restored', 'exact');
  doc.getMap('items').set('card', new Y.Map([['text', new Y.Text('recover me')]]));
  doc.getMap('items').set('image', new Y.Map(Object.entries({ type: 'image', x: 0, y: 0, w: 100, h: 100,
    src: `/yjs-public/rooms/${handle}/images/${IMAGE_ID}` })));
  await writeFile(snapshot, Y.encodeStateAsUpdate(doc));
  const stale = new Y.Doc();
  t.after(() => stale.destroy());
  Y.applyUpdate(stale, Y.encodeStateAsUpdate(doc));
  stale.getMap('items').delete('card');
  const vandalState = Y.encodeStateAsUpdate(stale);
  await db.storeUpdate(name, vandalState);
  doc.destroy();
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/public-wall-restore.mjs', publicDir, snapshot]), /Restore refused/);
  }
  finally { await db.destroy(); }
  await restorePublicWall(publicDir, snapshot);
  const restoredDb = new LeveldbPersistence(publicDir);
  try {
    const names = await restoredDb.getAllDocNames();
    const liveNames = [];
    for (const candidate of names) {
      if (await restoredDb.getMeta(candidate, ROOM_REGISTRATION_META) === 1) liveNames.push(candidate);
    }
    assert.equal(liveNames.length, 1);
    const [restoredName] = liveNames;
    assert.equal(restoredName === name, false, 'restore must retire the stale replica document identity');
    const restored = await restoredDb.getYDoc(restoredName);
    assert.deepEqual(restored.getMap('meta').toJSON(), { restored: 'exact' });
    try {
      assert.equal(restored.getMap('items').get('card').get('text').toString(), 'recover me');
      const freshHandle = await restoredDb.getMeta(restoredName, ROOM_HANDLE_META);
      assert.notEqual(freshHandle, handle);
      assert.equal(restored.getMap('items').get('image').get('src'), `/yjs-public/rooms/${freshHandle}/images/${IMAGE_ID}`);
      const restoredImage = join(uploadsDirectory, `${freshHandle}.${IMAGE_ID}`);
      assert.deepEqual(await readFile(restoredImage), IMAGE_BYTES);
      const [originalStat, restoredStat] = await Promise.all([stat(originalImage), stat(restoredImage)]);
      assert.equal(restoredStat.ino, originalStat.ino);
      assert.notEqual(await restoredDb.getMeta(name, ROOM_REGISTRATION_META), 1);
      const registryAfterRestore = new RoomRegistry({ persistence: {
        getAllDocNames: () => restoredDb.getAllDocNames(), getMeta: (...args) => restoredDb.getMeta(...args),
        setMeta: (...args) => restoredDb.setMeta(...args), measureDatabase: () => 0,
      }, Y, maxRooms: 1, maxDatabaseBytes: 1000000, signingKey: SESSION_SIGNING_KEY });
      await registryAfterRestore.hydrate({ complete: false, roomsByHandle: new Map() });
      const admittedHandles = registryAfterRestore.registeredRoomsByHandle;
      if (admittedHandles.has(handle)) Y.applyUpdate(restored, vandalState);
      assert.equal(admittedHandles.has(handle), false);
      assert.equal(restored.getMap('items').size, RESTORED_ITEM_COUNT, 'a stale handle cannot submit its vandalism to the restored room');
      assert.equal(await restoredDb.getMeta(restoredName, ROOM_REGISTRATION_META), 1);
    } finally { restored.destroy(); }
  } finally { await restoredDb.destroy(); }
  const committedBeforeFailure = await committedRooms(publicDir);
  const missingSnapshot = join(snapshotDir, 'wall-1700000000001.bin');
  const missingImage = new Y.Doc();
  try {
    missingImage.getMap('items').set('missing', new Y.Map(Object.entries({ type: 'image',
      src: `/yjs-public/rooms/${handle}/images/fedcba98.png` })));
    await writeFile(missingSnapshot, Y.encodeStateAsUpdate(missingImage));
  } finally { missingImage.destroy(); }
  await assert.rejects(restorePublicWall(publicDir, missingSnapshot), /missing/);
  const committedAfterFailure = await committedRooms(publicDir);
  assert.equal(committedAfterFailure.length, committedBeforeFailure.length,
    'validation failure must leave exactly the healthy committed public room');
  assert.equal(committedAfterFailure[0] === committedBeforeFailure[0], true);
  await writeFile(snapshot, 'corrupt snapshot');
  await assert.rejects(restorePublicWall(publicDir, snapshot));
  const privateDir = join(root, 'private');
  await mkdir(privateDir);
  const privateSentinel = join(privateDir, 'main-do-not-touch');
  await writeFile(privateSentinel, 'preserved');
  await assert.rejects(restorePublicWall(privateDir, snapshot));
  assert.equal(await readFile(privateSentinel, 'utf8'), 'preserved');
  await assert.rejects(restorePublicWall(publicDir, join(root, 'outside.bin')));
});
