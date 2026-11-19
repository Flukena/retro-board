import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { withStorage, VALID_ITEM } from '../../../test-support/bridge-harness.js';

const BOARD = { items: [VALID_ITEM] };
const VOTE = { itemId: VALID_ITEM.id, userId: 'voter' };
const COMMENT = { itemId: VALID_ITEM.id, comment: { id: 'comment', userId: 'voter', authorName: 'Alice', text: 'Keep this', createdAt: 1 } };
const rejectionCases = [
  ['missing board', null, [], []],
  ['missing items', {}, [], []],
  ['votes not an array', BOARD, null, []],
  ['comments not an array', BOARD, [], null],
  ['invalid moods', BOARD, [], [], null, [{ score: 8 }]],
  ['invalid templates', BOARD, [], [], {}],
  ['invalid geometry', { items: [{ ...VALID_ITEM, x: Infinity }] }, [], []],
  ['invalid id', { items: [{ ...VALID_ITEM, id: ':' }] }, [], []],
  ['duplicate item', { items: [VALID_ITEM, VALID_ITEM] }, [], []],
  ['invalid type', { items: [{ ...VALID_ITEM, type: 'unknown' }] }, [], []],
  ['missing vote', BOARD, [null], []],
  ['vote for absent sticky', BOARD, [{ ...VOTE, itemId: 'absent' }], []],
  ['invalid voter', BOARD, [{ ...VOTE, userId: ':' }], []],
  ['duplicate vote', BOARD, [VOTE, VOTE], []],
  ['missing comment', BOARD, [], [null]],
  ['comment for absent sticky', BOARD, [], [{ ...COMMENT, itemId: 'absent' }]],
  ['invalid comment', BOARD, [], [{ itemId: VALID_ITEM.id, comment: {} }]],
  ['duplicate comment', BOARD, [], [COMMENT, COMMENT]],
];

test('each import preflight rejection leaves canonical state untouched', async (t) => {
  await withStorage(async (browser) => {
    browser.storage.addItem({ ...VALID_ITEM, id: 'existing' });
    const before = Y.encodeStateAsUpdate(browser.__rbYDoc);
    for (const [label, ...args] of rejectionCases) {
      await t.test(label, () => {
        assert.equal(browser.storage.importBundle(...args), false, label);
        assert.deepEqual(Y.encodeStateAsUpdate(browser.__rbYDoc), before, label);
      });
    }
  });
});

test('valid import replaces votes and comments in the same local transaction', async () => {
  await withStorage(async (browser) => {
    let localUpdates = 0;
    browser.__rbYDoc.on('update', (_update, origin) => { if (origin === 'local') localUpdates += 1; });
    assert.equal(browser.storage.importBundle(BOARD, [VOTE], [COMMENT], null), true);
    assert.equal(localUpdates, 1);
    assert.deepEqual((await browser.storage.get('boardState', true)).value.items.map(item => ({ ...item })), BOARD.items);
    assert.deepEqual([...browser.storage.snapshotVotes().get(VALID_ITEM.id)], ['voter']);
    assert.equal(browser.storage.snapshotComments().get(VALID_ITEM.id)[0].text, COMMENT.comment.text);
  });
});

test('import validates before permits, then permits again inside the one bridge transaction', async () => {
  await withStorage(async (browser, _cache, server) => {
    const { PublicCreationGuard } = await server.ssrLoadModule('/src/client/session/public-creation-guard.js');
    const original = PublicCreationGuard.prototype.check;
    const order = [];
    PublicCreationGuard.prototype.check = function (items) {
      order.push('permit');
      return original.call(this, items);
    };
    browser.__rbYDoc.on('beforeTransaction', transaction => {
      if (transaction.origin === 'local') order.push('transaction');
    });
    try {
      assert.equal(browser.storage.importBundle(BOARD, [VOTE, VOTE], [], null), false);
      assert.deepEqual(order, []);
      assert.equal(browser.storage.importBundle(BOARD, [VOTE], [], null), true);
      assert.deepEqual(order, ['permit', 'transaction', 'permit']);
    } finally {
      PublicCreationGuard.prototype.check = original;
    }
  }, { publicWall: true });
});
