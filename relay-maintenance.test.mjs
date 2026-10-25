import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { RelayMaintenance, MAINTENANCE_STORAGE_FAILURE_EVENT, sweepRetainedUploads, sweepInterruptedUploads } from './src/server/relay-maintenance.js';
import { MILLISECONDS_PER_DAY } from './src/server/relay-config.js';

const AT_TIME_MS = MILLISECONDS_PER_DAY * 2;
const EXPIRED_TIME_MS = 0;
const TTL_MS = 10;
const REQUEST_TIMEOUT_MS = 20;
const QUIET_LOGGER = { error() {}, log() {} };
const UPLOADS_DIR = '/virtual/uploads';
const OLD_IMAGE_NAME = 'ab.png';
const FRESH_IMAGE_NAME = 'cd.png';
const OLD_TEMP_NAME = '.upload-ab.tmp';
const FRESH_TEMP_NAME = '.upload-cd.tmp';
const UNRELATED_FILE_NAME = 'unrelated.txt';
const COMPACTION_STEP_LABEL = 'compact';
const BAD_VOTE_STEP_LABEL = 'vote:bad';
const HEALTHY_VOTE_STEP_LABEL = 'vote:healthy';
const DISK_STEP_LABEL = 'disk';
const TEMP_SWEEP_STEP_LABEL = 'temps';
const RECONCILE_STEP_LABEL = 'reconcile';
const FLUSH_STEP_LABEL = 'flush';
const STORAGE_FAILURE_CODE = 'STORAGE_FAILURE';

function maintenanceFixture(options = {}) {
  const trace = [];
  const failures = [];
  const expired = () => new Map([['expired', { lastSeen: EXPIRED_TIME_MS }]]);
  const uploadBuckets = expired();
  const rate = expired();
  const image = expired();
  const blockedRooms = new Map([['expired', EXPIRED_TIME_MS]]);
  const context = {
    log: QUIET_LOGGER,
    uploadBuckets, rateBuckets: { rate }, imageReadIpBuckets: image, imageReadRoomBuckets: new Map(),
    BUCKET_TTL_MS: TTL_MS, ROOM_COMPACT_AFTER_BYTES: 1, ROOM_COMPACT_AFTER_UPDATES: 1,
    roomPersistenceChurn: new Map([[COMPACTION_STEP_LABEL, { uncompactedBytes: 1 }]]),
    scheduleRoomCompaction() { trace.push(COMPACTION_STEP_LABEL); },
    docs: new Map([['bad', {}], ['healthy', {}]]),
    finalizeExpiredVotes(name) {
      trace.push(`vote:${name}`);
      assert.equal(uploadBuckets.size + rate.size + image.size, 0);
      if (name === 'bad') throw new Error('bad vote');
      assert.equal(blockedRooms.size, 1);
    },
    blockedRooms, DB_DIR: 'db', UPLOADS_DIR: 'uploads', dbUsageBytes: 0, MAX_DB_BYTES: 1,
    directorySizeSync() {
      trace.push(DISK_STEP_LABEL);
      assert.equal(blockedRooms.size, 0);
      if (options.diskError) throw options.diskError;
      return options.diskBytes || 0;
    },
    UPLOAD_RETENTION_DAYS: 0, REQUEST_TIMEOUT_MS,
    uploadState: { active: options.active || 0 },
    fs: { promises: options.io || { async readdir() { trace.push(TEMP_SWEEP_STEP_LABEL); return []; } } },
    async reconcileUploadUsage() { trace.push(RECONCILE_STEP_LABEL); if (options.hold) await options.hold; },
    rejectionCounters: { flush() { trace.push(FLUSH_STEP_LABEL); } },
  };
  const runner = new RelayMaintenance();
  runner.on(MAINTENANCE_STORAGE_FAILURE_EVENT, (error) => failures.push(error));
  const maintenance = {
    run: () => runner.run({ ...context,
      config: context,
      io: context.fs.promises,
      storage: { measureDatabase: context.directorySizeSync, reconcileUploadUsage: context.reconcileUploadUsage },
      compaction: { schedule: context.scheduleRoomCompaction },
      votes: { finalize: context.finalizeExpiredVotes },
    }),
    get running() { return runner.running; },
  };
  return { maintenance, trace, failures };
}

test('maintenance preserves order and isolates a vote failure before storage and upload work', async () => {
  const { maintenance, trace } = maintenanceFixture();
  await maintenance.run();
  assert.deepEqual(trace, [COMPACTION_STEP_LABEL, BAD_VOTE_STEP_LABEL, HEALTHY_VOTE_STEP_LABEL, DISK_STEP_LABEL, TEMP_SWEEP_STEP_LABEL, RECONCILE_STEP_LABEL, FLUSH_STEP_LABEL]);
  assert.equal(maintenance.running, false);
});

test('maintenance is non-overlapping and flushes counters only for the active run', async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const { maintenance, trace } = maintenanceFixture({ hold });
  const running = maintenance.run();
  assert.equal(maintenance.running, true);
  const overlapping = maintenance.run();
  assert.equal(trace.filter((operation) => operation === DISK_STEP_LABEL).length, 1);
  assert.equal(trace.includes(FLUSH_STEP_LABEL), false);
  release();
  await Promise.all([running, overlapping]);
  assert.equal(trace.filter((operation) => operation === FLUSH_STEP_LABEL).length, 1);
  assert.equal(maintenance.running, false);
});

test('maintenance outer storage error stops later work and finally flushes counters', async () => {
  const diskError = Object.assign(new Error('storage error'), { code: STORAGE_FAILURE_CODE });
  const { maintenance, trace, failures } = maintenanceFixture({ diskError });
  await maintenance.run();
  assert.deepEqual(trace, [COMPACTION_STEP_LABEL, BAD_VOTE_STEP_LABEL, HEALTHY_VOTE_STEP_LABEL, DISK_STEP_LABEL, FLUSH_STEP_LABEL]);
  assert.deepEqual(failures, [diskError]);
  assert.equal(maintenance.running, false);
});

test('maintenance ordinary errors do not latch storage and active uploads skip reconciliation', async () => {
  const failed = maintenanceFixture({ diskError: new Error('ordinary failure') });
  await failed.maintenance.run();
  assert.deepEqual(failed.failures, []);
  assert.equal(failed.trace.at(-1), FLUSH_STEP_LABEL);
  const active = maintenanceFixture({ active: 1 });
  await active.maintenance.run();
  assert.equal(active.trace.includes(RECONCILE_STEP_LABEL), false);
  assert.equal(active.trace.at(-1), FLUSH_STEP_LABEL);
});

test('maintenance disk quota latches storage but continues upload maintenance', async () => {
  const { maintenance, trace, failures } = maintenanceFixture({ diskBytes: 2 });
  await maintenance.run();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, 'configured database quota exceeded');
  assert.deepEqual(trace.slice(-3), [TEMP_SWEEP_STEP_LABEL, RECONCILE_STEP_LABEL, FLUSH_STEP_LABEL]);
});

function sweepFixture(cutoff, oldName, freshName) {
  const inspected = [];
  const removed = [];
  const io = {
    async readdir() {
      return [oldName, freshName, UNRELATED_FILE_NAME].map((name) => ({ name, isFile: () => true }))
        .concat({ name: oldName, isFile: () => false });
    },
    async stat(path) { inspected.push(path); return { mtimeMs: path.endsWith(oldName) ? cutoff - 1 : cutoff }; },
    async unlink(path) { removed.push(path); },
  };
  return { io, inspected, removed };
}

test('maintenance retention deletes only stored images strictly older than the cutoff', async () => {
  const cutoff = AT_TIME_MS - MILLISECONDS_PER_DAY;
  const { io, inspected, removed } = sweepFixture(cutoff, OLD_IMAGE_NAME, FRESH_IMAGE_NAME);
  await sweepRetainedUploads(io, { UPLOADS_DIR, UPLOAD_RETENTION_DAYS: 1 }, AT_TIME_MS, QUIET_LOGGER);
  assert.deepEqual(inspected, [`${UPLOADS_DIR}/${OLD_IMAGE_NAME}`, `${UPLOADS_DIR}/${FRESH_IMAGE_NAME}`]);
  assert.deepEqual(removed, [`${UPLOADS_DIR}/${OLD_IMAGE_NAME}`]);
});

test('maintenance interrupted sweep touches only private temp files older than twice the deadline', async () => {
  const cutoff = AT_TIME_MS - REQUEST_TIMEOUT_MS * 2;
  const { io, inspected, removed } = sweepFixture(cutoff, OLD_TEMP_NAME, FRESH_TEMP_NAME);
  await sweepInterruptedUploads(io, { UPLOADS_DIR, REQUEST_TIMEOUT_MS }, AT_TIME_MS);
  assert.deepEqual(inspected, [`${UPLOADS_DIR}/${OLD_TEMP_NAME}`, `${UPLOADS_DIR}/${FRESH_TEMP_NAME}`]);
  assert.deepEqual(removed, [`${UPLOADS_DIR}/${OLD_TEMP_NAME}`]);
});

test('maintenance upload sweep failures skip reconciliation and always flush counters', async () => {
  const error = new Error('upload scan failed');
  const { maintenance, trace, failures } = maintenanceFixture({ io: { async readdir() { throw error; } } });
  await maintenance.run();
  assert.deepEqual(trace, [COMPACTION_STEP_LABEL, BAD_VOTE_STEP_LABEL, HEALTHY_VOTE_STEP_LABEL, DISK_STEP_LABEL, FLUSH_STEP_LABEL]);
  assert.deepEqual(failures, []);
  assert.equal(maintenance.running, false);
});

test('public maintenance prunes once before handing the encoded-history owner the document', async () => {
  const doc = new Y.Doc();
  for (let index = 0; index < 1501; index++) {
    doc.getMap('items').set(String(index), new Y.Map([['createdAt', index]]));
  }
  const origins = [];
  doc.on('afterTransaction', transaction => origins.push(transaction.origin));
  let snapshotCount = 0;
  const runner = new RelayMaintenance();
  const context = {
    config: { BUCKET_TTL_MS: 1, ROOM_COMPACT_AFTER_BYTES: 1, ROOM_COMPACT_AFTER_UPDATES: 1,
      MAX_DB_BYTES: 1, UPLOAD_RETENTION_DAYS: 0, REQUEST_TIMEOUT_MS: 1, UPLOADS_DIR: '/virtual' },
    log: QUIET_LOGGER, uploadBuckets: new Map(), rateBuckets: {}, imageReadIpBuckets: new Map(),
    imageReadRoomBuckets: new Map(), roomPersistenceChurn: new Map(), docs: new Map([['public', doc]]),
    blockedRooms: new Map(), uploadState: { active: 0 }, rejectionCounters: { flush() {} },
    compaction: { schedule() {} }, votes: { finalize() {} },
    storage: { measureDatabase: () => 0, async reconcileUploadUsage() {} },
    io: { async readdir() { return []; } },
    publicWall: { docName: 'public', history: { async maintain(current) {
      assert.equal(current, doc);
      assert.equal(current.getMap('items').size, 1500);
      snapshotCount++;
    } } },
  };
  try {
    await runner.run(context);
    assert.equal(snapshotCount, 1);
    assert.deepEqual(origins, ['public-prune']);
  } finally { doc.destroy(); }
});
