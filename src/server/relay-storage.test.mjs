import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { checkedStorage } from './relay-storage.js';

const Y = createRequire(import.meta.url)('yjs');
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
