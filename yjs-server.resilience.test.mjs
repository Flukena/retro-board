import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { planVoteFinalization } from './src/vote-finalization.js';
import { geometryErrorForPatch } from './src/board-geometry.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const source = await readFile(process.env.RB_TEST_SOURCE || new URL('./yjs-server.mjs', import.meta.url), 'utf8');
const imported = {};
for (const match of source.matchAll(/^import \{[^}]+\} from '(\.\/src\/relay-[^']+)';/gm)) {
  Object.assign(imported, await import(match[1]));
}
const section = (start, end) => {
  const startAt = source.indexOf(start);
  assert.ok(startAt >= 0, `missing server seam: ${start}`);
  return source.slice(startAt, source.indexOf(end, startAt));
};
const evaluate = (code, context) => runInNewContext(code, { ...imported, ...context });
const QUIET_LOGGER = { error() {}, warn() {}, log() {} };
const ROOM_NAME = 'private-room';
const AT_TIME_MS = 100;

test('storage latch requests one fatal drain and retains the first failure', () => {
  const requests = [];
  const callbacks = [];
  const first = new Error('first storage failure');
  const second = new Error('second storage failure');
  const result = evaluate(`${section('const markStorageFailure =', '\nconst reconcileUploadUsage')}\n
    markStorageFailure(first); markStorageFailure(second);
    callbacks.forEach((callback) => callback()); storageFailure;`, {
    storageFailure: null, docs: new Map(), console: QUIET_LOGGER,
    first, second, callbacks, roomLogId: () => 'keyed-id',
    setImmediate: (callback) => callbacks.push(callback),
    shutdown: (...args) => requests.push(args),
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1], true);
  assert.equal(result, first);
});

test('readiness rejects requests during drain', () => {
  let status;
  let body;
  evaluate(`(() => { ${section("if (req.method === 'GET' && routePath === '/readyz')", "\n  if (req.method === 'OPTIONS'")} })()`, {
    req: { method: 'GET' }, routePath: '/readyz', storageFailure: null, shuttingDown: true,
    res: { writeHead: (value) => { status = value; }, end: (value) => { body = value; } },
  });
  assert.equal(status, 503);
  assert.equal(body, 'not ready');
});

test('rooms without expired vote timers do not flatten item text', () => {
  const doc = new Y.Doc();
  try {
    const item = new Y.Map();
    doc.getMap('items').set('sticky', item);
    item.set('type', 'sticky');
    const text = new Y.Text('large private item');
    item.set('text', text);
    text.toString = () => { assert.fail('text flattened with no expired timer'); };
    evaluate(`${section('const finalizeExpiredVotes =', '\nconst voteExpiryTimers')}\nfinalizeExpiredVotes(room, doc, atTime);`, {
      Y, doc, room: ROOM_NAME, atTime: AT_TIME_MS, storageFailure: null, shuttingDown: false,
      isRoomBlocked: () => false, planVoteFinalization, geometryErrorForPatch,
      console: QUIET_LOGGER, roomLogId: () => 'keyed-id',
    });
  } finally { doc.destroy(); }
});

test('one bad room does not skip later rooms or storage and upload maintenance', async () => {
  const finalized = [];
  let scans = 0;
  let reconciles = 0;
  await evaluate(`${section('let maintenanceRunning =', '\nconst maintenanceTimer')}\nrunMaintenance();`, {
    console: QUIET_LOGGER, roomLogId: () => 'keyed-id',
    docs: new Map([['bad', {}], ['healthy', {}]]), uploadBuckets: new Map(), rateBuckets: {},
    imageReadIpBuckets: new Map(), imageReadRoomBuckets: new Map(), roomPersistenceChurn: new Map(),
    blockedRooms: new Map(), DB_DIR: 'unused', UPLOADS_DIR: 'unused', dbUsageBytes: 0,
    MAX_DB_BYTES: Infinity, UPLOAD_RETENTION_DAYS: 0, REQUEST_TIMEOUT_MS: AT_TIME_MS,
    activeUploads: 0, fs: { promises: { readdir: async () => [] } },
    directorySizeSync: () => { scans += 1; return 0; },
    reconcileUploadUsage: async () => { reconciles += 1; },
    finalizeExpiredVotes: (name) => {
      if (name === 'bad') { throw new Error('bad room'); }
      finalized.push(name);
    },
    rejectionCounters: { flush() {} },
  });
  assert.deepEqual(finalized, ['healthy']);
  assert.equal(scans, 1);
  assert.equal(reconciles, 1);
});

test('upgrade rejections count status without exposing socket data', () => {
  const counts = [];
  evaluate(`${section('const rejectUpgrade =', '\nlet maintenanceRunning')}\nrejectUpgrade(socket, status);`, {
    socket: { end() {}, destroy() {} }, status: 429,
    rejectionCounters: { upgrade: (status) => counts.push(status) },
  });
  assert.equal(counts.length, 1);
  assert.equal(counts[0], 429);
});

test('fatal process events are wired to the shared lifecycle', () => {
  const handlers = new Map();
  const requests = [];
  const registrations = source.split('\n').filter((line) => /^process.on\(/.test(line)).join('\n');
  evaluate(registrations, {
    process: { on: (event, callback) => handlers.set(event, callback) },
    lifecycle: { fatal: (...args) => requests.push(args) }, shutdown() {},
  });
  for (const event of ['unhandledRejection', 'uncaughtException']) {
    assert.ok(handlers.has(event), `missing ${event} handler`);
    handlers.get(event)(new Error('private token must not be logged'));
  }
  assert.equal(requests.length, 2);
});
