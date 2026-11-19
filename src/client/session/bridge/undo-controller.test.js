import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createUndoController } from './undo-controller.js';
import { withStorage, VALID_ITEM } from '../../../test-support/bridge-harness.js';

const NEXT_ITEM = { ...VALID_ITEM, id: 'next' };
test('rapid local commands share capture until an explicit stop, and system writes survive undo', async () => {
  await withStorage(async ({ storage }) => {
    assert.equal(storage.undo(), false);
    assert.equal(storage.redo(), false);
    storage.addItem(VALID_ITEM);
    storage.addItem(NEXT_ITEM);
    storage.setMeta({ adminUserId: 'admin' }, { silent: true });
    assert.equal(storage.undo(), true);
    assert.deepEqual((await storage.get('boardState', true)).value.items, []);
    assert.equal(storage.getAdminUserId(), 'admin');
    assert.equal(storage.canUndo(), false);
    assert.equal(storage.canRedo(), true);
    assert.equal(storage.redo(), true);
    storage.stopUndoCapture();
    storage.updateItem(VALID_ITEM.id, { text: 'Changed' });
    storage.undo();
    const items = (await storage.get('boardState', true)).value.items;
    assert.equal(items.length, 2);
    assert.equal(items.find(item => item.id === VALID_ITEM.id).text, VALID_ITEM.text);
  });
});

test('the controller configures the specified 500ms capture window on a bare document', () => {
  const doc = new Y.Doc();
  try {
    const { undoManager, methods } = createUndoController({
      yItems: doc.getMap('items'), yMeta: doc.getMap('meta'), ymap: doc.getMap('kv'),
    });
    assert.equal(undoManager.captureTimeout, 500);
    let notifications = 0;
    const onChange = () => { notifications += 1; };
    methods.onUndoChange(onChange);
    doc.transact(() => doc.getMap('meta').set('allRevealed', true), 'local');
    assert.equal(notifications, 1);
    assert.equal(methods.canUndo(), true);
    methods.offUndoChange(onChange);
    methods.undo();
    assert.equal(notifications, 1);
    assert.equal(methods.canRedo(), true);
  } finally {
    doc.destroy();
  }
});
