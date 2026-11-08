import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ACCOUNTS_DOC_NAME, ACCOUNT_STORAGE_FAILURE_EVENT, AccountStore } from './account-store.js';
import { checkedStorage, storageOperationError } from './relay-storage.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const NOW_MS = Date.UTC(2026, 10, 6);
const LATER_MS = NOW_MS + 60_000;
const UNAVAILABLE = { code: 'ACCOUNT_STORE_UNAVAILABLE' };
const STORAGE_FAILURE = { code: 'STORAGE_FAILURE' };
const PROFILE = Object.freeze({ sub: 'google-sub-1', email: 'Ada@Example.com', name: 'Ada' });

const sequentialIds = () => {
  let next = 0;
  const randomId = () => { next += 1; return `id-${next}`; };
  return { randomId, count: () => next };
};

async function openDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), 'account-store-'));
  const handle = { directory, ldb: new LeveldbPersistence(directory) };
  handle.reopen = async () => { await handle.ldb.destroy(); handle.ldb = new LeveldbPersistence(directory); return handle.ldb; };
  t.after(async () => { await handle.ldb.destroy(); await rm(directory, { recursive: true, force: true }); });
  return handle;
}

const storeFor = (ldb, options = {}) => new AccountStore({
  ldb, getMeta: checkedStorage(ldb, Y).getMeta, hasCapacity: () => true, now: () => NOW_MS, ...options,
});

async function openStore(t, options) {
  const database = await openDatabase(t);
  return { ...database, store: storeFor(database.ldb, options) };
}

// Fails only db.batch inside a real y-leveldb transaction, so _transact swallows
// it and resolves null exactly as on a disk error; reads keep working.
function failBatches(ldb) {
  const transact = ldb._transact;
  const failingBatch = async () => { throw new Error('injected batch failure'); };
  const withFailingBatch = (db) => new Proxy(db, {
    get(target, property) {
      if (property === 'batch') return failingBatch;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  ldb._transact = (operation) => transact((db) => operation(withFailingBatch(db)));
}

const accountMetas = async (ldb) => [...(await ldb.getMetas(ACCOUNTS_DOC_NAME)).keys()].sort();

test('upsert creates one free account per sub and is idempotent', async (t) => {
  const ids = sequentialIds();
  const { store } = await openStore(t, { randomId: ids.randomId });
  const created = await store.upsertFromGoogle(PROFILE);
  assert.deepEqual(created, {
    id: 'id-1', googleSub: PROFILE.sub, email: PROFILE.email, name: PROFILE.name,
    plan: 'free', planGrantedAt: null, sessionGeneration: 0, createdAt: NOW_MS,
  });
  assert.deepEqual(await store.upsertFromGoogle(PROFILE), created);
  assert.deepEqual(await store.get('id-1'), created);
  assert.equal(ids.count(), 1);
  const other = await store.upsertFromGoogle({ sub: 'google-sub-2', email: 'grace@example.com' });
  assert.equal(other.id, 'id-2');
  assert.equal(other.name, '');
});

test('default account ids are 16 random bytes in base64url', async (t) => {
  const { store } = await openStore(t);
  const { id } = await store.upsertFromGoogle(PROFILE);
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(id, 'base64url').length, 16);
});

test('concurrent upserts for one sub return the same id', async (t) => {
  const ids = sequentialIds();
  const { store } = await openStore(t, { randomId: ids.randomId });
  const [first, second] = await Promise.all([store.upsertFromGoogle(PROFILE), store.upsertFromGoogle(PROFILE)]);
  assert.equal(first.id, second.id);
  assert.equal(ids.count(), 1);
});

test('upsert moves the email index when Google email changes', async (t) => {
  const { store, ldb } = await openStore(t, { randomId: sequentialIds().randomId });
  const created = await store.upsertFromGoogle(PROFILE);
  const moved = await store.upsertFromGoogle({ ...PROFILE, email: 'ada@new.example', name: 'Ada L' });
  assert.deepEqual(moved, { ...created, email: 'ada@new.example', name: 'Ada L' });
  assert.deepEqual(await store.findAllByEmail(PROFILE.email), []);
  assert.deepEqual(await store.findAllByEmail('ada@new.example'), [moved]);
  assert.deepEqual(await accountMetas(ldb), ['acct:id-1', 'email:ada@new.example', `sub:${PROFILE.sub}`]);
});

test('every account sharing an email is found, oldest first', async (t) => {
  const { store } = await openStore(t, { randomId: sequentialIds().randomId });
  const original = await store.upsertFromGoogle(PROFILE);
  const successor = await store.upsertFromGoogle({ sub: 'google-sub-2', email: 'ada@example.com' });
  assert.deepEqual(await store.findAllByEmail(PROFILE.email), [original, successor]);
  assert.deepEqual(await store.upsertFromGoogle(PROFILE), original, 'signing in again changes nothing');
  assert.deepEqual(await store.findAllByEmail(PROFILE.email), [original, successor], 'no duplicate or reorder');
  const moved = await store.upsertFromGoogle({ ...PROFILE, email: 'ada@new.example' });
  assert.deepEqual(await store.findAllByEmail(PROFILE.email), [successor]);
  assert.deepEqual(await store.findAllByEmail('ada@new.example'), [moved]);
});

test('an account that moves onto a shared email is still listed by creation time', async (t) => {
  let now = NOW_MS;
  const { store } = await openStore(t, { randomId: sequentialIds().randomId, now: () => now });
  const older = await store.upsertFromGoogle(PROFILE);
  now = LATER_MS;
  const newer = await store.upsertFromGoogle({ sub: 'google-sub-2', email: 'grace@example.com' });
  const moved = await store.upsertFromGoogle({ ...PROFILE, email: 'grace@example.com' });
  assert.deepEqual((await store.findAllByEmail('grace@example.com')).map(({ id }) => id), [older.id, newer.id]);
  assert.equal(moved.id, older.id);
});

test('deleting one account that shares an email keeps the other findable', async (t) => {
  const { store, ldb } = await openStore(t, { randomId: sequentialIds().randomId });
  const original = await store.upsertFromGoogle(PROFILE);
  const successor = await store.upsertFromGoogle({ sub: 'google-sub-2', email: PROFILE.email });
  assert.equal(await store.delete(successor.id), true);
  assert.deepEqual(await store.findAllByEmail(PROFILE.email), [original]);
  assert.equal(await store.delete(original.id), true);
  assert.deepEqual(await store.findAllByEmail(PROFILE.email), []);
  assert.deepEqual(await accountMetas(ldb), []);
});

test('findAllByEmail is case-insensitive', async (t) => {
  const { store } = await openStore(t);
  const created = await store.upsertFromGoogle(PROFILE);
  assert.deepEqual(await store.findAllByEmail('ada@example.com'), [created]);
  assert.deepEqual(await store.findAllByEmail('ADA@EXAMPLE.COM'), [created]);
  assert.deepEqual(await store.findAllByEmail('nobody@example.com'), []);
});

test('setPlan rejects unknown plans and stamps planGrantedAt', async (t) => {
  let now = NOW_MS;
  const { store } = await openStore(t, { now: () => now });
  const created = await store.upsertFromGoogle(PROFILE);
  await assert.rejects(store.setPlan(created.id, 'enterprise'), { code: 'UNKNOWN_PLAN' });
  assert.deepEqual(await store.get(created.id), created);
  now = LATER_MS;
  const granted = await store.setPlan(created.id, 'pro');
  assert.deepEqual(granted, { ...created, plan: 'pro', planGrantedAt: LATER_MS });
  assert.deepEqual(await store.get(created.id), granted);
  assert.equal(await store.setPlan('missing', 'pro'), null);
});

test('bumpSessionGeneration increments and persists the generation', async (t) => {
  const { store } = await openStore(t);
  const created = await store.upsertFromGoogle(PROFILE);
  assert.equal((await store.bumpSessionGeneration(created.id)).sessionGeneration, 1);
  assert.equal((await store.bumpSessionGeneration(created.id)).sessionGeneration, 2);
  assert.equal((await store.get(created.id)).sessionGeneration, 2);
  assert.equal(await store.bumpSessionGeneration('missing'), null);
});

test('delete removes record, sub and email indexes', async (t) => {
  const { store, ldb } = await openStore(t);
  const created = await store.upsertFromGoogle(PROFILE);
  assert.equal(await store.delete(created.id), true);
  assert.equal(await store.get(created.id), null);
  assert.deepEqual(await store.findAllByEmail(PROFILE.email), []);
  assert.deepEqual(await accountMetas(ldb), []);
  assert.equal(await store.delete(created.id), false);
  assert.notEqual((await store.upsertFromGoogle(PROFILE)).id, created.id);
});

test('logout-all and delete with an older expected generation change nothing', async (t) => {
  const { store } = await openStore(t);
  const created = await store.upsertFromGoogle(PROFILE);
  const [bumped, staleDelete] = await Promise.all([
    store.bumpSessionGeneration(created.id, { expectedGeneration: 0 }),
    store.delete(created.id, { expectedGeneration: 0 }),
  ]);
  assert.equal(bumped.sessionGeneration, 1);
  assert.equal(staleDelete, false, 'the delete queued behind logout-all sees the new generation');
  assert.equal(await store.bumpSessionGeneration(created.id, { expectedGeneration: 0 }), null);
  assert.deepEqual(await store.get(created.id), bumped);
  assert.equal(await store.delete(created.id, { expectedGeneration: 1 }), true);
  assert.equal(await store.get(created.id), null);
});

test('accounts never appear in getAllDocNames', async (t) => {
  const { store, ldb } = await openStore(t);
  const created = await store.upsertFromGoogle(PROFILE);
  await store.setPlan(created.id, 'pro');
  assert.deepEqual(await ldb.getAllDocNames(), []);
});

test('account records survive closing and reopening the database', async (t) => {
  const database = await openDatabase(t);
  const created = await storeFor(database.ldb).upsertFromGoogle(PROFILE);
  const granted = await storeFor(database.ldb, { now: () => LATER_MS }).setPlan(created.id, 'pro');
  const reopened = storeFor(await database.reopen());
  assert.deepEqual(await reopened.get(created.id), granted);
  assert.deepEqual(await reopened.findAllByEmail(PROFILE.email), [granted]);
  assert.equal((await reopened.upsertFromGoogle(PROFILE)).id, created.id);
});

test('a failed batch leaves no partial indexes and the next mutation still runs', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const database = await openDatabase(t);
  failBatches(database.ldb);
  const store = storeFor(database.ldb);
  await assert.rejects(store.upsertFromGoogle(PROFILE), STORAGE_FAILURE);
  await assert.rejects(store.upsertFromGoogle({ ...PROFILE, sub: 'google-sub-2' }), UNAVAILABLE);
  assert.equal(store.pendingOperations, 0);
  assert.deepEqual(await accountMetas(await database.reopen()), []);
});

test('a rejected mutation does not block the next one', async (t) => {
  const { store } = await openStore(t);
  const { id } = await store.upsertFromGoogle(PROFILE);
  const refused = store.setPlan(id, 'enterprise');
  const queued = store.setPlan(id, 'pro');
  await assert.rejects(refused, { code: 'UNKNOWN_PLAN' });
  assert.equal((await queued).plan, 'pro');
  assert.equal((await store.bumpSessionGeneration(id)).sessionGeneration, 1);
});

test('storage failure emits storage-failure and later mutations reject', async () => {
  const failure = storageOperationError('getMeta failed');
  const failures = [];
  const store = new AccountStore({
    ldb: {}, getMeta: async () => { throw failure; }, hasCapacity: () => true,
  });
  store.on(ACCOUNT_STORAGE_FAILURE_EVENT, (error) => failures.push(error));
  const first = store.upsertFromGoogle(PROFILE);
  const queued = store.setPlan('id', 'pro');
  await assert.rejects(first, STORAGE_FAILURE);
  await assert.rejects(queued, UNAVAILABLE);
  await assert.rejects(store.bumpSessionGeneration('id'), UNAVAILABLE);
  await assert.rejects(store.delete('id'), UNAVAILABLE);
  await assert.rejects(store.get('id'), STORAGE_FAILURE);
  assert.deepEqual(failures, [failure]);
  assert.equal(ACCOUNT_STORAGE_FAILURE_EVENT, 'storage-failure');
});

test('stop waits for queued mutations and rejects new ones', async (t) => {
  const { store } = await openStore(t);
  const queued = [store.upsertFromGoogle(PROFILE), store.upsertFromGoogle({ ...PROFILE, sub: 'google-sub-2' })];
  assert.equal(store.pendingOperations, 2);
  const settled = [];
  for (const operation of queued) operation.then(() => settled.push(operation));
  await store.stop();
  assert.equal(settled.length, 2);
  assert.equal(store.pendingOperations, 0);
  await assert.rejects(store.upsertFromGoogle(PROFILE), UNAVAILABLE);
  await assert.rejects(store.setPlan('id', 'pro'), UNAVAILABLE);
  await store.stop();
});

test('full database rejects upsert with DATABASE_CAPACITY', async (t) => {
  let capacity = true;
  const failures = [];
  const { store, ldb } = await openStore(t, { hasCapacity: () => capacity });
  store.on(ACCOUNT_STORAGE_FAILURE_EVENT, (error) => failures.push(error));
  const existing = await store.upsertFromGoogle(PROFILE);
  capacity = false;
  await assert.rejects(store.upsertFromGoogle({ ...PROFILE, sub: 'google-sub-2', email: 'new@example.com' }), { code: 'DATABASE_CAPACITY' });
  assert.equal((await store.upsertFromGoogle(PROFILE)).id, existing.id);
  assert.equal((await store.bumpSessionGeneration(existing.id)).sessionGeneration, 1);
  assert.deepEqual(failures, []);
  assert.equal((await accountMetas(ldb)).length, 3);
});
