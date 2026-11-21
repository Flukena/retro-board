import test from 'node:test';
import assert from 'node:assert/strict';
import { relayEntrypoint } from '../test-support/relay-entrypoint.js';

const RESERVED_BYTES = 123;

test('room accounting reads reservations live and releases them once per release call', async t => {
  let snapshot;
  const state = await relayEntrypoint(t, { modules: {
    './src/server/maintainer-server.js': { startMaintainer: async (_env, read) => { snapshot = read; return null; } },
  } });
  const before = snapshot();
  const release = state.persistence.reserveStore(RESERVED_BYTES);
  assert.equal(snapshot().pendingStoreOps, before.pendingStoreOps + 1);
  assert.equal(snapshot().pendingStoreBytes, before.pendingStoreBytes + RESERVED_BYTES);
  release();
  assert.equal(snapshot().pendingStoreOps, before.pendingStoreOps);
  assert.equal(snapshot().pendingStoreBytes, before.pendingStoreBytes);
  release();
  assert.equal(snapshot().pendingStoreBytes, 0);
});
