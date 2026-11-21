import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionFixture } from '../test-support/relay-connection-fixture.js';
import * as relayConfig from './relay-config.js';

const { readRelayConfig, STORE_OPERATION_OVERHEAD_BYTES } = relayConfig;

const FRAME = Buffer.from([0]);
const UPDATE_BYTES = 10;
const PENDING_LIMIT_BYTES = 1000;
const DOCUMENT_LIMIT_BYTES = 100;

async function admissionFixture(t, inspection) {
  const parsed = [];
  const fixture = await connectionFixture(t, {
    inspection: () => inspection,
    parse: () => parsed.push('parsed'),
    modules: { './src/server/relay-config.js': { ...relayConfig, readRelayConfig: () => ({
      ...readRelayConfig(), MAX_PENDING_STORE_BYTES: PENDING_LIMIT_BYTES, MAX_DOCUMENT_BYTES: DOCUMENT_LIMIT_BYTES,
    }) } },
  });
  const doc = { conns: new Map() };
  return { ...fixture, ...fixture.connect(doc), parsed };
}

test('sync update preflight reserves overhead before upstream parse and counts backlog', async t => {
  const fixture = await admissionFixture(t, { kind: 'sync-update', updateBytes: UPDATE_BYTES });
  const reservedBytes = PENDING_LIMIT_BYTES - STORE_OPERATION_OVERHEAD_BYTES;
  const release = fixture.persistence.reserveStore(reservedBytes);
  t.after(release);
  const reasons = [];
  const summaries = [];
  t.mock.method(console, 'log', (message, counts) => {
    if (message === '[yjs] rejection summary') summaries.push(counts);
  });
  t.mock.method(console, 'warn', (message, fields) => {
    if (message === '[yjs] protocol-policy close') reasons.push(fields.reason);
  });
  fixture.conn.emit('message', FRAME);
  assert.deepEqual(reasons, ['persistence backlog']);
  assert.deepEqual(fixture.parsed, []);
  assert.deepEqual(fixture.conn.closes, [[1008, 'protocol policy']]);
  fixture.timers[0].callback();
  fixture.relayState.maintenance.rejectionCounters.flush();
  assert.deepEqual(summaries, [{ 'storage-backlog:1008': 1 }]);
});

test('document bound rejects before parse with resource close code', async t => {
  const fixture = await admissionFixture(t, { kind: 'sync-update', updateBytes: DOCUMENT_LIMIT_BYTES + 1 });
  fixture.conn.emit('message', FRAME);
  assert.deepEqual(fixture.parsed, []);
  assert.deepEqual(fixture.conn.closes, [[1009, 'protocol policy']]);
});

test('bounded sync update passes through to exactly one upstream parser', async t => {
  const fixture = await admissionFixture(t, { kind: 'sync-update', updateBytes: UPDATE_BYTES });
  fixture.conn.emit('message', FRAME);
  assert.deepEqual(fixture.parsed, ['parsed']);
  assert.deepEqual(fixture.conn.closes, []);
});
