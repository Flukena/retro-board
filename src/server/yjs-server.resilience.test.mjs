import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { relayEntrypoint } from '../test-support/relay-entrypoint.js';
import { RelayMaintenance } from './relay-maintenance.js';
import { REGISTRY_STORAGE_FAILURE_EVENT } from './relay-room-registry.js';
import { MAINTENANCE_INTERVAL_MS } from './relay-config.js';
import { RoomSessions } from './relay-session.js';
import { RelayWsTraffic } from './relay-ws-traffic.js';
import { createRejectionCounters } from './relay-rejection-counters.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const QUIET_LOGGER = { error() {}, warn() {}, log() {} };
const ROOM_NAME = 'private-room';
const AT_TIME_MS = 100;
const readiness = state => {
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; }, once() {} };
  state.dispatch({ method: 'GET', url: '/readyz', headers: {} }, response);
  return response;
};

test('storage latch requests one fatal drain and retains the first failure', async t => {
  const identified = [];
  const state = await relayEntrypoint(t, { modules: {
    './src/server/relay-log-id.js': { roomLogId: value => { identified.push(value); return 'keyed-id'; } },
  } });
  const diagnostics = t.mock.method(console, 'error', () => {});
  const first = new Error('first storage failure');
  const second = new Error('second storage failure');
  state.registry.emit(REGISTRY_STORAGE_FAILURE_EVENT, first);
  state.registry.emit(REGISTRY_STORAGE_FAILURE_EVENT, second);
  assert.deepEqual(state.shutdowns, [['storage failure', true]]);
  assert.deepEqual(identified, [String(first)]);
  assert.equal(diagnostics.mock.callCount(), 1);
  assert.equal(readiness(state).status, 503);
});

test('readiness rejects requests during drain', async t => {
  const state = await relayEntrypoint(t);
  assert.equal(readiness(state).status, 200);
  state.lifecycle.onStart('SIGTERM');
  const response = readiness(state);
  assert.equal(response.status, 503);
  assert.equal(response.body, 'not ready');
});

test('rooms without expired vote timers do not flatten item text', async t => {
  const state = await relayEntrypoint(t);
  state.timers.find(timer => timer.intervalMs === MAINTENANCE_INTERVAL_MS).callback();
  assert.ok(state.maintenance, 'entrypoint must wire scheduled maintenance');
  const doc = new Y.Doc();
  try {
    const item = new Y.Map();
    doc.getMap('items').set('sticky', item);
    item.set('type', 'sticky');
    const text = new Y.Text('large private item');
    item.set('text', text);
    text.toString = () => { assert.fail('text flattened with no expired timer'); };
    state.maintenance.votes.finalize(ROOM_NAME, doc, AT_TIME_MS);
  } finally { doc.destroy(); }
});

test('one bad room does not skip later rooms or storage and upload maintenance', async () => {
  const finalized = [];
  let scans = 0;
  let reconciles = 0;
  let blobSweeps = 0;
  await new RelayMaintenance().run({
    log: QUIET_LOGGER,
    docs: new Map([['bad', {}], ['healthy', {}]]), uploadBuckets: new Map(), rateBuckets: {},
    imageReadIpBuckets: new Map(), imageReadRoomBuckets: new Map(), roomPersistenceChurn: new Map(),
    blockedRooms: new Map(), config: { MAX_DB_BYTES: Infinity, UPLOAD_RETENTION_DAYS: 0, REQUEST_TIMEOUT_MS: AT_TIME_MS },
    uploadState: { active: 0 }, io: { readdir: async () => [] },
    storage: {
      measureDatabase: () => { scans += 1; return 0; },
      reconcileUploadUsage: async () => { reconciles += 1; },
    },
    votes: { finalize: (name) => {
      if (name === 'bad') { throw new Error('bad room'); }
      finalized.push(name);
    } },
    rejectionCounters: { flush() {} },
    e2eBlobs: { sweepExpired: async () => { blobSweeps += 1; } },
  });
  assert.deepEqual(finalized, ['healthy']);
  assert.equal(scans, 1);
  assert.equal(reconciles, 1);
  assert.equal(blobSweeps, 1);
});

test('upgrade rejections count status without exposing socket data', async t => {
  const counts = [];
  t.mock.method(RoomSessions.prototype, 'authenticate', () => ({ docName: 'doc' }));
  t.mock.method(RelayWsTraffic.prototype, 'reserve', () => ({ status: 429 }));
  const state = await relayEntrypoint(t, { modules: {
    './src/server/relay-rejection-counters.js': { createRejectionCounters: log => ({
      ...createRejectionCounters(log), upgrade: (...args) => counts.push(args),
    }) },
  } });
  const socket = { end() {}, destroy() {}, privateData: 'must not reach counters' };
  state.server.emit('upgrade', { headers: { origin: 'https://hostile.example' } }, socket, Buffer.alloc(0));
  const handle = 'a'.repeat(32);
  state.registry.registeredRoomsByHandle.set(handle, 'doc');
  state.server.emit('upgrade', { url: `/rooms/${handle}`, headers: { origin: 'https://allowed.example' } }, socket, Buffer.alloc(0));
  assert.deepEqual(counts, [[403], [429]]);
});

test('fatal process events are wired to the shared lifecycle', async t => {
  const state = await relayEntrypoint(t);
  for (const event of ['unhandledRejection', 'uncaughtException']) {
    const handlers = state.handlers.get(event);
    assert.equal(handlers.length, 1, `missing ${event} handler`);
    const failure = new Error('private token must not be logged');
    handlers[0](failure);
    assert.deepEqual(state.fatals.at(-1), [event, failure]);
  }
  assert.equal(state.fatals.length, 2);
});
