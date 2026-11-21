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

const RECOVERY_SYNC_TIMEOUT_MS = 3000;
test('a dead relay times out once, recovers durable data, and removes its listener', async () => {
  await withStorage(async (browser, cache) => {
    const provider = browser.__rbProvider;
    const baseline = provider._observers.get('sync')?.size || 0;
    browser.__rbYDoc.getMap('kv').set(`u|${browser.__rbClientId}|userId`, 'returning');
    cache.set(`rb_local_userName__${ROOM_HANDLE}`, '{corrupt');
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const timerHandle = {};
    let finish;
    let scheduled = 0;
    let cleared = 0;
    globalThis.setTimeout = (handler, delay, ...args) => {
      if (delay !== RECOVERY_SYNC_TIMEOUT_MS) return Reflect.apply(nativeSetTimeout, globalThis, [handler, delay, ...args]);
      scheduled += 1;
      finish = handler;
      return timerHandle;
    };
    globalThis.clearTimeout = handle => {
      if (handle !== timerHandle) return Reflect.apply(nativeClearTimeout, globalThis, [handle]);
      cleared += 1;
    };
    try {
      const first = browser.storage.get('userId', false);
      const second = browser.storage.get('userName', false);
      assert.equal(scheduled, 1);
      assert.equal(provider._observers.get('sync').size, baseline + 1);
      finish();
      assert.equal((await first).value, 'returning');
      assert.equal((await second).value, null);
      assert.equal(cleared, 1);
      assert.equal(provider._observers.get('sync').size, baseline);
      assert.equal((await browser.storage.get('anotherMissingPreference', false)).value, null);
      assert.equal(scheduled, 1);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    }
  });
});
