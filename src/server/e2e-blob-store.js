import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { e2eBlobFilename, parseE2EBlobFilename } from './relay-uploads.js';

/** An unreferenced `.e2e` file younger than this may be an upload still in flight, so it is kept. */
export const E2E_ORPHAN_MIN_AGE_MS = 3_600_000;
const BLOB_TEMP_PREFIX = '.upload-e2e-';
const BLOB_TEMP_RE = /^\.upload-e2e-[0-9a-f-]+\.tmp$/;
const ORPHAN_LOG = '[yjs] e2e orphan blob sweep';
const NOT_FOUND = 'ENOENT';
const ALREADY_EXISTS = 'EEXIST';

/** Key of a blob in an inventory Set: `<handle>.<id>`. */
export const inventoryKey = (handle, id) => `${handle}.${id}`;

/**
 * Files of encrypted-room blobs in the uploads directory, with the same usage accounting as images.
 * Knows nothing about the room log: callers hand it handles, ids and inventories.
 * Ports: admission (usage helpers of createRelayUploads), roomUploadUsage, io (fs.promises).
 */
export class E2EBlobStore {
  #uploadsDir;
  #admission;
  #roomUploadUsage;
  #io;
  #logger;
  #staged = new Map();
  // docName -> generation, bumped each time the room retires more blobs
  #retiredRooms = new Map();

  constructor({ uploadsDir, admission, roomUploadUsage, io = fs.promises, logger = console }) {
    this.#uploadsDir = uploadsDir;
    this.#admission = admission;
    this.#roomUploadUsage = roomUploadUsage;
    this.#io = io;
    this.#logger = logger;
  }

  /** A fresh temp path; the generic interrupted-upload sweep matches it, and the prefix marks it as a blob's. */
  newTempPath() { return join(this.#uploadsDir, `${BLOB_TEMP_PREFIX}${randomUUID()}.tmp`); }

  /** Remembers a room that has old-epoch blobs inside their grace, so expiry finds it even when the room is not in memory. */
  trackRetired(docName) { this.#retiredRooms.set(docName, (this.#retiredRooms.get(docName) ?? 0) + 1); }

  /** The room's retirement generation: pass it back to untrackRetired to untrack only if nothing was retired since. */
  retiredGeneration(docName) { return this.#retiredRooms.get(docName); }

  /** Stops visiting a room. With `generation`, only when no blob was retired since that generation was read. */
  untrackRetired(docName, generation = this.#retiredRooms.get(docName)) {
    if (this.#retiredRooms.get(docName) === generation) this.#retiredRooms.delete(docName);
    return !this.#retiredRooms.has(docName);
  }

  retiredRooms() { return [...this.#retiredRooms.keys()]; }

  pathOf(handle, id) { return join(this.#uploadsDir, e2eBlobFilename(handle, id)); }

  /** Hard-links the temp file to the blob name, then drops the temp. False when the id already has a file. */
  async publish(tempPath, handle, id) {
    try {
      await this.#io.link(tempPath, this.pathOf(handle, id));
    } catch (error) {
      await this.#unlinkQuietly(tempPath);
      if (error.code === ALREADY_EXISTS) return false;
      throw error;
    }
    await this.#unlinkQuietly(tempPath);
    return true;
  }

  async #unlinkQuietly(path) {
    try {
      await this.#io.unlink(path);
    } catch (error) {
      if (error.code !== NOT_FOUND) this.#logger.warn('[yjs] e2e blob cleanup failed', { err: error.message });
    }
  }

  /** Counts a published blob toward room and global usage, exactly like an image. */
  async account(docName, bytes) {
    const room = this.#roomUploadUsage.get(docName);
    if (!room) return;
    this.#admission.addFileUsage(room, bytes);
    await this.#admission.persistRoomUsage(docName, room);
  }

  /** Remembers the file of a blob staged for a rotation, so releasing that rotation can delete it. */
  rememberStaged(rotationId, docName, handle, id) {
    const files = this.#staged.get(rotationId) ?? [];
    files.push({ docName, handle, id });
    this.#staged.set(rotationId, files);
  }

  /** Deletes the files of every blob staged for a released rotation; a failed run can be retried. */
  async deleteStaged(rotationId) {
    await this.#removeAll(this.#staged.get(rotationId) ?? []);
    this.#staged.delete(rotationId);
  }

  /**
   * After a durable rotation commit: deletes the files staged for `rotationId` that were not kept, then forgets the
   * rotation. A failed run keeps the record, so calling again retries.
   */
  async settleStaged(rotationId, keepIds) {
    const keep = new Set(keepIds);
    await this.#removeAll((this.#staged.get(rotationId) ?? []).filter(({ id }) => !keep.has(id)));
    this.#staged.delete(rotationId);
  }

  async discardTemp(tempPath) { await this.#unlinkQuietly(tempPath); }

  /** Unlinks a blob file that was never counted (a failed upload). */
  async discard(handle, id) { await this.#unlinkQuietly(this.pathOf(handle, id)); }

  /** Deletes a blob file and gives its bytes back to room and global usage. True when a file was removed. */
  async remove(docName, handle, id) {
    return (await this.#removeAll([{ docName, handle, id }])) > 0;
  }

  async #removeAll(files) {
    const touchedRooms = new Set();
    let removed = 0;
    for (const { docName, handle, id } of files) {
      const bytes = await this.#sizeAndUnlink(this.pathOf(handle, id));
      if (bytes === null) continue;
      removed += 1;
      const room = this.#roomUploadUsage.get(docName);
      this.#admission.removeFileUsage(room, bytes);
      if (room) touchedRooms.add(docName);
    }
    for (const docName of touchedRooms) await this.#admission.persistRoomUsage(docName, this.#roomUploadUsage.get(docName));
    return removed;
  }

  async #sizeAndUnlink(path) {
    try {
      const { size } = await this.#io.stat(path);
      await this.#io.unlink(path);
      return size;
    } catch (error) {
      if (error.code === NOT_FOUND) return null;
      throw error;
    }
  }

  /**
   * Startup sweep: removes blob files that no locked room's inventory lists and temp files of blob uploads, when
   * they are older than E2E_ORPHAN_MIN_AGE_MS. `inventoried` is a Set of `<handle>.<id>`; files of
   * `protectedHandles` (rooms whose inventory could not be read) are never touched. Usage is not touched here: the
   * caller reconciles it from the directory afterwards. Returns the number of files removed.
   */
  async deleteOrphans(inventoried, now, protectedHandles = new Set()) {
    let removed = 0;
    for (const entry of await this.#io.readdir(this.#uploadsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !this.#isOrphanCandidate(entry.name, inventoried, protectedHandles)) continue;
      const path = join(this.#uploadsDir, entry.name);
      const { mtimeMs } = await this.#io.stat(path);
      if (now - mtimeMs <= E2E_ORPHAN_MIN_AGE_MS) continue;
      await this.#unlinkQuietly(path);
      removed += 1;
    }
    this.#logger.log(ORPHAN_LOG, { removed });
    return removed;
  }

  #isOrphanCandidate(name, inventoried, protectedHandles) {
    if (BLOB_TEMP_RE.test(name)) return true;
    const parsed = parseE2EBlobFilename(name);
    return parsed !== null && !protectedHandles.has(parsed.handle) && !inventoried.has(inventoryKey(parsed.handle, parsed.id));
  }
}
