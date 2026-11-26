import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage, VALID_ITEM } from '../../../test-support/bridge-harness.js';

const OWNER = { userId: 'alice', name: 'Alice' };
const EDITOR = { userId: 'bo', name: 'Bo' };

test('sticky edits keep the author and undo or redo attribution with the changed text', async () => {
  await withStorage(async ({ storage }) => {
    const card = { ...VALID_ITEM, authorId: OWNER.userId };
    const readCard = async () => (await storage.get('boardState', true)).value.items[0];
    assert.equal(storage.addItem(card), true);
    storage.stopUndoCapture();
    assert.equal(storage.updateItem(card.id, { text: 'Changed' }, { editor: EDITOR }), true);
    assert.equal(storage.updateItem(card.id, { text: 'Changed further' }, { editor: EDITOR }), true);
    storage.stopUndoCapture();
    const changed = await readCard();
    assert.equal(changed.authorId, OWNER.userId);
    assert.equal(changed.authorName, OWNER.name);
    assert.equal(changed.text, 'Changed further');
    assert.deepEqual(changed.lastEditor, EDITOR);
    assert.equal(storage.undo(), true);
    const restored = await readCard();
    assert.equal(restored.text, card.text);
    assert.equal(Object.hasOwn(restored, 'lastEditor'), false);
    assert.equal(storage.redo(), true);
    assert.deepEqual(await readCard(), changed);
    assert.equal(storage.updateItem(card.id, { x: 100, text: changed.text }, { editor: OWNER }), true);
    assert.deepEqual((await readCard()).lastEditor, EDITOR);
    storage.stopUndoCapture();
    assert.equal(storage.updateItem(card.id, { text: card.text }, { editor: OWNER }), true);
    assert.equal(Object.hasOwn(await readCard(), 'lastEditor'), false);
    assert.equal(storage.undo(), true);
    const restoredPeerEdit = await readCard();
    assert.equal(restoredPeerEdit.text, changed.text);
    assert.deepEqual(restoredPeerEdit.lastEditor, EDITOR);
    assert.equal(storage.redo(), true);
    assert.equal(Object.hasOwn(await readCard(), 'lastEditor'), false);
  });
});

test('granular methods reject type changes and retain silent metadata through undo', async () => {
  await withStorage(async ({ storage }) => {
    assert.equal(storage.addItems([VALID_ITEM]), true);
    assert.equal(storage.updateItems([{ id: VALID_ITEM.id, patch: { type: 'zone' } }]), false);
    assert.equal(storage.setMeta({ adminName: 'Alice', __internal: 'hidden' }, { silent: true }), true);
    assert.equal(storage.undo(), true);
    const board = (await storage.get('boardState', true)).value;
    assert.deepEqual(board.items, []);
    assert.equal(board.adminName, 'Alice');
    assert.equal(board.__internal, undefined);
  });
});
