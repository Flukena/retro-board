import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage, VALID_ITEM } from '../../../test-support/bridge-harness.js';

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
