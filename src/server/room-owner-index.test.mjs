import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OWNED_ROOMS_PER_ACCOUNT, ROOM_KIND, decodeOwnerRecord, orphanOwnerRecord } from '../domain/room-ownership.js';
import { OWNED_ROOM_LIMIT_CODE, RoomOwnerIndex, ownerEntry, storedOwnerValue } from './room-owner-index.js';

const ADA = 'ada-account-id-0001';
const BOB = 'bob-account-id-0002';
const CREATED_AT = 1_800_000_000_000;
const ORPHANED_AT = CREATED_AT + 1;
const docOf = (index) => `yjs/board-Room${index}-abcdefgh12345678`;
const owned = (accountId, kind = ROOM_KIND.BOARD) => ({ kind, accountId, createdAt: CREATED_AT });
const fillOwned = (index, accountId, count) => {
  for (let room = 0; room < count; room += 1) index.set(docOf(room), ownerEntry(owned(accountId), null));
};

test('a reservation counts against the limit until released, and release is idempotent', () => {
  const index = new RoomOwnerIndex();
  fillOwned(index, ADA, MAX_OWNED_ROOMS_PER_ACCOUNT - 1);
  const release = index.reserve(ADA);
  assert.throws(() => index.reserve(ADA), { code: OWNED_ROOM_LIMIT_CODE });
  assert.doesNotThrow(() => index.reserve(BOB)(), 'another account has its own budget');
  release();
  release();
  const again = index.reserve(ADA);
  assert.throws(() => index.reserve(ADA), { code: OWNED_ROOM_LIMIT_CODE }, 'a double release frees only one slot');
  again();
});

test('a guest reservation is free and unbounded', () => {
  const index = new RoomOwnerIndex();
  for (let room = 0; room <= MAX_OWNED_ROOMS_PER_ACCOUNT; room += 1) index.reserve(null);
  assert.deepEqual(index.roomsOwnedBy(ADA), []);
});

test('the index follows set, re-set and forget; guest and orphaned rooms belong to nobody', () => {
  const index = new RoomOwnerIndex();
  index.set(docOf(1), ownerEntry(owned(ADA), null));
  index.set(docOf(2), ownerEntry(owned(null), null));
  assert.deepEqual(index.roomsOwnedBy(ADA), [docOf(1)]);
  const listed = index.roomsOwnedBy(ADA);
  listed.push('mutated');
  assert.deepEqual(index.roomsOwnedBy(ADA), [docOf(1)], 'callers get a copy');
  index.set(docOf(1), ownerEntry(orphanOwnerRecord(owned(ADA), ORPHANED_AT), null));
  assert.deepEqual(index.roomsOwnedBy(ADA), []);
  index.set(docOf(1), ownerEntry(owned(BOB), null));
  assert.deepEqual(index.roomsOwnedBy(BOB), [docOf(1)]);
  index.forget(docOf(1));
  assert.deepEqual(index.roomsOwnedBy(BOB), []);
  assert.deepEqual(index.entryOf(docOf(1)), { record: null, ownerAccountId: null });
  assert.equal(index.entryOf(docOf(2)).record.accountId, null);
});

test('a record decides the owner; a locked room without one falls back to the lock owner', () => {
  const lock = { ownerAccountId: BOB };
  assert.equal(ownerEntry(owned(ADA), lock).ownerAccountId, ADA);
  assert.deepEqual(ownerEntry(null, lock), { record: null, ownerAccountId: BOB });
  assert.deepEqual(ownerEntry(null, { corrupt: true }), { record: null, ownerAccountId: null });
  assert.deepEqual(ownerEntry(null, null), { record: null, ownerAccountId: null });
  assert.equal(ownerEntry(orphanOwnerRecord(owned(ADA), ORPHANED_AT), lock).ownerAccountId, null,
    'an orphaned record wins over the lock of its deleted owner');
});

test('stored owner values decode back exactly, orphaned ones included; invalid records are refused', () => {
  for (const record of [owned(ADA), owned(null, ROOM_KIND.POKER), orphanOwnerRecord(owned(ADA), ORPHANED_AT)]) {
    assert.deepEqual(decodeOwnerRecord(storedOwnerValue(record)), record);
  }
  assert.throws(() => storedOwnerValue(owned('short')), TypeError);
  assert.throws(() => storedOwnerValue({ ...owned(ADA), orphanedAt: ORPHANED_AT }), TypeError, 'only an ownerless record is orphaned');
});
