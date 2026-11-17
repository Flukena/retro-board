import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedStorage, durableMetaBatch } from './relay-storage.js';
import { RoomRegistry } from './relay-room-registry.js';
import { RoomFence } from './room-fence.js';
import {
  DELETION_JOURNAL_DOC, DeletionJournal, RoomDeletion, createRoomFileRemover,
} from './room-deletion.js';
import { ROOM_DELETED_CLOSE_CODE, ROOM_DELETED_REASON, ROOM_KIND } from '../domain/room-ownership.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');

const MAX_ROOMS = 10;
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const SIGNING_KEY_BYTES = 32;
const QUIET = { log() {}, warn() {}, error() {} };
const NO_USAGE = { complete: true, roomsByHandle: new Map() };
const GUEST = { kind: ROOM_KIND.BOARD, accountId: null };
const MARKER_META = 'retro-room-registration-v1';
const HANDLE_META = 'retro-room-handle-v1';
const E2E_META = 'e2e-head';
const IMAGE_ID = '0a1b2c3d-0000-4000-8000-000000000001.png';
const BLOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_FILE = `${'K'.repeat(32)}.${IMAGE_ID}`;
const SHORT_DRAIN_MS = 30;
const STARTED_AT = 1_800_000_000_000;
const injected = () => Object.assign(new Error('injected crash'), { code: 'STORAGE_FAILURE' });

/**
 * The relay's deletion pieces over a real LevelDB and uploads directory: registry, journal, fence and file removal are
 * real; the plain and encrypted socket owners are recorded. `inject` swaps ports to simulate a crash at one point.
 */
async function openRelay(root, inject = {}) {
  const ldb = new LeveldbPersistence(join(root, 'db'));
  const uploadsDir = join(root, 'uploads');
  await mkdir(uploadsDir, { recursive: true });
  const storage = checkedStorage(ldb, Y);
  const trace = [];
  const persistence = {
    ...storage,
    durableMetaBatch: async (docName, ops) => {
      if (ops.some((op) => op.key === MARKER_META && op.type === 'del')) {
        trace.push('unregister');
        if (inject.unregister) await inject.unregister();
      }
      await durableMetaBatch(ldb, docName, ops);
    },
    clearDocument: async (docName) => {
      trace.push('clear');
      if (inject.clear) await inject.clear(docName, ldb);
      await storage.clearDocument(docName);
    },
    hasCapacity: () => true, reserveStore: () => () => {}, measureDatabase: () => 0,
  };
  const registry = new RoomRegistry({
    persistence, Y, maxRooms: MAX_ROOMS, maxDatabaseBytes: UNLIMITED, signingKey: Buffer.alloc(SIGNING_KEY_BYTES), log: QUIET,
  });
  const journal = new DeletionJournal(ldb);
  const pending = await journal.load();
  await registry.hydrate(NO_USAGE, new Set(pending.keys()));
  const tracedJournal = {
    load: () => journal.load(),
    put: async (...args) => { trace.push('journal:put'); await journal.put(...args); },
    remove: async (...args) => { trace.push('journal:remove'); await journal.remove(...args); },
  };
  const fence = new RoomFence();
  const io = {
    readdir: async (...args) => { trace.push('files'); if (inject.readdir) await inject.readdir(); return fs.promises.readdir(...args); },
    unlink: async (path) => { if (inject.unlink) await inject.unlink(path); return fs.promises.unlink(path); },
  };
  const reconciled = { count: 0 };
  const failures = [];
  const deletion = new RoomDeletion({
    fence, journal: tracedJournal, registry, pending,
    plainRooms: { retire: async (docName, code, reason) => { trace.push(`plain:${code}:${reason}`); } },
    e2eRooms: { retireRoom: async (docName, code, reason) => { trace.push(`e2e:${code}:${reason}`); } },
    files: createRoomFileRemover({ io, uploadsDir, reconcileUploadUsage: async () => { reconciled.count += 1; } }),
    onStorageFailure: (error) => failures.push(error), log: QUIET, drainTimeoutMs: inject.drainTimeoutMs,
    now: () => STARTED_AT,
  });
  const close = () => ldb.destroy();
  return { ldb, storage, registry, journal, fence, deletion, trace, uploadsDir, reconciled, failures, close };
}

/** A guest room with extra rows (an update and an encrypted-log key) and one image and one blob file. */
async function seedRoom(relay) {
  const room = await relay.registry.createRoom({ owner: GUEST });
  const docName = relay.registry.registeredDocForCapability(room.code, room.token);
  const handle = relay.registry.roomHandleForDoc(docName);
  const extra = new Y.Doc();
  extra.getMap('items').set('note', 'hello');
  await relay.storage.storeUpdate(docName, Y.encodeStateAsUpdate(extra));
  extra.destroy();
  await relay.storage.setMeta(docName, E2E_META, 1);
  await writeFile(join(relay.uploadsDir, `${handle}.${IMAGE_ID}`), 'png');
  await writeFile(join(relay.uploadsDir, `${handle}.${BLOB_ID}.e2e`), 'blob');
  await writeFile(join(relay.uploadsDir, OTHER_FILE), 'other');
  return { ...room, docName, handle };
}

async function assertGone(relay, room) {
  assert.equal(relay.registry.registeredDocs.has(room.docName), false, 'the room is not served');
  assert.equal(relay.registry.registeredDocForCapability(room.code, room.token), null);
  assert.equal(relay.registry.existingDocNames.has(room.docName), false, 'not even a legacy upgrade can reach it');
  assert.equal((await relay.ldb.getMetas(room.docName)).size, 0, 'no meta row remains');
  const doc = await relay.storage.getYDoc(room.docName);
  assert.equal(doc.store.clients.size, 0, 'no update row remains');
  doc.destroy();
  assert.deepEqual(await readdir(relay.uploadsDir), [OTHER_FILE], 'only the other room\'s file remains');
  assert.equal((await relay.ldb.getMetas(DELETION_JOURNAL_DOC)).size, 0, 'the journal entry is gone');
}

async function withRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'room-deletion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const DELETED_CLOSE = `${ROOM_DELETED_CLOSE_CODE}:${ROOM_DELETED_REASON}`;

test('delete fences at once, then journals, unmarks, closes, drains, clears, removes files and drops the journal entry', async (t) => {
  const relay = await openRelay(await withRoot(t));
  t.after(relay.close);
  const room = await seedRoom(relay);
  relay.trace.length = 0;
  const deleting = relay.deletion.deleteRoom(room.docName);
  assert.equal(relay.fence.enter(room.docName), null, 'fenced in the same tick');
  assert.deepEqual(await deleting, { deleted: true, files: 2 });
  assert.deepEqual(relay.trace, [
    'journal:put', 'unregister', `plain:${DELETED_CLOSE}`, `e2e:${DELETED_CLOSE}`, 'clear', 'files', 'journal:remove',
  ]);
  assert.equal(relay.reconciled.count, 1);
  await assertGone(relay, room);
  assert.equal(relay.fence.isFenced(room.docName), false, 'the fence is lifted once nothing is left');
});

test('the journal entry records the handle and start time, and exists while the room is being torn down', async (t) => {
  const relay = await openRelay(await withRoot(t));
  t.after(relay.close);
  const room = await seedRoom(relay);
  let seen = null;
  relay.deletion = new RoomDeletion({
    fence: relay.fence, journal: relay.journal, registry: relay.registry, pending: new Map(),
    plainRooms: { retire: async () => { seen = await relay.journal.load(); } }, e2eRooms: { retireRoom: async () => {} },
    files: async () => 0, onStorageFailure() {}, log: QUIET, now: () => STARTED_AT,
  });
  await relay.deletion.deleteRoom(room.docName);
  assert.deepEqual(seen, new Map([[room.docName, { v: 1, handle: room.handle, startedAt: STARTED_AT }]]));
  assert.equal(await relay.storage.getMeta(room.docName, MARKER_META), undefined);
});

test('a missing room answers 404 and journals nothing', async (t) => {
  const relay = await openRelay(await withRoot(t));
  t.after(relay.close);
  assert.deepEqual(await relay.deletion.deleteRoom('yjs/board-Missing1-abcdefgh12345678'), { deleted: false, status: 404 });
  assert.deepEqual(relay.trace, []);
});

test('two deletes of one room run it once and share the result', async (t) => {
  const relay = await openRelay(await withRoot(t));
  t.after(relay.close);
  const room = await seedRoom(relay);
  relay.trace.length = 0;
  const [first, second] = await Promise.all([relay.deletion.deleteRoom(room.docName), relay.deletion.deleteRoom(room.docName)]);
  assert.deepEqual(first, second);
  assert.equal(relay.trace.filter((step) => step === 'journal:put').length, 1);
});

test('a held entry past the drain timeout answers 503, keeps journal and fence, and the next recovery finishes', async (t) => {
  const relay = await openRelay(await withRoot(t), { drainTimeoutMs: SHORT_DRAIN_MS });
  t.after(relay.close);
  const room = await seedRoom(relay);
  const release = relay.fence.enter(room.docName);
  assert.deepEqual(await relay.deletion.deleteRoom(room.docName), { deleted: false, status: 503 });
  assert.equal(relay.fence.isFenced(room.docName), true);
  assert.equal(relay.registry.registeredDocs.has(room.docName), false);
  assert.equal((await relay.journal.load()).has(room.docName), true);
  assert.ok((await relay.ldb.getMetas(room.docName)).size > 0, 'nothing is cleared while an entry is held');
  assert.deepEqual(await relay.deletion.recover(), { recovered: 0, files: 0 }, 'still held: the tick waits again');
  release();
  assert.deepEqual(await relay.deletion.recover(), { recovered: 1, files: 2 });
  await assertGone(relay, room);
});

const CRASH_POINTS = [
  ['after the journal put', { unregister: async () => { throw injected(); } }],
  ['during clear', {
    clear: async (docName, ldb) => {
      await durableMetaBatch(ldb, docName, [{ type: 'del', key: HANDLE_META }]);
      throw injected();
    },
  }],
  ['after clear', { readdir: async () => { throw injected(); } }],
  ['during file removal', (() => {
    let unlinked = 0;
    return { unlink: async () => { unlinked += 1; if (unlinked > 1) throw injected(); } };
  })()],
];

for (const [point, inject] of CRASH_POINTS) {
  test(`a crash ${point} leaves the room unservable, and recovery at the next start removes rows, files and journal`, async (t) => {
    const root = await withRoot(t);
    const first = await openRelay(root, inject);
    const room = await seedRoom(first);
    await assert.rejects(first.deletion.deleteRoom(room.docName), /injected crash/);
    await first.close();

    const second = await openRelay(root);
    t.after(second.close);
    assert.equal(second.registry.registeredDocs.has(room.docName), false, 'never registered again');
    assert.equal(second.fence.isFenced(room.docName), true, 'fenced from the start');
    assert.deepEqual(await second.deletion.recover(), { recovered: 1, files: 2 - Number(point === 'during file removal') });
    await assertGone(second, room);
  });
}

test('a crash during recovery is finished by the recovery after the next start', async (t) => {
  const root = await withRoot(t);
  const first = await openRelay(root, { unregister: async () => { throw injected(); } });
  const room = await seedRoom(first);
  await assert.rejects(first.deletion.deleteRoom(room.docName));
  await first.close();

  const second = await openRelay(root, { clear: async () => { throw injected(); } });
  assert.deepEqual(await second.deletion.recover(), { recovered: 0, files: 0 });
  assert.equal(second.failures.length, 1, 'the failed clear is reported as a storage failure');
  await second.close();

  const third = await openRelay(root);
  t.after(third.close);
  assert.equal(third.registry.registeredDocs.has(room.docName), false);
  assert.deepEqual(await third.deletion.recover(), { recovered: 1, files: 2 });
  await assertGone(third, room);
});

test('one journaled room that cannot finish does not stop recovery of the others', async (t) => {
  const root = await withRoot(t);
  const first = await openRelay(root, { unregister: async () => { throw injected(); } });
  const stuck = await seedRoom(first);
  const other = await seedRoom(first);
  await assert.rejects(first.deletion.deleteRoom(stuck.docName));
  await assert.rejects(first.deletion.deleteRoom(other.docName));
  await first.close();

  const second = await openRelay(root, { clear: async (docName) => { if (docName === stuck.docName) throw injected(); } });
  t.after(second.close);
  assert.deepEqual(await second.deletion.recover(), { recovered: 1, files: 2 });
  assert.equal((await second.journal.load()).has(stuck.docName), true);
  assert.equal((await second.journal.load()).has(other.docName), false);
});
