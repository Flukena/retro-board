import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOM_OWNER_META, ROOM_KIND, MAX_OWNED_ROOMS_PER_ACCOUNT, ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON,
  RETENTION_CLASS, encodeOwnerRecord, decodeOwnerRecord, orphanOwnerRecord, retentionClass,
} from './room-ownership.js';

const ACCOUNT = 'a'.repeat(22);
const CREATED = 1_700_000_000_000;
const owned = { kind: 'board', accountId: ACCOUNT, createdAt: CREATED };
const guest = { kind: 'poker', accountId: null, createdAt: CREATED };

test('contract constants', () => {
  assert.equal(ROOM_OWNER_META, 'retro-room-owner-v1');
  assert.deepEqual({ ...ROOM_KIND }, { BOARD: 'board', POKER: 'poker' });
  assert.equal(MAX_OWNED_ROOMS_PER_ACCOUNT, 500);
  assert.equal(ROOM_DELETED_CLOSE_CODE, 4004);
  assert.equal(typeof ROOM_DELETED_REASON, 'string');
});

test('encode produces the exact versioned shape and decode round-trips it', () => {
  assert.deepEqual(encodeOwnerRecord(owned), { v: 1, kind: 'board', accountId: ACCOUNT, createdAt: CREATED });
  assert.deepEqual(decodeOwnerRecord(encodeOwnerRecord(owned)), owned);
  assert.deepEqual(decodeOwnerRecord(encodeOwnerRecord(guest)), guest);
});

test('encode refuses invalid input', () => {
  assert.throws(() => encodeOwnerRecord({ ...owned, kind: 'wall' }));
  assert.throws(() => encodeOwnerRecord({ ...owned, accountId: 'short' }));
  assert.throws(() => encodeOwnerRecord({ ...owned, createdAt: 0 }));
});

test('decode rejects extra keys, missing keys, bad kind, bad version and bad values', () => {
  const good = encodeOwnerRecord(owned);
  assert.ok(decodeOwnerRecord(good));
  assert.equal(decodeOwnerRecord({ ...good, extra: 1 }), null);
  for (const key of Object.keys(good)) {
    const { [key]: _omitted, ...rest } = good;
    assert.equal(decodeOwnerRecord(rest), null, `missing ${key}`);
  }
  assert.equal(decodeOwnerRecord({ ...good, kind: 'wall' }), null);
  assert.equal(decodeOwnerRecord({ ...good, v: 2 }), null);
  assert.equal(decodeOwnerRecord({ ...good, createdAt: -1 }), null);
  assert.equal(decodeOwnerRecord({ ...good, createdAt: '1' }), null);
  for (const bad of [undefined, 7, '', {}, [], 'x', false]) assert.equal(decodeOwnerRecord({ ...good, accountId: bad }), null);
  assert.equal(decodeOwnerRecord({ ...good, accountId: 'short' }), null);
  for (const bad of [null, undefined, 'x', 3, []]) assert.equal(decodeOwnerRecord(bad), null);
});

test('accountId null is a guest record; orphanedAt only with null accountId', () => {
  const orphan = orphanOwnerRecord(owned, CREATED + 5);
  assert.deepEqual(orphan, { kind: 'board', accountId: null, createdAt: CREATED, orphanedAt: CREATED + 5 });
  assert.deepEqual(decodeOwnerRecord({ v: 1, ...orphan }), orphan);
  assert.equal(decodeOwnerRecord({ v: 1, ...owned, orphanedAt: CREATED }), null);
  assert.equal(decodeOwnerRecord({ v: 1, ...orphan, orphanedAt: 'x' }), null);
});

test('retention class: legacy and owned and orphaned are kept, only a pure guest is guest', () => {
  assert.equal(retentionClass(null), RETENTION_CLASS.KEPT);
  assert.equal(retentionClass(guest), 'guest');
  assert.equal(retentionClass(orphanOwnerRecord(owned, CREATED)), 'kept');
  assert.equal(retentionClass(orphanOwnerRecord(guest, CREATED)), 'kept');
  assert.equal(retentionClass(owned), 'kept');
});
