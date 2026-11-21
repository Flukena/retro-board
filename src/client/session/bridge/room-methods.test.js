import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage } from '../../../test-support/bridge-harness.js';

test('sync subscription ignores false, unsubscribes, and schedules already-synced callbacks', async () => {
  await withStorage(async (browser) => {
    let calls = 0;
    const provider = browser.__rbProvider;
    const stop = browser.storage.onSynced(() => { calls += 1; });
    provider.emit('sync', [false]);
    assert.equal(calls, 0);
    provider.emit('sync', [true]);
    assert.equal(calls, 1);
    stop();
    provider.emit('sync', [true]);
    assert.equal(calls, 1);
    provider.synced = true;
    const cancel = browser.storage.onSynced(() => { calls += 1; });
    assert.equal(calls, 1);
    cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    assert.equal(browser.storage.synced(), true);
  });
});
