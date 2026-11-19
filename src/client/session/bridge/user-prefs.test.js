import test from 'node:test';
import assert from 'node:assert/strict';
import { withStorage, ROOM_HANDLE } from '../../../test-support/bridge-harness.js';

const CACHED_NAME = 'Alice';
const RECOVERED_NAME = 'Bob';
test('identity cache seeds the durable copy and blocked storage recovers without undo', async () => {
  await withStorage(async (browser, cache) => {
    const { storage } = browser;
    const kv = browser.__rbYDoc.getMap('kv');
    const durableKey = `u|${browser.__rbClientId}|userName`;
    const cacheKey = `rb_local_userName__${ROOM_HANDLE}`;
    cache.set(cacheKey, JSON.stringify(CACHED_NAME));
    assert.equal((await storage.get('userName', false)).value, CACHED_NAME);
    assert.equal(kv.get(durableKey), CACHED_NAME);
    assert.equal(storage.canUndo(), false);
    const receivers = [];
    globalThis.localStorage.getItem = function () {
      receivers.push(this);
      assert.equal(this, globalThis.localStorage, 'native storage receiver');
      throw new Error('blocked');
    };
    globalThis.localStorage.setItem = function () {
      receivers.push(this);
      assert.equal(this, globalThis.localStorage, 'native storage receiver');
      throw new Error('blocked');
    };
    await storage.set('userName', RECOVERED_NAME, false);
    assert.equal(kv.get(durableKey), RECOVERED_NAME);
    browser.__rbProvider.synced = true;
    assert.equal((await storage.get('userName', false)).value, RECOVERED_NAME);
    assert.ok(receivers.length > 0);
    assert.ok(receivers.every(receiver => receiver === globalThis.localStorage));
    assert.equal(storage.canUndo(), false);
  });
});

test('cache misses share a bounded wait and remove the sync listener on recovery', async () => {
  await withStorage(async (browser) => {
    const provider = browser.__rbProvider;
    const kv = browser.__rbYDoc.getMap('kv');
    const baseline = provider._observers.get('sync')?.size || 0;
    kv.set(`u|${browser.__rbClientId}|userId`, 'returning');
    const first = browser.storage.get('userId', false);
    const second = browser.storage.get('userName', false);
    assert.equal(provider._observers.get('sync').size, baseline + 1);
    provider.emit('sync', [false]);
    assert.equal(provider._observers.get('sync').size, baseline + 1);
    provider.emit('sync', [true]);
    assert.equal((await first).value, 'returning');
    assert.equal((await second).value, null);
    assert.equal(provider._observers.get('sync').size, baseline);
  });
});
