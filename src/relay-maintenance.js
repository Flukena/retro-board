import fs from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { MILLISECONDS_PER_DAY } from './relay-config.js';
import { isStoredImageFilename } from './relay-uploads.js';
import { roomLogId } from './relay-log-id.js';
import { maintainRoomVotes } from './relay-vote-maintenance.js';

export const MAINTENANCE_STORAGE_FAILURE_EVENT = 'storageFailure';
const STORAGE_FAILURE_CODE = 'STORAGE_FAILURE';
const DATABASE_QUOTA_MESSAGE = 'configured database quota exceeded';
const VOTE_FAILURE_LOG = '[yjs] vote finalization failed';
const MAINTENANCE_FAILURE_LOG = '[yjs] maintenance failed';
const RETENTION_LOG = '[yjs] upload retention sweep';
const PRIVATE_UPLOAD_TEMP_PATTERN = /^\.upload-[a-f0-9-]+\.tmp$/;
const TEMP_DEADLINE_MULTIPLIER = 2;

export function pruneBuckets(buckets, now, ttlMs) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastSeen > ttlMs) buckets.delete(key);
  }
}

function pruneTraffic(context, now) {
  pruneBuckets(context.uploadBuckets, now, context.config.BUCKET_TTL_MS);
  for (const buckets of Object.values(context.rateBuckets)) pruneBuckets(buckets, now, context.config.BUCKET_TTL_MS);
  for (const buckets of [context.imageReadIpBuckets, context.imageReadRoomBuckets]) {
    pruneBuckets(buckets, now, context.config.BUCKET_TTL_MS);
  }
}

function scheduleCompactions(context) {
  const { ROOM_COMPACT_AFTER_BYTES, ROOM_COMPACT_AFTER_UPDATES } = context.config;
  for (const [docName, churn] of context.roomPersistenceChurn) {
    if (!churn.compactionPromise
        && (churn.uncompactedBytes >= ROOM_COMPACT_AFTER_BYTES || churn.uncompactedUpdates >= ROOM_COMPACT_AFTER_UPDATES)) {
      context.compaction.schedule(docName, { remeasure: true });
    }
  }
}

function maintainVotes(context, now) {
  maintainRoomVotes(context.docs, (name, doc, atTime) => context.votes.finalize(name, doc, atTime), now, (name, error) => {
    context.log.error(VOTE_FAILURE_LOG, { docName: roomLogId(name), errorId: roomLogId(String(error)) });
  });
}

function expireBlockedRooms(blockedRooms, now) {
  for (const [name, expiresAt] of blockedRooms) {
    if (expiresAt <= now) blockedRooms.delete(name);
  }
}

export async function sweepRetainedUploads(io, config, now, log) {
  const cutoff = now - config.UPLOAD_RETENTION_DAYS * MILLISECONDS_PER_DAY;
  let removed = 0;
  const entries = await io.readdir(config.UPLOADS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !isStoredImageFilename(entry.name)) continue;
    const path = join(config.UPLOADS_DIR, entry.name);
    const stat = await io.stat(path);
    if (stat.mtimeMs >= cutoff) continue;
    await io.unlink(path);
    removed += 1;
  }
  if (removed) log.log(RETENTION_LOG, { removed });
}

export async function sweepInterruptedUploads(io, config, now) {
  const cutoff = now - config.REQUEST_TIMEOUT_MS * TEMP_DEADLINE_MULTIPLIER;
  const entries = await io.readdir(config.UPLOADS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !PRIVATE_UPLOAD_TEMP_PATTERN.test(entry.name)) continue;
    const path = join(config.UPLOADS_DIR, entry.name);
    const stat = await io.stat(path);
    if (stat.mtimeMs < cutoff) await io.unlink(path);
  }
}

/**
 * Each run receives peer ports, never a stored server callback:
 * storage.measureDatabase(): bytes, storage.reconcileUploadUsage(): Promise<void>,
 * compaction.schedule(name, options), votes.finalize(name, doc, atTime).
 * The coordinator handles storageFailure events using its existing fatal latch.
 */
export class RelayMaintenance extends EventEmitter {
  running = false;

  async run(context) {
    if (this.running) return;
    this.running = true;
    const { config, storage, log = console, io = fs.promises } = context;
    try {
      const now = Date.now();
      pruneTraffic(context, now);
      scheduleCompactions(context);
      maintainVotes({ ...context, log }, now);
      expireBlockedRooms(context.blockedRooms, now);
      if (storage.measureDatabase() > config.MAX_DB_BYTES) {
        this.emit(MAINTENANCE_STORAGE_FAILURE_EVENT, new Error(DATABASE_QUOTA_MESSAGE));
      }
      // Retention stays opt-in; private interrupted files use twice the deadline.
      if (config.UPLOAD_RETENTION_DAYS > 0) await sweepRetainedUploads(io, config, now, log);
      await sweepInterruptedUploads(io, config, now);
      if (context.uploadState.active === 0) await storage.reconcileUploadUsage();
    } catch (error) {
      if (error?.code === STORAGE_FAILURE_CODE) this.emit(MAINTENANCE_STORAGE_FAILURE_EVENT, error);
      log.error(MAINTENANCE_FAILURE_LOG, { err: error.message });
    } finally {
      context.rejectionCounters.flush();
      this.running = false;
    }
  }
}
