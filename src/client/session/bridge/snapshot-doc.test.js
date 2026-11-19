import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { VALID_ITEM } from '../../../test-support/bridge-harness.js';
import { createSnapshotDoc } from './snapshot-doc.js';
import { createPublicPermit } from './public-permit.js';

async function withSnapshot(check) {
  const doc = new Y.Doc();
  const items = doc.getMap('items');
  const meta = doc.getMap('meta');
  const publicPermit = createPublicPermit({ eventTarget: new EventTarget() });
  const snapshot = createSnapshotDoc({ ydoc: doc, yItems: items, yMeta: meta, publicPermit });
  try {
    await check({ write: snapshot.writeBoardSnapshot, read: snapshot.readRemoteBoardSnapshot, doc, items, meta });
  } finally {
    doc.destroy();
  }
}

test('snapshot diffs preserve text, omit internal metadata, and are idempotent', async () => {
  await withSnapshot(async ({ write, read, doc, items, meta }) => {
    const board = { items: [VALID_ITEM], allRevealed: false };
    assert.equal(write(board, 'local'), true);
    assert.ok(items.get(VALID_ITEM.id).get('text') instanceof Y.Text);
    meta.set('__private', 'internal');
    assert.deepEqual({ ...await read(), items: (await read()).items.map(item => ({ ...item })) }, board);
    const before = Y.encodeStateAsUpdate(doc);
    assert.equal(write(board, 'local'), true);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    assert.equal(write({ items: [{ ...VALID_ITEM, x: Infinity }] }, 'local'), false);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    assert.equal(write({ items: [], allRevealed: null }, 'system'), true);
    assert.equal(items.size, 0);
    assert.equal(meta.has('allRevealed'), false);
    assert.equal(meta.get('__private'), 'internal');
  });
});

test('only local snapshot transactions enter undo tracking', async () => {
  await withSnapshot(async ({ write, doc, items, meta }) => {
    const undo = new Y.UndoManager([items, meta], { trackedOrigins: new Set(['local']) });
    try {
      write({ items: [VALID_ITEM] }, 'system');
      assert.equal(undo.undoStack.length, 0);
      write({ items: [{ ...VALID_ITEM, text: 'Changed' }] }, 'local');
      assert.equal(undo.undoStack.length, 1);
      undo.undo();
      assert.equal(items.get(VALID_ITEM.id).get('text').toString(), VALID_ITEM.text);
    } finally {
      undo.destroy();
    }
    assert.equal(doc.isDestroyed, false);
  });
});

test('sync migrates the legacy blob once, preserving fields and excluding migration from undo', async () => {
  const { withStorage } = await import('../../../test-support/bridge-harness.js');
  await withStorage((browser) => {
    const kv = browser.__rbYDoc.getMap('kv');
    kv.set('s||boardState', { items: [VALID_ITEM], adminUserId: 'admin' });
    browser.__rbProvider.emit('sync', [true]);
    assert.equal(kv.has('s||boardState'), false);
    assert.equal(browser.__rbYMeta.get('__migrated'), true);
    assert.equal(browser.__rbYItems.get(VALID_ITEM.id).get('text').toString(), VALID_ITEM.text);
    assert.equal(browser.storage.getAdminUserId(), 'admin');
    assert.equal(browser.storage.canUndo(), false);
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    browser.__rbProvider.emit('sync', [true]);
    assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before);
  });
});
