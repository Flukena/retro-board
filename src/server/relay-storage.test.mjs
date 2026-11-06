import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedStorage, durableMetaBatch } from './relay-storage.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const { decodeAny } = require('lib0/buffer');
const DOC = 'yjs/board-Example1-abcdefgh12345678';
const STORAGE_FAILURE = { code: 'STORAGE_FAILURE' };

// y-leveldb resolves null instead of rejecting when a transaction fails.
const failingLdb = () => new Proxy({}, { get: () => async () => null });

test('every operation rejects as a storage failure when y-leveldb reports null', async () => {
  const storage = checkedStorage(failingLdb(), Y);
  for (const [name, args] of Object.entries({
    getYDoc: [DOC], storeUpdate: [DOC, new Uint8Array()], clearDocument: [DOC], flushDocument: [DOC],
    getAllDocNames: [], getMeta: [DOC, 'k'], setMeta: [DOC, 'k', 1],
  })) {
    await assert.rejects(storage[name](...args), STORAGE_FAILURE, name);
  }
});

test('successful y-leveldb results pass through, including undefined writes', async () => {
  const doc = new Y.Doc();
  const storage = checkedStorage({
    getYDoc: async () => doc,
    storeUpdate: async () => 7,
    clearDocument: async () => undefined,
    flushDocument: async () => undefined,
    getAllDocNames: async () => [DOC],
    getMeta: async () => undefined,
    setMeta: async () => undefined,
  }, Y);
  assert.equal(await storage.getYDoc(DOC), doc);
  assert.equal(await storage.storeUpdate(DOC, new Uint8Array()), 7);
  await storage.clearDocument(DOC);
  await storage.flushDocument(DOC);
  assert.deepEqual(await storage.getAllDocNames(), [DOC]);
  assert.equal(await storage.getMeta(DOC, 'k'), undefined);
  await storage.setMeta(DOC, 'k', 1);
  doc.destroy();
});

const META_KEY = 'acct:one';
const recordingLdb = (batchResult = undefined) => {
  const calls = [];
  const db = { batch: async (ops, options) => { calls.push({ ops, options }); return batchResult; } };
  return { calls, ldb: { _transact: async (operation) => operation(db) } };
};

test('durableMetaBatch writes with sync true', async () => {
  const { calls, ldb } = recordingLdb();
  await durableMetaBatch(ldb, DOC, [{ type: 'put', key: META_KEY, value: { plan: 'free' } }, { type: 'del', key: 'sub:x' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { sync: true });
  const [put, del] = calls[0].ops;
  assert.deepEqual(put.key, ['v1', DOC, 'meta', META_KEY]);
  assert.deepEqual(decodeAny(put.value), { plan: 'free' });
  assert.deepEqual(del, { type: 'del', key: ['v1', DOC, 'meta', 'sub:x'] });
});

test('null transact result raises STORAGE_FAILURE', async () => {
  const ldb = { _transact: async () => null };
  await assert.rejects(durableMetaBatch(ldb, DOC, [{ type: 'del', key: META_KEY }]), STORAGE_FAILURE);
});

test('durableMetaBatch values read back through y-leveldb getMeta', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-meta-'));
  const db = new LeveldbPersistence(directory);
  t.after(async () => { await db.destroy(); await rm(directory, { recursive: true, force: true }); });
  await db.setMeta(DOC, 'gone', 1);
  await durableMetaBatch(db, DOC, [{ type: 'put', key: META_KEY, value: { n: 1, s: 'x', z: null } }, { type: 'del', key: 'gone' }]);
  assert.deepEqual(await db.getMeta(DOC, META_KEY), { n: 1, s: 'x', z: null });
  assert.equal(await db.getMeta(DOC, 'gone'), undefined);
});
