import { realpath, readFile, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { requirePublicDirectory } from './public-wall-history.js';
import { PUBLIC_BACKUP_FILE_PATTERN, PUBLIC_SNAPSHOT_DIRECTORY, publicRelayEnvironment } from './public-wall-config.js';
import { ROOM_REGISTRATION_META, TOKENIZED_ROOM_RE, RoomRegistry } from './relay-room-registry.js';
import { directorySizeSync, loadSessionSigningKey } from './relay-local-files.js';
import { readRelayConfig } from './relay-config.js';
import { preparePublicRestoreImages } from './public-restore-images.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const COMMITTED_REGISTRATION_VERSION = 1;
const QUARANTINED_REGISTRATION_VERSION = 0;
const PUBLIC_RESTORE_ROOM_SLOTS = 2;

async function validatedSnapshot(directory, snapshotPath) {
  const snapshot = await realpath(snapshotPath);
  const expected = await realpath(join(directory, PUBLIC_SNAPSHOT_DIRECTORY));
  if (dirname(snapshot) !== expected || !PUBLIC_BACKUP_FILE_PATTERN.test(basename(snapshot))) {
    throw new Error('Choose a snapshot inside the public relay snapshot directory');
  }
  if ((await stat(snapshot)).size > readRelayConfig().MAX_DOCUMENT_BYTES) throw new Error('Snapshot exceeds document budget');
  const bytes = await readFile(snapshot);
  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, bytes); }
  finally { doc.destroy(); }
  return bytes;
}

async function checkedDocNames(db) {
  const names = await db.getAllDocNames(); // Opens LevelDB: its exclusive lock refuses a running relay.
  if (!Array.isArray(names)) throw new Error('Public relay is running or database lock failed');
  return names;
}

async function checkedMeta(db, name, key) {
  const value = await db.getMeta(name, key);
  if (value === null) throw new Error('Cannot read public room metadata');
  return value;
}

async function committedRoom(db) {
  const names = await checkedDocNames(db);
  const committed = [];
  for (const name of names) {
    if (TOKENIZED_ROOM_RE.test(name.replace(/^yjs\//, ''))
        && await checkedMeta(db, name, ROOM_REGISTRATION_META) === COMMITTED_REGISTRATION_VERSION) committed.push(name);
  }
  if (committed.length !== 1) throw new Error('Public restore requires exactly one committed room');
  return committed[0];
}

async function checkedWrite(operation) {
  if (await operation === null) throw new Error('Public restore storage operation failed');
}

function restoreRegistry(db, directory) {
  const config = readRelayConfig(publicRelayEnvironment({ ...process.env, YJS_PUBLIC_WALL: 'true', YJS_DB_DIR: directory }));
  const measureDatabase = () => directorySizeSync(directory, { excludedRootDirectories: [PUBLIC_SNAPSHOT_DIRECTORY] });
  const persistence = {
    getAllDocNames: () => checkedDocNames(db),
    getMeta: (...args) => checkedMeta(db, ...args),
    setMeta: (...args) => checkedWrite(db.setMeta(...args)),
    async storeUpdate(...args) {
      const clock = await db.storeUpdate(...args);
      if (!Number.isInteger(clock)) throw new Error('Cannot restore public room state');
      return clock;
    },
    clearDocument: name => checkedWrite(db.clearDocument(name)),
    flushDocument: name => checkedWrite(db.flushDocument(name)),
    measureDatabase, hasCapacity: () => measureDatabase() < config.MAX_DB_BYTES,
    reserveStore: () => () => {},
  };
  return new RoomRegistry({ persistence, Y, maxRooms: PUBLIC_RESTORE_ROOM_SLOTS,
    maxDatabaseBytes: config.MAX_DB_BYTES, signingKey: loadSessionSigningKey(directory) });
}

async function restoreRoomImages(db, registry, room, doc, images) {
  const name = registry.registeredDocForCapability(room.code, room.token);
  if (!await images.restore(registry.roomHandleForDoc(name))) return;
  await checkedWrite(db.storeUpdate(name, Y.encodeStateAsUpdate(doc)));
  await checkedWrite(db.flushDocument(name));
}

export async function restorePublicWall(directoryPath, snapshotPath) {
  const directory = await realpath(directoryPath);
  requirePublicDirectory(directory); // Never initialize or adopt an unmarked/private database.
  const bytes = await validatedSnapshot(directory, snapshotPath);
  const db = new LeveldbPersistence(directory);
  const restoredDoc = new Y.Doc();
  try {
    const retiredName = await committedRoom(db);
    const registry = restoreRegistry(db, directory);
    await registry.hydrate({ complete: false, roomsByHandle: new Map() });
    Y.applyUpdate(restoredDoc, bytes);
    const environment = publicRelayEnvironment({ ...process.env, YJS_PUBLIC_WALL: 'true', YJS_DB_DIR: directory });
    const images = await preparePublicRestoreImages(restoredDoc, { databaseDirectory: directory,
      uploadsDirectory: environment.YJS_UPLOADS_DIR });
    // Publish the complete restored state through the normal marker-last path.
    // Until publication succeeds, the old room remains intact for recovery.
    const restoredRoom = await registry.createRoom({ initialUpdate: bytes });
    await restoreRoomImages(db, registry, restoredRoom, restoredDoc, images);
    await checkedWrite(db.setMeta(retiredName, ROOM_REGISTRATION_META, QUARANTINED_REGISTRATION_VERSION));
    await checkedWrite(db.clearDocument(retiredName));
    // A crash before retirement leaves two committed rooms: public startup's
    // one-room limit fails closed rather than serving the stale room.
  } finally { restoredDoc.destroy(); await db.destroy(); }
}
