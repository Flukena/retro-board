import assert from 'node:assert/strict';
import { startFakeGoogleOidc } from '../../scripts/fake-google-oidc.mjs';
import { approvedCallback, startRelay } from './relay-harness.mjs';
import { canonicalDocName } from '../server/relay-room-registry.js';

export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';
const GOOGLE_ENV = Object.freeze({
  GOOGLE_OAUTH_CLIENT_ID: 'e2e-relay-test-client', GOOGLE_OAUTH_CLIENT_SECRET: 'e2e-relay-test-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:1234/api/auth/google/callback',
});
const STATUS = Object.freeze({ OK: 200, CREATED: 201 });

export const cookiePair = (setCookie) => setCookie.split(';')[0];

export const post = (relay, path, body, cookie) => fetch(`${relay.url}${path}`, {
  method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});

/** A real relay with Google sign-in stubbed, so tests can create locked rooms. */
export async function lockedRelay(t, env = {}, { root = null } = {}) {
  const stub = await startFakeGoogleOidc();
  t.after(() => stub.close());
  const relay = await startRelay(t, {
    YJS_ALLOW_INSECURE_HTTP: 'true', YJS_ALLOWED_ORIGINS: ORIGIN, GOOGLE_OAUTH_ENDPOINT_BASE: stub.url, ...GOOGLE_ENV, ...env,
  }, { root });
  return { relay, stub };
}

export async function signIn({ relay, stub }) {
  const { flowCookie, url } = await approvedCallback(relay, stub, '', `${ORIGIN}/`);
  const response = await fetch(url, { headers: { cookie: cookiePair(flowCookie) }, redirect: 'manual' });
  return cookiePair(response.headers.getSetCookie().find((cookie) => cookie.startsWith('rb_account=')));
}

/** Runs the session exchange; pass the authKey for a locked room. */
export async function exchange(relay, room, authKey) {
  const response = await post(relay, '/api/room-session', authKey ? { ...room, authKey } : room);
  assert.equal(response.status, STATUS.OK, relay.output());
  const { roomHandle } = await response.json();
  return { ...room, handle: roomHandle, docName: canonicalDocName(room.code, room.token), cookie: cookiePair(response.headers.get('set-cookie')) };
}

export async function createLockedRoom(env, roomLock) {
  const response = await post(env.relay, '/api/rooms', { lock: roomLock.lock }, await signIn(env));
  assert.equal(response.status, STATUS.CREATED, env.relay.output());
  return exchange(env.relay, await response.json(), roomLock.authKey);
}

export async function createNormalRoom(relay) {
  const response = await post(relay, '/api/rooms', {});
  assert.equal(response.status, STATUS.CREATED);
  return exchange(relay, await response.json(), null);
}
