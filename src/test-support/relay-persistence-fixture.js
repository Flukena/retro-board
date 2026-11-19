import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { relayEntrypoint } from './relay-entrypoint.js';
import * as config from '../server/relay-config.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
export const DOC_NAME = 'persistence-fixture';
const INITIAL_TIME_MS = 10_000;
const COMPACTION_INTERVAL_MS = 1000;
const REMEASURE_INTERVAL_MS = 100;
const COMPACTION_UPDATE_COUNT = 2;
export const settle = () => new Promise(resolve => globalThis.setImmediate(resolve));
export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

export async function persistenceFixture(t, { store, flush, drain, hydrate, bind = true, limits = {} } = {}) {
  const stores = [];
  const flushes = [];
  class FakeLevelDB {
    async getAllDocNames() { return []; }
    async getMetas() { return new Map(); }
    async getMeta() { return undefined; }
    async getYDoc() { return hydrate ? hydrate() : new Y.Doc(); }
    async clearDocument() {}
    async setMeta() {}
    async storeUpdate(name, update) { stores.push({ name, bytes: update.byteLength }); return store ? store() : stores.length; }
    async flushDocument(name) { flushes.push(name); if (flush) await flush(); }
    async destroy() {}
  }
  const state = await relayEntrypoint(t, { modules: {
    module: { createRequire: () => name => name === 'y-leveldb'
      ? { ...require(name), LeveldbPersistence: FakeLevelDB } : require(name) },
    './src/server/relay-config.js': { ...config, readRelayConfig: () => ({ ...config.readRelayConfig(),
      ROOM_COMPACT_AFTER_UPDATES: COMPACTION_UPDATE_COUNT, ROOM_COMPACTION_MIN_INTERVAL_MS: COMPACTION_INTERVAL_MS,
      DOCUMENT_REMEASURE_MIN_INTERVAL_MS: REMEASURE_INTERVAL_MS, ...limits,
    }) },
    ...(drain ? { './src/server/relay-lifecycle.js': { drainRelay: drain } } : {}),
  } });
  let nowMs = INITIAL_TIME_MS;
  t.mock.method(Date, 'now', () => nowMs);
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', function (callback, delayMs) {
    assert.ok(this === undefined || this === globalThis, 'native timer receiver');
    const timer = { callback, delayMs, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', function (timer) {
    assert.ok(this === undefined || this === globalThis, 'native clear receiver');
    if (timer) timer.cleared = true;
  });
  const doc = new Y.Doc();
  doc.conns = new Map();
  if (bind) await state.runtimePersistence.bindState(DOC_NAME, doc);
  t.after(() => doc.destroy());
  // Model the runtime's resident-document map via the already injected maintenance context.
  state.timers.find(timer => timer.intervalMs === config.MAINTENANCE_INTERVAL_MS).callback();
  state.maintenance.docs.set(DOC_NAME, doc);
  t.after(() => state.maintenance.docs.delete(DOC_NAME));
  return { state, doc, stores, flushes, timers, advance: elapsedMs => { nowMs += elapsedMs; } };
}

