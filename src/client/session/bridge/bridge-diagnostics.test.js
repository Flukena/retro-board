import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage, ROOM_HANDLE, VALID_ITEM } from '../../../test-support/bridge-harness.js';

test('development diagnostics read live item counts, public metadata and only this client scope', async () => {
  await withStorage((browser) => {
    browser.storage.addItem(VALID_ITEM);
    browser.storage.setMeta({ adminUserId: 'admin', __hidden: true }, { silent: true });
    const kv = browser.__rbYDoc.getMap('kv');
    kv.set(`u|${browser.__rbClientId}|probe`, 'own');
    kv.set('u|other|probe', 'peer');
    const debug = browser.__rbDebug();
    assert.equal(debug.room, ROOM_HANDLE);
    assert.equal(debug.clientId, browser.__rbClientId);
    assert.equal(debug.yItemsCount, 1);
    assert.equal(debug.yMetaAdminUserId, 'admin');
    assert.ok(debug.yMetaAll.every(([key]) => !key.startsWith('__')));
    assert.deepEqual(debug.uScopeKeys, [[`u|${browser.__rbClientId}|probe`, 'own']]);
  });
});
