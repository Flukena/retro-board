import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage, VALID_ITEM } from '../../../test-support/bridge-harness.js';

test('deleting a sticky and its contributions is one undoable command', async () => {
  await withStorage((browser) => {
    const { storage } = browser;
    storage.addItem(VALID_ITEM);
    storage.setVote(VALID_ITEM.id, 'voter', true);
    assert.equal(storage.addComment(VALID_ITEM.id, { id: 'comment', text: 'Keep', createdAt: 1 }), true);
    storage.stopUndoCapture();
    storage.deleteItemWithVotesAndComments(VALID_ITEM.id);
    assert.equal(browser.__rbYItems.has(VALID_ITEM.id), false);
    assert.equal(browser.__rbYDoc.getMap('kv').has(`s||vote:${VALID_ITEM.id}:voter`), false);
    assert.equal(browser.__rbYDoc.getMap('kv').has(`s||comment:${VALID_ITEM.id}:comment`), false);
    assert.equal(storage.snapshotVotes().size, 0);
    assert.equal(storage.snapshotComments().size, 0);
    assert.equal(storage.undo(), true);
    assert.deepEqual([...storage.snapshotVotes().get(VALID_ITEM.id)], ['voter']);
    assert.equal(storage.snapshotComments().get(VALID_ITEM.id)[0].text, 'Keep');
  });
});
