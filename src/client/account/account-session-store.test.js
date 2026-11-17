import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNT_STATUS } from './account-api.js';
import { createAccountSessionStore } from './account-session-store.js';
import { mapStorage } from './map-storage.fixture.js';

const SIGNED_IN = Object.freeze({ status: ACCOUNT_STATUS.SIGNED_IN, account: { name: 'Mia', plan: 'free' } });

const fakeFetch = (...results) => {
  const calls = { count: 0 };
  const fetchAccount = async () => {
    calls.count += 1;
    return results[Math.min(calls.count, results.length) - 1];
  };
  return { fetchAccount, calls };
};

test('the snapshot is null until the first load settles', async () => {
  const { fetchAccount } = fakeFetch(SIGNED_IN);
  const store = createAccountSessionStore({ fetchAccount, storage: mapStorage() });
  assert.equal(store.getSnapshot(), null);
  await store.load();
  assert.equal(store.getSnapshot(), SIGNED_IN);
});

test('concurrent loads share one fetch', async () => {
  const { fetchAccount, calls } = fakeFetch(SIGNED_IN);
  const store = createAccountSessionStore({ fetchAccount, storage: mapStorage() });
  const results = await Promise.all([store.load(), store.load(), store.load()]);
  assert.equal(calls.count, 1);
  assert.deepEqual(results, [SIGNED_IN, SIGNED_IN, SIGNED_IN]);
});

test('a settled load is reused; force fetches again', async () => {
  const second = { status: ACCOUNT_STATUS.SIGNED_OUT };
  const { fetchAccount, calls } = fakeFetch(SIGNED_IN, second);
  const store = createAccountSessionStore({ fetchAccount, storage: mapStorage() });
  await store.load();
  await store.load();
  assert.equal(calls.count, 1);
  await store.load({ force: true });
  assert.equal(calls.count, 2);
  assert.equal(store.getSnapshot(), second);
});

test('signed-in stores only the hint value; signed-out and disabled clear it; unavailable keeps it', async () => {
  const map = new Map();
  const statuses = [
    SIGNED_IN,
    { status: ACCOUNT_STATUS.UNAVAILABLE },
    { status: ACCOUNT_STATUS.SIGNED_OUT },
    SIGNED_IN,
    { status: ACCOUNT_STATUS.DISABLED },
  ];
  const { fetchAccount } = fakeFetch(...statuses);
  const store = createAccountSessionStore({ fetchAccount, storage: mapStorage(map) });
  await store.load({ force: true });
  assert.deepEqual([...map.entries()], [['rb_signed_in', '1']]);
  await store.load({ force: true });
  assert.deepEqual([...map.entries()], [['rb_signed_in', '1']]);
  await store.load({ force: true });
  assert.equal(map.size, 0);
  await store.load({ force: true });
  assert.equal(map.size, 1);
  await store.load({ force: true });
  assert.equal(map.size, 0);
});

test('markSignedOut sets SIGNED_OUT, clears the hint and notifies subscribers', async () => {
  const map = new Map();
  const { fetchAccount } = fakeFetch(SIGNED_IN);
  const store = createAccountSessionStore({ fetchAccount, storage: mapStorage(map) });
  await store.load();
  let notified = 0;
  const unsubscribe = store.subscribe(() => { notified += 1; });
  store.markSignedOut();
  assert.deepEqual(store.getSnapshot(), { status: ACCOUNT_STATUS.SIGNED_OUT });
  assert.equal(map.size, 0);
  assert.equal(notified, 1);
  unsubscribe();
  store.markSignedOut();
  assert.equal(notified, 1);
});

test('storage that throws never breaks a load', async () => {
  const fail = () => { throw new Error('storage blocked'); };
  const storage = { getItem: fail, setItem: fail, removeItem: fail };
  const { fetchAccount } = fakeFetch(SIGNED_IN);
  const store = createAccountSessionStore({ fetchAccount, storage });
  assert.equal(await store.load(), SIGNED_IN);
  assert.doesNotThrow(() => store.markSignedOut());
});
