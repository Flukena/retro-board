import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  E2E_BLOBS_KEY, E2E_HEAD_KEY, E2E_SNAPSHOT_KEY, E2E_UPDATE_KEY_PREFIX, e2eSeqOfKey, verifySnapshotDigest,
} from '../src/server/e2e-room-log.js';
import { BLOB_ID_PATTERN } from '../src/domain/room-lock-contract.js';
import { ROOM_LOCK_META, decodeLockRecord, hasLockMeta } from '../src/server/room-lock-record.js';
import {
  LOCKED_REGISTRATION_MARKER, ROOM_HANDLE_META, ROOM_REGISTRATION_META, isCommittedRegistration,
} from '../src/server/relay-room-registry.js';
import { ROOM_HANDLE_RE } from '../src/server/relay-config.js';
import { e2eBlobFilename, parseE2EBlobFilename } from '../src/server/relay-uploads.js';

// Messages are fixed strings: room names, handles and blob ids stay out of them.
const UNREADABLE = 'encrypted room storage cannot be read';
const INVALID_LOCK = 'encrypted room lock record is invalid';
const HEAD_BEHIND = 'encrypted room head is behind its snapshot';
const SNAPSHOT_MISSING = 'encrypted room snapshot is missing';
const SNAPSHOT_DIGEST = 'encrypted room snapshot digest does not match';
const LOG_GAP = 'encrypted room update log is not contiguous';
const INVALID_INVENTORY = 'encrypted room blob inventory is invalid';
const MISSING_HANDLE = 'encrypted room has no handle';
const BAD_BLOB_FILE = 'encrypted room blob file is missing or has the wrong size';

const fail = (message) => { throw new Error(message); };
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function checkSnapshotAndLog(metas) {
  const snapshot = metas.get(E2E_SNAPSHOT_KEY);
  const head = metas.get(E2E_HEAD_KEY) ?? 0;
  const seqs = [...metas.keys()].filter((key) => key.startsWith(E2E_UPDATE_KEY_PREFIX)).map(e2eSeqOfKey).sort((a, b) => a - b);
  if (snapshot !== undefined && (!isCount(snapshot.baseSeq) || !verifySnapshotDigest(snapshot))) fail(SNAPSHOT_DIGEST);
  if (snapshot === undefined && seqs.length > 0 && seqs[0] > 1) fail(SNAPSHOT_MISSING);
  const baseSeq = snapshot?.baseSeq ?? 0;
  if (!isCount(head) || head < baseSeq) fail(HEAD_BEHIND);
  const expectedCount = head - baseSeq;
  if (seqs.length !== expectedCount || seqs.some((seq, index) => seq !== baseSeq + 1 + index)) fail(LOG_GAP);
}

const isInventoryEntry = (entry) => typeof entry?.id === 'string' && BLOB_ID_PATTERN.test(entry.id) && isCount(entry.bytes);

function readInventory(metas) {
  const inventory = metas.get(E2E_BLOBS_KEY) ?? [];
  if (!Array.isArray(inventory) || !inventory.every(isInventoryEntry)) fail(INVALID_INVENTORY);
  return inventory;
}

async function checkBlobFiles(uploadsDir, handle, inventory) {
  for (const entry of inventory) {
    let size = -1;
    try {
      size = (await stat(join(uploadsDir, e2eBlobFilename(handle, entry.id)))).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (size !== entry.bytes) fail(BAD_BLOB_FILE);
  }
}

async function listBlobFiles(uploadsDir) {
  let names;
  try {
    names = await readdir(uploadsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.map(parseE2EBlobFilename).filter(Boolean);
}

/**
 * Read-only check of the encrypted rooms in a restored relay LevelDB and uploads directory. Documents without a
 * committed registration marker are skipped, as the relay quarantines them. Every committed room with a lock record
 * or the locked-room marker must decode its lock record, have a snapshot whose digest matches whenever its log starts after seq 0, keep
 * `head >= baseSeq` with updates contiguous from `baseSeq + 1` to `head`, and have a file of exactly the
 * recorded length for each blob inventory entry. Staged blobs (a backup taken mid-rotation) and files that
 * the inventory does not list are reported as counts, not errors. A backup without locked rooms verifies with 0.
 * @param {{ getAllDocNames(): Promise<string[]>, getMetas(docName: string): Promise<Map<string, unknown>> }} persistence y-leveldb persistence
 * @param {string} uploadsDir restored uploads directory
 * @returns {Promise<{ rooms: number, stagedBlobs: number, orphanBlobs: number }>}
 */
export async function verifyBackupE2ERooms(persistence, uploadsDir) {
  const names = await persistence.getAllDocNames();
  if (!Array.isArray(names)) fail(UNREADABLE);
  const files = await listBlobFiles(uploadsDir);
  const result = { rooms: 0, stagedBlobs: 0, orphanBlobs: 0 };
  for (const name of names) {
    const metas = await persistence.getMetas(name);
    if (!(metas instanceof Map)) fail(UNREADABLE);
    const marker = metas.get(ROOM_REGISTRATION_META);
    if (!isCommittedRegistration(marker)) continue;
    if (!hasLockMeta(metas.get(ROOM_LOCK_META)) && marker !== LOCKED_REGISTRATION_MARKER) continue;
    if (!decodeLockRecord(metas.get(ROOM_LOCK_META))) fail(INVALID_LOCK);
    checkSnapshotAndLog(metas);
    const inventory = readInventory(metas);
    const handle = metas.get(ROOM_HANDLE_META);
    if (!ROOM_HANDLE_RE.test(handle ?? '')) fail(MISSING_HANDLE);
    await checkBlobFiles(uploadsDir, handle, inventory);
    const listed = new Set(inventory.map((entry) => entry.id));
    result.rooms += 1;
    result.stagedBlobs += inventory.filter((entry) => entry.stagedFor).length;
    result.orphanBlobs += files.filter((file) => file.handle === handle && !listed.has(file.id)).length;
  }
  return result;
}
