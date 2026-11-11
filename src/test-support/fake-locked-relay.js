import { sha256Base64Url } from './sha256-base64url.js';

export const LOCKED_TEST_CODE = 'TEST';
export const LOCKED_TEST_TOKEN = 'Abcdefgh12345678';
export const LOCKED_TEST_HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

/**
 * A fake of POST /api/room-session (and its room-scoped renewal path) for one locked room, at the fetch boundary only.
 * `lock` is a record from createRoomLock; `authKey` the key that record accepts.
 */
export function fakeLockedRelay({ lock, authKey, keyEpoch = 1, isOwner = true, lockRevision = 0 }) {
  const relay = { lock, authKey, keyEpoch, isOwner, lockRevision, limitedSeconds: null, calls: [], paths: [] };
  relay.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    relay.calls.push(body);
    relay.paths.push(new URL(url).pathname);
    if (!Object.hasOwn(body, 'authKey')) {
      const { salt, kdf } = relay.lock;
      return new Response(JSON.stringify({ locked: true, salt, kdf }), { status: 409, headers: JSON_HEADERS });
    }
    if (relay.limitedSeconds !== null) return new Response('', { status: 429, headers: { 'retry-after': String(relay.limitedSeconds) } });
    if (await sha256Base64Url(body.authKey) !== relay.lock.verifier) return new Response('', { status: 403 });
    const { wrappedDek, wrapIv } = relay.lock;
    return new Response(JSON.stringify({
      roomHandle: LOCKED_TEST_HANDLE,
      expiresAt: Date.now() + SESSION_TTL_MS,
      lock: { wrappedDek, wrapIv, keyEpoch: relay.keyEpoch, lockRevision: relay.lockRevision, isOwner: relay.isOwner },
    }), { status: 200, headers: JSON_HEADERS });
  };
  return relay;
}
