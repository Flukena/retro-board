import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ACCOUNTS_DOC_NAME, AccountStore } from '../src/server/account-store.js';
import { checkedStorage, durableMetaBatch } from '../src/server/relay-storage.js';
import { verifyBackupAccounts } from './verify-backup-accounts.mjs';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const NOW_MS = Date.UTC(2026, 10, 6);
const PROFILES = [
  { sub: 'sub-ada', email: 'Ada@Example.com', name: 'Ada' },
  { sub: 'sub-grace', email: 'grace@example.com', name: '' },
];
const INVALID_RECORD_BYTES = Buffer.from([0xff, 0xff, 0xff, 0xff]);

async function openFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'verify-accounts-'));
  const ldb = new LeveldbPersistence(directory);
  t.after(async () => { await ldb.destroy(); await rm(directory, { recursive: true, force: true }); });
  const store = new AccountStore({
    ldb, getMeta: checkedStorage(ldb, Y).getMeta, hasCapacity: () => true, now: () => NOW_MS,
  });
  return { ldb, store };
}

async function seedAccounts(store) {
  const [ada, grace] = await Promise.all(PROFILES.map((profile) => store.upsertFromGoogle(profile)));
  await store.setPlan(ada.id, 'pro');
  await store.bumpSessionGeneration(grace.id);
  return { ada, grace };
}

test('known account, grant and generation verify', async (t) => {
  const { ldb, store } = await openFixture(t);
  await seedAccounts(store);
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 2 });
});

test('a pre-accounts backup still verifies', async (t) => {
  const { ldb } = await openFixture(t);
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 0 });
});

test('a dangling email index fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  const { ada } = await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: 'email:ghost@example.com', value: 'missing-id' }]);
  await assert.rejects(verifyBackupAccounts(ldb), /email index points to a missing account/);
  assert.ok(await store.get(ada.id));
});

test('a dangling sub index fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: 'sub:ghost', value: 'missing-id' }]);
  await assert.rejects(verifyBackupAccounts(ldb), /sub index points to a missing account/);
});

// Recorded ruling: the latest sign-in owns a shared email index, so an account
// may lack its email index; sub indexes stay mandatory.
test('an account missing its email index still verifies', async (t) => {
  const { ldb, store } = await openFixture(t);
  await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'del', key: 'email:grace@example.com' }]);
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 2 });
});

test('deleting the owner of a shared email still verifies and leaves the other account unfindable by email', async (t) => {
  const { ldb, store } = await openFixture(t);
  const original = await store.upsertFromGoogle({ sub: 'sub-old', email: 'shared@example.com', name: 'Old' });
  const successor = await store.upsertFromGoogle({ sub: 'sub-new', email: 'shared@example.com', name: 'New' });
  await store.delete(successor.id);
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 1 });
  assert.ok(await store.get(original.id));
  assert.equal(await store.findByEmail('shared@example.com'), null);
});

test('an email change by the owner of a shared email still verifies', async (t) => {
  const { ldb, store } = await openFixture(t);
  const original = await store.upsertFromGoogle({ sub: 'sub-old', email: 'shared@example.com', name: 'Old' });
  await store.upsertFromGoogle({ sub: 'sub-new', email: 'shared@example.com', name: 'New' });
  await store.upsertFromGoogle({ sub: 'sub-new', email: 'moved@example.com', name: 'New' });
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 2 });
  assert.ok(await store.get(original.id));
  assert.equal(await store.findByEmail('shared@example.com'), null);
});

test('account ids and generations the session cookie cannot carry fail', async (t) => {
  const { ldb, store } = await openFixture(t);
  const { ada } = await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: `acct:${ada.id}`, value: { ...ada, sessionGeneration: 1e15 } }]);
  await assert.rejects(verifyBackupAccounts(ldb), /account record is invalid/);
  const { ldb: shortIdDb } = await openFixture(t);
  await durableMetaBatch(shortIdDb, ACCOUNTS_DOC_NAME, [
    { type: 'put', key: 'acct:x', value: { ...ada, id: 'x' } },
    { type: 'put', key: `sub:${ada.googleSub}`, value: 'x' },
  ]);
  await assert.rejects(verifyBackupAccounts(shortIdDb), /account record is invalid/);
});

test('an account missing its sub index fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'del', key: 'sub:sub-ada' }]);
  await assert.rejects(verifyBackupAccounts(ldb), /account has no sub index/);
});

test('a corrupt account record fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  const { ada } = await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: `acct:${ada.id}`, value: { ...ada, plan: 'platinum' } }]);
  await assert.rejects(verifyBackupAccounts(ldb), /account record is invalid/);
});

test('an account record that is not a record fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  const { ada } = await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: `acct:${ada.id}`, value: 'oops' }]);
  await assert.rejects(verifyBackupAccounts(ldb), /account record is invalid/);
});

test('undecodable account bytes fail', async (t) => {
  const { ldb, store } = await openFixture(t);
  const { ada } = await seedAccounts(store);
  const key = ['v1', ACCOUNTS_DOC_NAME, 'meta', `acct:${ada.id}`];
  await ldb._transact((db) => db.put(key, INVALID_RECORD_BYTES));
  await assert.rejects(verifyBackupAccounts(ldb), /accounts namespace cannot be read/);
});

test('an unknown key in the accounts namespace fails', async (t) => {
  const { ldb } = await openFixture(t);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: 'stray:1', value: 1 }]);
  await assert.rejects(verifyBackupAccounts(ldb), /unknown key in accounts namespace/);
});

test('an email index owned by another sub still verifies when the email matches', async (t) => {
  const { ldb, store } = await openFixture(t);
  await store.upsertFromGoogle({ sub: 'sub-old', email: 'shared@example.com', name: 'Old' });
  await store.upsertFromGoogle({ sub: 'sub-new', email: 'shared@example.com', name: 'New' });
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 2 });
});
