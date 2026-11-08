import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { RoomSessions } from './relay-session.js';

const HANDLE_LENGTH = 32;
const TTL_MS = 60_000;
const MAX_COOKIE_HEADER_BYTES = 1024;
const KEY_BYTES = 32;
const HANDLE = 'a'.repeat(HANDLE_LENGTH);
const OTHER_HANDLE = 'b'.repeat(HANDLE_LENGTH);
const create = (overrides = {}) => new RoomSessions({ signingKey: randomBytes(KEY_BYTES),
  rooms: new Map([[HANDLE, 'one'], [OTHER_HANDLE, 'two']]), ttlMs: TTL_MS, maxCookieHeaderBytes: MAX_COOKIE_HEADER_BYTES,
  allowInsecureHttp: false, ...overrides });
const request = cookie => ({ headers: { cookie } });

test('sessions are signed, secure, scoped to the requested room and reject duplicates', () => {
  const sessions = create();
  const expiresAt = Date.now() + TTL_MS;
  const cookie = sessions.createCookie(HANDLE, expiresAt, 'one', `/yjs/rooms/${HANDLE}`).split(';')[0];
  assert.deepEqual(sessions.authenticate(request(cookie), HANDLE), { docName: 'one', expiresAt });
  assert.equal(sessions.authenticate(request(cookie), OTHER_HANDLE), null);
  assert.equal(sessions.authenticate(request(`${cookie}; ${cookie}`), HANDLE), null);
  assert.match(sessions.createCookie(HANDLE, expiresAt, 'one', '/yjs/'), /; Secure$/);
});

test('expired, missing, oversized and tampered cookies never authenticate', () => {
  const sessions = create();
  const expired = sessions.createCookie(HANDLE, Date.now() - TTL_MS, 'one', '/').split(';')[0];
  assert.equal(sessions.authenticate(request(expired), HANDLE), null);
  assert.equal(sessions.authenticate(request(undefined), HANDLE), null);
  assert.equal(sessions.authenticate(request('a'.repeat(MAX_COOKIE_HEADER_BYTES + 1)), HANDLE), null);
  const cookie = sessions.createCookie(HANDLE, Date.now() + TTL_MS, 'one', '/').split(';')[0];
  assert.equal(sessions.authenticate(request(cookie.replace('v1.', 'v2.')), HANDLE), null);
  assert.equal(create().authenticate(request(cookie), HANDLE), null);
});

test('a locked-room cookie is bound to its key epoch and a normal cookie never authenticates a locked room', () => {
  const sessions = create();
  const expiresAt = Date.now() + TTL_MS;
  const bound = sessions.createCookie(HANDLE, expiresAt, 'one', '/', { keyEpoch: 3 }).split(';')[0];
  assert.deepEqual(sessions.authenticate(request(bound), HANDLE, { expectedEpoch: 3 }), { docName: 'one', expiresAt });
  assert.equal(sessions.authenticate(request(bound), HANDLE, { expectedEpoch: 4 }), null);
  assert.equal(sessions.authenticate(request(bound), HANDLE), null, 'unbound expectation rejects an epoch cookie');
  const plain = sessions.createCookie(HANDLE, expiresAt, 'one', '/').split(';')[0];
  assert.equal(sessions.authenticate(request(plain), HANDLE, { expectedEpoch: 0 }), null);
});

test('epochOf supplies the expected epoch when the caller passes none', () => {
  const epochs = new Map([['one', 2]]);
  const sessions = create({ epochOf: (docName) => epochs.get(docName) ?? null });
  const expiresAt = Date.now() + TTL_MS;
  const cookie = sessions.createCookie(HANDLE, expiresAt, 'one', '/', { keyEpoch: 2 }).split(';')[0];
  assert.ok(sessions.authenticate(request(cookie), HANDLE));
  epochs.set('one', 3);
  assert.equal(sessions.authenticate(request(cookie), HANDLE), null);
});
