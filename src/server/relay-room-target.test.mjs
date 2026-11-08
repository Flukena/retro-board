import test from 'node:test';
import assert from 'node:assert/strict';
import { roomTargetFromRequest, tokenDocNameFromRequest } from './relay-room-target.js';

const HANDLE = 'h'.repeat(32);
const at = (url) => ({ url });
const MAX_U32 = 4294967295;

test('y-websocket room paths parse in bare and /yjs forms, with an optional awareness id', () => {
  const plain = { handle: HANDLE, awarenessClientId: null, supportsQuota: false, e2e: false };
  assert.deepEqual(roomTargetFromRequest(at(`/rooms/${HANDLE}`)), plain);
  assert.deepEqual(roomTargetFromRequest(at(`/yjs/rooms/${HANDLE}`)), plain);
  assert.deepEqual(roomTargetFromRequest(at(`/rooms/${HANDLE}?awarenessId=42`)), { ...plain, awarenessClientId: 42 });
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}?awarenessId=${MAX_U32}`)).awarenessClientId, MAX_U32);
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}?awarenessId=${MAX_U32 + 1}`)), null);
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}?awarenessId=01`)), null);
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}?awarenessId=1&quota=1`)), null, 'quota is Public Wall only');
});

test('the encrypted path is /rooms/<handle>/e2e, bare or under /yjs, and takes no query', () => {
  const e2e = { handle: HANDLE, awarenessClientId: null, supportsQuota: false, e2e: true };
  assert.deepEqual(roomTargetFromRequest(at(`/rooms/${HANDLE}/e2e`)), e2e);
  assert.deepEqual(roomTargetFromRequest(at(`/yjs/rooms/${HANDLE}/e2e`)), e2e);
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}/e2e?awarenessId=1`)), null);
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}/e2e?`)), null);
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}/e2e/`)), null);
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}/E2E`)), null);
});

test('the Public Wall relay strips /yjs-public, allows the quota flag and never matches /e2e', () => {
  const options = { publicWall: true };
  assert.deepEqual(roomTargetFromRequest(at(`/yjs-public/rooms/${HANDLE}?awarenessId=7&quota=1`), options),
    { handle: HANDLE, awarenessClientId: 7, supportsQuota: true, e2e: false });
  assert.equal(roomTargetFromRequest(at(`/yjs-public/rooms/${HANDLE}/e2e`), options), null);
  assert.equal(roomTargetFromRequest(at(`/rooms/${HANDLE}/e2e`), options), null);
  assert.equal(roomTargetFromRequest(at(`/yjs-public/rooms/${HANDLE}`)), null, 'only the Public Wall strips its prefix');
  for (const suffix of ['#secret', '?token=secret', '?awarenessId=-1', '?awarenessId=42&token=secret']) {
    assert.equal(roomTargetFromRequest(at(`/yjs-public/rooms/${HANDLE}${suffix}`), options), null, `capability-bearing ${suffix}`);
  }
});

test('malformed targets are refused', () => {
  for (const url of [undefined, '', 'rooms/x', `//rooms/${HANDLE}`, `/rooms/${HANDLE}#x`, `/rooms/${'h'.repeat(31)}`,
    `/rooms/${HANDLE}${'?'.padEnd(260, 'a')}`, `/other/${HANDLE}`]) {
    assert.equal(roomTargetFromRequest(at(url)), null, String(url));
  }
});

test('legacy token paths keep their yjs/ persistence prefix; tokenless boards need the opt-in', () => {
  const tokenized = 'board-abc-12345678';
  assert.equal(tokenDocNameFromRequest(at(`/${tokenized}`)), `yjs/${tokenized}`);
  assert.equal(tokenDocNameFromRequest(at(`/yjs/${tokenized}`)), `yjs/${tokenized}`);
  assert.equal(tokenDocNameFromRequest(at(`/${tokenized}?x=1`)), null);
  assert.equal(tokenDocNameFromRequest(at('/board-abc')), null);
  assert.equal(tokenDocNameFromRequest(at('/board-abc'), { allowLegacyRooms: true }), 'yjs/board-abc');
  assert.equal(tokenDocNameFromRequest(at(`//${tokenized}`)), null);
});
