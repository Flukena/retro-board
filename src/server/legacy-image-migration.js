import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { roomLogId } from './relay-log-id.js';
import { MIME_EXT, ROOM_UPLOAD_USAGE_META, matchesMagicBytes } from './relay-uploads.js';

// One-shot migration: rewrite legacy base64-embedded image `src` fields (from before image uploads existed) to
// server-hosted files, triggered by the YJS_MIGRATE_DOCS env var like YJS_WIPE_DOCS. It runs through the relay's own
// already-open LevelDB: a second LeveldbPersistence against the same DB_DIR conflicts (`Iterator is not open`).
// Idempotent: migrated items no longer have a `data:` src, so re-running is a no-op. Irreversible CRDT surgery,
// so back up the yjs_data volume first. End-to-end encrypted rooms hold no readable board data and are skipped.
const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;
const PRIVATE_FILE_MODE = 0o600;
const MAGIC_BYTES_SNIFF_LENGTH = 12;

const withinLimits = (bytes, room, pending, { config, uploadState }) => (
  bytes.byteLength >= 1 && bytes.byteLength <= config.MAX_UPLOAD_BYTES
  && uploadState.bytes + pending.bytes + bytes.byteLength <= config.MAX_UPLOAD_STORAGE_BYTES
  && room.bytes + pending.bytes + bytes.byteLength <= config.MAX_ROOM_UPLOAD_BYTES
  && uploadState.files + pending.files < config.MAX_UPLOAD_FILES
  && room.files + pending.files < config.MAX_ROOM_UPLOAD_FILES
);

// Writes the file for one embedded image and repoints the item; false when the item is not migratable.
const migrateItem = (yItem, roomHandle, room, pending, ports) => {
  const { Y, config } = ports;
  if (!(yItem instanceof Y.Map) || yItem.get('type') !== 'image') return false;
  const src = yItem.get('src');
  const match = typeof src === 'string' && src.match(DATA_URL_RE);
  const ext = match && MIME_EXT[match[1]];
  if (!ext) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (!matchesMagicBytes(bytes.subarray(0, MAGIC_BYTES_SNIFF_LENGTH), match[1]) || !withinLimits(bytes, room, pending, ports)) return false;
  const imageId = `${randomUUID()}.${ext}`;
  const path = join(config.UPLOADS_DIR, `${roomHandle}.${imageId}`);
  fs.writeFileSync(path, bytes, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  pending.paths.push(path);
  yItem.set('src', `/rooms/${roomHandle}/images/${imageId}`);
  pending.files += 1;
  pending.bytes += bytes.byteLength;
  return true;
};

async function migrateRoom(name, ports, pending) {
  const { Y, registry, roomUploadUsage, uploadState, persistence } = ports;
  const roomHandle = registry.roomHandleForDoc(name);
  const room = roomUploadUsage.get(name);
  if (!roomHandle || !room) throw new Error('migration target is not a registered tokenized room');
  const ydoc = await persistence.getYDoc(name);
  const before = Y.encodeStateAsUpdate(ydoc).byteLength;
  const pendingUpdates = [];
  ydoc.on('update', (update) => pendingUpdates.push(update));
  ydoc.transact(() => {
    ydoc.getMap('items').forEach((yItem) => { migrateItem(yItem, roomHandle, room, pending, ports); });
  }, 'migration');
  for (const update of pendingUpdates) {
    await persistence.storeUpdate(name, update);
    pending.persisted = true;
  }
  if (pending.files) {
    room.bytes += pending.bytes;
    room.files += pending.files;
    await persistence.setMeta(name, ROOM_UPLOAD_USAGE_META, { bytes: room.bytes, files: room.files });
  }
  await persistence.flushDocument(name);
  uploadState.bytes += pending.bytes;
  uploadState.files += pending.files;
  const after = Y.encodeStateAsUpdate(ydoc).byteLength;
  console.log('[yjs] migrated doc', roomLogId(name), { rewritten: pending.files, beforeBytes: before, afterBytes: after });
}

// Before the CRDT update is durable these files are unreachable and safe to roll back. Once the update is stored they
// must remain so a retry can reconcile metadata without breaking already-persisted image URLs.
function rollbackFiles(name, pending) {
  if (pending.persisted) return;
  for (const path of pending.paths) {
    try { fs.unlinkSync(path); }
    catch (error) {
      if (error.code !== 'ENOENT') console.error('[yjs] migration rollback failed', { docName: roomLogId(name), err: error.message });
    }
  }
}

/**
 * Migrates each named document in turn; a failure rolls back that document's files and rethrows.
 * Ports: Y, registry (isLocked, roomHandleForDoc), roomUploadUsage, uploadState, config (upload limits, UPLOADS_DIR),
 * persistence (getYDoc, storeUpdate, setMeta, flushDocument), all checked against storage failures by the caller.
 */
export async function migrateLegacyImages(names, ports) {
  for (const name of names) {
    if (ports.registry.isLocked(name)) {
      console.warn('[yjs] migration skipped: room is end-to-end encrypted', roomLogId(name));
      continue;
    }
    const pending = { paths: [], files: 0, bytes: 0, persisted: false };
    try {
      await migrateRoom(name, ports, pending);
    } catch (err) {
      rollbackFiles(name, pending);
      console.error('[yjs] migration failed', { docName: roomLogId(name), err: err.message });
      throw err;
    }
  }
}
