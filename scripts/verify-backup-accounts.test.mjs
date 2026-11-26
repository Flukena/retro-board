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

test('backups allow saved handles and reject full invite links in the account record', async t => {
  const { ldb, store } = await openFixture(t);
  const { ada } = await seedAccounts(store);
  await store.setBoardSaved(ada.id, ada.sessionGeneration, { handle: 'a'.repeat(32), saved: true, staleHandles: new Set() });
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 2 });
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [
    { type: 'put', key: `acct:${ada.id}`, value: { ...ada, savedBoardHandles: ['/b/shared#invitation'] } },
  ]);
  await assert.rejects(verifyBackupAccounts(ldb), /account record is invalid/);
});

test('a dangling email index fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  const { ada } = await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: 'email:ghost@example.com', value: ['missing-id'] }]);
  await assert.rejects(verifyBackupAccounts(ldb), /email index points to a missing account/);
  assert.ok(await store.get(ada.id));
});

test('a dangling sub index fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: 'sub:ghost', value: 'missing-id' }]);
  await assert.rejects(verifyBackupAccounts(ldb), /sub index points to a missing account/);
});

test('an account missing its email index fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'del', key: 'email:grace@example.com' }]);
  await assert.rejects(verifyBackupAccounts(ldb), /account has no email index/);
});

test('an email index that is not a list of distinct ids fails', async (t) => {
  for (const value of [undefined, 'single-id', [], [''], ['dup', 'dup']]) {
    const { ldb, store } = await openFixture(t);
    const { grace } = await seedAccounts(store);
    const broken = value === undefined ? grace.id : value;
    await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: 'email:grace@example.com', value: broken }]);
    await assert.rejects(verifyBackupAccounts(ldb), /email index is invalid/, JSON.stringify(broken));
  }
});

test('an email index listing an account with another email fails', async (t) => {
  const { ldb, store } = await openFixture(t);
  const { ada, grace } = await seedAccounts(store);
  await durableMetaBatch(ldb, ACCOUNTS_DOC_NAME, [{ type: 'put', key: 'email:grace@example.com', value: [grace.id, ada.id] }]);
  await assert.rejects(verifyBackupAccounts(ldb), /email index points to an account with a different email/);
});

test('deleting one account that shares an email still verifies and keeps the other findable', async (t) => {
  const { ldb, store } = await openFixture(t);
  const original = await store.upsertFromGoogle({ sub: 'sub-old', email: 'shared@example.com', name: 'Old' });
  const successor = await store.upsertFromGoogle({ sub: 'sub-new', email: 'shared@example.com', name: 'New' });
  await store.delete(successor.id);
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 1 });
  assert.deepEqual(await store.findAllByEmail('shared@example.com'), [original]);
});

test('an email change by one account that shares an email still verifies', async (t) => {
  const { ldb, store } = await openFixture(t);
  const original = await store.upsertFromGoogle({ sub: 'sub-old', email: 'shared@example.com', name: 'Old' });
  await store.upsertFromGoogle({ sub: 'sub-new', email: 'shared@example.com', name: 'New' });
  await store.upsertFromGoogle({ sub: 'sub-new', email: 'moved@example.com', name: 'New' });
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 2 });
  assert.deepEqual(await store.findAllByEmail('shared@example.com'), [original]);
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

test('two accounts sharing an email verify', async (t) => {
  const { ldb, store } = await openFixture(t);
  await store.upsertFromGoogle({ sub: 'sub-old', email: 'shared@example.com', name: 'Old' });
  await store.upsertFromGoogle({ sub: 'sub-new', email: 'shared@example.com', name: 'New' });
  assert.deepEqual(await verifyBackupAccounts(ldb), { accounts: 2 });
});
