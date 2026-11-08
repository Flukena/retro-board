import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyImages } from './legacy-image-migration.js';
import { ROOM_UPLOAD_USAGE_META } from './relay-uploads.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const DOC = 'yjs/board-room-aaaaaaaa';
const LOCKED_DOC = 'yjs/board-lock-bbbbbbbb';
const HANDLE = 'H'.repeat(32);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const LIMITS = { MAX_UPLOAD_BYTES: 1024, MAX_UPLOAD_STORAGE_BYTES: 1 << 20, MAX_ROOM_UPLOAD_BYTES: 1 << 20, MAX_UPLOAD_FILES: 100, MAX_ROOM_UPLOAD_FILES: 100 };
const injected = (what) => () => Promise.reject(new Error(`injected ${what} failure`));

async function withMigration(run) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-migration-'));
  const uploadsDir = join(root, 'uploads');
  await mkdir(uploadsDir);
  const ldb = new LeveldbPersistence(join(root, 'db'));
  const seed = new Y.Doc();
  seed.getMap('items').set('img', new Y.Map([['type', 'image'], ['src', DATA_URL]]));
  const lockedSeed = new Y.Doc();
  lockedSeed.getMap('items').set('img', new Y.Map([['type', 'image'], ['src', DATA_URL]]));
  try {
    await ldb.storeUpdate(DOC, Y.encodeStateAsUpdate(seed));
    await ldb.storeUpdate(LOCKED_DOC, Y.encodeStateAsUpdate(lockedSeed));
    const room = { bytes: 0, files: 0 };
    const uploadState = { bytes: 0, files: 0 };
    const persistence = {
      getYDoc: (name) => ldb.getYDoc(name), storeUpdate: (name, update) => ldb.storeUpdate(name, update),
      setMeta: (name, key, value) => ldb.setMeta(name, key, value), flushDocument: (name) => ldb.flushDocument(name),
    };
    const ports = (overrides = {}) => ({
      Y, registry: { isLocked: (name) => name === LOCKED_DOC, roomHandleForDoc: () => HANDLE },
      roomUploadUsage: new Map([[DOC, room], [LOCKED_DOC, room]]), uploadState, config: { ...LIMITS, UPLOADS_DIR: uploadsDir },
      persistence: { ...persistence, ...overrides },
    });
    const storedSrc = async (name) => (await ldb.getYDoc(name)).getMap('items').get('img').get('src');
    await run({ ports, room, uploadState, uploadsDir, storedSrc, ldb });
  } finally {
    await ldb.destroy();
    await rm(root, { recursive: true, force: true });
  }
}

const quiet = async (action) => {
  const { log, error, warn } = console;
  console.log = console.error = console.warn = () => undefined;
  try { return await action(); } finally { Object.assign(console, { log, error, warn }); }
};

test('an embedded image becomes a hosted file, the item is repointed, and usage is counted', () => withMigration(async ({ ports, room, uploadState, uploadsDir, storedSrc, ldb }) => {
  await quiet(() => migrateLegacyImages([DOC], ports()));
  const [file] = await readdir(uploadsDir);
  assert.match(file, new RegExp(`^${HANDLE}\\.[0-9a-f-]{36}\\.png$`));
  assert.ok((await readFile(join(uploadsDir, file))).equals(PNG));
  assert.equal(await storedSrc(DOC), `/rooms/${HANDLE}/images/${file.slice(HANDLE.length + 1)}`);
  assert.deepEqual([room.bytes, room.files, uploadState.bytes, uploadState.files], [PNG.length, 1, PNG.length, 1]);
  assert.deepEqual(await ldb.getMeta(DOC, ROOM_UPLOAD_USAGE_META), { bytes: PNG.length, files: 1 });
}));

test('a failure before the update is stored removes the new files and leaves usage and the document untouched', () => withMigration(async ({ ports, room, uploadState, uploadsDir, storedSrc }) => {
  await assert.rejects(quiet(() => migrateLegacyImages([DOC], ports({ storeUpdate: injected('store') }))), /injected store failure/);
  assert.deepEqual(await readdir(uploadsDir), []);
  assert.deepEqual([room.bytes, room.files, uploadState.bytes, uploadState.files], [0, 0, 0, 0]);
  assert.equal(await storedSrc(DOC), DATA_URL);
}));

test('a failure after the update is stored keeps the files so the persisted image URLs still resolve', () => withMigration(async ({ ports, uploadsDir, storedSrc }) => {
  await assert.rejects(quiet(() => migrateLegacyImages([DOC], ports({ setMeta: injected('usage') }))), /injected usage failure/);
  const files = await readdir(uploadsDir);
  assert.equal(files.length, 1);
  assert.equal(await storedSrc(DOC), `/rooms/${HANDLE}/images/${files[0].slice(HANDLE.length + 1)}`);
}));

test('an encrypted room is skipped: no file is written and its document is not touched', () => withMigration(async ({ ports, uploadsDir, storedSrc }) => {
  await quiet(() => migrateLegacyImages([LOCKED_DOC], ports()));
  assert.deepEqual(await readdir(uploadsDir), []);
  assert.equal(await storedSrc(LOCKED_DOC), DATA_URL);
}));
