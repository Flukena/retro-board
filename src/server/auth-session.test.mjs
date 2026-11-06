import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ACCOUNT_SESSION_TTL_MS, AccountSessions, accountCookiePath, authenticateAccount } from './auth-session.js';
import { AccountStore } from './account-store.js';
import { checkedStorage } from './relay-storage.js';
import { ACCOUNT_SESSION_KEY, loadSessionSigningKey, loadSigningKey } from './relay-local-files.js';
import { MILLISECONDS_PER_DAY } from './relay-config.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const KEY_BYTES = 32;
const MAX_COOKIE_HEADER_BYTES = 4096;
const ACCOUNT_ID = 'abcDEF123_-xyz00';
const GENERATION = 3;
const SIGNATURE_INDEX = 4;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PROFILE = Object.freeze({ sub: 'google-sub-1', email: 'ada@example.com', name: 'Ada' });

const newSessions = (options = {}) => new AccountSessions({
  signingKey: randomBytes(KEY_BYTES), allowInsecureHttp: false, maxCookieHeaderBytes: MAX_COOKIE_HEADER_BYTES, ...options,
});
const cookieOf = (setCookie) => setCookie.split(';')[0];
const requestWith = (cookie) => ({ headers: { cookie } });
const mutateField = (cookie, index, mutate) => {
  const [name, value] = cookie.split('=');
  const parts = value.split('.');
  parts[index] = mutate(parts[index]);
  return `${name}=${parts.join('.')}`;
};

test('round-trips a valid cookie', () => {
  const sessions = newSessions();
  const before = Date.now();
  const cookie = cookieOf(sessions.createCookie(ACCOUNT_ID, GENERATION, '/api'));
  const session = sessions.read(requestWith(cookie));
  assert.equal(session.accountId, ACCOUNT_ID);
  assert.equal(session.generation, GENERATION);
  assert.ok(session.expiresAt >= before + ACCOUNT_SESSION_TTL_MS);
  assert.equal(ACCOUNT_SESSION_TTL_MS, 30 * MILLISECONDS_PER_DAY);
});

test('cookie is host-only, HttpOnly, SameSite=Lax with the TTL as Max-Age', () => {
  const header = newSessions().createCookie(ACCOUNT_ID, 0, '/api');
  assert.match(header, /^rb_account=v1\./);
  assert.match(header, /; Path=\/api; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.doesNotMatch(header, /Domain/i);
});

test('rejects tampered signature and non-canonical base64url', () => {
  const sessions = newSessions();
  const cookie = cookieOf(sessions.createCookie(ACCOUNT_ID, GENERATION, '/api'));
  const flipped = mutateField(cookie, SIGNATURE_INDEX, (sig) => `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`);
  assert.equal(sessions.read(requestWith(flipped)), null);
  // 43 chars encode 32 bytes; the last char carries 2 unused bits that must be zero.
  const alternate = mutateField(cookie, SIGNATURE_INDEX, (sig) => `${sig.slice(0, -1)}${B64URL[B64URL.indexOf(sig.at(-1)) ^ 1]}`);
  assert.equal(sessions.read(requestWith(alternate)), null);
  const otherGeneration = mutateField(cookie, 2, () => String(GENERATION + 1));
  assert.equal(sessions.read(requestWith(otherGeneration)), null);
  assert.equal(newSessions().read(requestWith(cookie)), null);
});

test('rejects expired and over-TTL expiry', (t) => {
  const key = randomBytes(KEY_BYTES);
  const issuer = newSessions({ signingKey: key });
  const reader = newSessions({ signingKey: key });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const start = realNow();
  Date.now = () => start;
  const cookie = cookieOf(issuer.createCookie(ACCOUNT_ID, GENERATION, '/api'));
  assert.ok(reader.read(requestWith(cookie)));
  Date.now = () => start + ACCOUNT_SESSION_TTL_MS + 1;
  assert.equal(reader.read(requestWith(cookie)), null);
  Date.now = () => start - ACCOUNT_SESSION_TTL_MS;
  assert.equal(reader.read(requestWith(cookie)), null);
});

test('rejects duplicate rb_account cookies', () => {
  const sessions = newSessions();
  const cookie = cookieOf(sessions.createCookie(ACCOUNT_ID, GENERATION, '/api'));
  assert.ok(sessions.read(requestWith(`other=1; ${cookie}`)));
  assert.equal(sessions.read(requestWith(`${cookie}; ${cookie}`)), null);
  assert.equal(sessions.read(requestWith(`x=${'a'.repeat(MAX_COOKIE_HEADER_BYTES)}; ${cookie}`)), null);
  assert.equal(sessions.read({ headers: {} }), null);
});

test('rejects malformed account ids and generations', () => {
  const sessions = newSessions();
  const cookie = cookieOf(sessions.createCookie(ACCOUNT_ID, GENERATION, '/api'));
  assert.equal(sessions.read(requestWith(mutateField(cookie, 1, () => 'bad.id'))), null);
  assert.equal(sessions.read(requestWith(mutateField(cookie, 2, () => '-1'))), null);
  assert.equal(sessions.read(requestWith(`${cookie}.extra`)), null);
});

test('prefixed path is /yjs/api and Secure is set outside insecure dev', () => {
  assert.equal(accountCookiePath(true), '/yjs/api');
  assert.equal(accountCookiePath(false), '/api');
  assert.match(newSessions().createCookie(ACCOUNT_ID, 0, '/yjs/api'), /; Path=\/yjs\/api;.*; Secure$/);
  assert.doesNotMatch(newSessions({ allowInsecureHttp: true }).createCookie(ACCOUNT_ID, 0, '/api'), /Secure/);
});

test('clearCookie uses the same path as createCookie', () => {
  const sessions = newSessions();
  const created = sessions.createCookie(ACCOUNT_ID, 0, '/yjs/api');
  const cleared = sessions.clearCookie('/yjs/api');
  assert.match(created, /Path=\/yjs\/api;/);
  assert.match(cleared, /^rb_account=; Path=\/yjs\/api; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/);
  assert.doesNotMatch(newSessions({ allowInsecureHttp: true }).clearCookie('/api'), /Secure/);
});

async function openStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'auth-session-'));
  const ldb = new LeveldbPersistence(directory);
  t.after(async () => { await ldb.destroy(); await rm(directory, { recursive: true, force: true }); });
  return new AccountStore({ ldb, getMeta: checkedStorage(ldb, Y).getMeta, hasCapacity: () => true });
}

test('authenticateAccount returns the account for a current cookie', async (t) => {
  const store = await openStore(t);
  const account = await store.upsertFromGoogle(PROFILE);
  const sessions = newSessions();
  const cookie = cookieOf(sessions.createCookie(account.id, account.sessionGeneration, '/api'));
  assert.equal((await authenticateAccount(requestWith(cookie), sessions, store)).id, account.id);
  assert.equal(await authenticateAccount({ headers: {} }, sessions, store), null);
});

test('authenticateAccount rejects a stale generation', async (t) => {
  const store = await openStore(t);
  const account = await store.upsertFromGoogle(PROFILE);
  const sessions = newSessions();
  const cookie = cookieOf(sessions.createCookie(account.id, account.sessionGeneration, '/api'));
  await store.bumpSessionGeneration(account.id);
  assert.equal(await authenticateAccount(requestWith(cookie), sessions, store), null);
});

test('authenticateAccount rejects a deleted account', async (t) => {
  const store = await openStore(t);
  const account = await store.upsertFromGoogle(PROFILE);
  const sessions = newSessions();
  const cookie = cookieOf(sessions.createCookie(account.id, account.sessionGeneration, '/api'));
  assert.equal(await store.delete(account.id), true);
  assert.equal(await authenticateAccount(requestWith(cookie), sessions, store), null);
});

test('room and account keys load from different files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'signing-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved = { room: process.env.YJS_SESSION_SECRET, account: process.env.YJS_ACCOUNT_SESSION_SECRET };
  delete process.env.YJS_SESSION_SECRET;
  delete process.env.YJS_ACCOUNT_SESSION_SECRET;
  t.after(() => {
    for (const [name, value] of [['YJS_SESSION_SECRET', saved.room], ['YJS_ACCOUNT_SESSION_SECRET', saved.account]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const room = loadSessionSigningKey(directory);
  const account = loadSigningKey(directory, ACCOUNT_SESSION_KEY);
  assert.notDeepEqual(room, account);
  assert.deepEqual(loadSigningKey(directory, ACCOUNT_SESSION_KEY), account);
  assert.deepEqual(loadSessionSigningKey(directory), room);
  process.env.YJS_ACCOUNT_SESSION_SECRET = 'short';
  assert.throws(() => loadSigningKey(directory, ACCOUNT_SESSION_KEY), /YJS_ACCOUNT_SESSION_SECRET must contain at least 32 bytes/);
});
