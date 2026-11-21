import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { readFileSync } from 'node:fs';
import { withStorage } from '../../../test-support/bridge-harness.js';

test('shared access keeps local echo suppression, remote dispatch and unsubscribe', async () => {
  await withStorage(async (browser) => {
    const received = [];
    const handler = ({ detail }) => { if (detail.key === 'probe') received.push(detail.value); };
    browser.storage.on(handler);
    await browser.storage.set('probe', 'own', true);
    assert.equal((await browser.storage.get('probe', true)).value, 'own');
    assert.deepEqual(received, []);
    browser.__rbYDoc.transact(() => browser.__rbYDoc.getMap('kv').set('s||probe', 'system'), 'system');
    assert.deepEqual(received, []);
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(browser.__rbYDoc));
      peer.getMap('kv').set('s||probe', 'peer');
      Y.applyUpdate(browser.__rbYDoc, Y.encodeStateAsUpdate(peer), peer);
      assert.deepEqual(received, ['peer']);
      browser.storage.off(handler);
      peer.getMap('kv').set('s||probe', 'after unsubscribe');
      Y.applyUpdate(browser.__rbYDoc, Y.encodeStateAsUpdate(peer), peer);
      assert.deepEqual(received, ['peer']);
      assert.equal((await browser.storage.get('absent', true)).value, null);
    } finally {
      peer.destroy();
    }
  });
});

// Captured at the recorded pre-composition commit, never generated from the extracted implementation.
const ORIGINAL_KEYS = JSON.parse(readFileSync(new URL('./fixtures/storage-keys.json', import.meta.url), 'utf8')).keys;
for (const [route, options] of [['board', {}], ['public', { publicWall: true }], ['landing', { landing: true }], ['locked', { locked: true }]]) {
  test(`${route} storage keys retain their original insertion order`, async () => {
    await withStorage(browser => assert.deepEqual(Object.keys(browser.storage), ORIGINAL_KEYS[route]), options);
  });
}
