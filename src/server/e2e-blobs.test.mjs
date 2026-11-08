import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempRoot } from '../test-support/relay-harness.mjs';
import { ORIGIN, PASSWORD, createLockedRoom as createLockedRoomWith, createNormalRoom, lockedRelay } from '../test-support/locked-room-harness.mjs';
import { createRoomLock } from '../client/room-lock/e2e-crypto.js';
import { normalizeRoomFetchPath } from '../client/session/room-session.js';
import { IMAGE_MAX_BYTES } from '../domain/security-boundaries.js';
import { E2E_CIPHERTEXT_OVERHEAD_BYTES } from '../domain/e2e-envelope.js';
import { ROOM_LOCK_META, decodeLockRecord, encodeLockRecord } from './room-lock-record.js';
import { ROOM_UPLOAD_USAGE_META, e2eBlobFilename } from './relay-uploads.js';
import { E2E_ORPHAN_MIN_AGE_MS } from './e2e-blob-store.js';

const require = createRequire(import.meta.url);
const { LeveldbPersistence } = require('y-leveldb');

const ROOM_LOCK = await createRoomLock(PASSWORD);
const BLOB_LIMIT_BYTES = IMAGE_MAX_BYTES + 256 + E2E_CIPHERTEXT_OVERHEAD_BYTES;
const STATUS = Object.freeze({ OK: 200, CREATED: 201, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, TOO_LARGE: 413, UNSUPPORTED: 415 });
const BLOB_BYTES = 200;
const RACERS = 6;
const FOREIGN_ORIGIN = 'https://evil.example';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ROTATED_EPOCH = 1;
const BURST_ENV = Object.freeze({ YJS_MAX_ACTIVE_UPLOADS: '16', YJS_MAX_ACTIVE_UPLOADS_PER_IP: '16', YJS_UPLOAD_BURST: '100' });

const createLockedRoom = (env) => createLockedRoomWith(env, ROOM_LOCK);
const blobsUrl = (relay, room, id = '') => `${relay.url}/rooms/${room.handle}/e2e-blobs${id ? `/${id}` : ''}`;
const cipher = (fill, length = BLOB_BYTES) => Buffer.alloc(length, fill);
const upload = (relay, room, id, body, { cookie = room.cookie, headers = {} } = {}) => fetch(blobsUrl(relay, room), {
  method: 'POST',
  headers: { origin: ORIGIN, 'content-type': 'application/octet-stream', 'x-blob-id': id, ...(cookie ? { cookie } : {}), ...headers },
  body,
});
const download = (relay, room, id, cookie = room.cookie) => fetch(blobsUrl(relay, room, id), { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const uploadsDir = (relay) => join(relay.root, 'uploads');
const e2eFiles = async (relay) => (await readdir(uploadsDir(relay))).filter((name) => name.endsWith('.e2e')).sort();

async function storedMetas(relay, docName) {
  const ldb = new LeveldbPersistence(relay.dbDir);
  try {
    return { inventory: await ldb.getMeta(docName, 'e2e-blobs'), usage: await ldb.getMeta(docName, ROOM_UPLOAD_USAGE_META) };
  } finally {
    await ldb.destroy();
  }
}

async function editStore(relay, docName, edit) {
  const ldb = new LeveldbPersistence(relay.dbDir);
  try {
    await edit(ldb, docName);
  } finally {
    await ldb.destroy();
  }
}

test('a ciphertext blob round-trips with private headers, is inventoried and counted, and survives a restart scan', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const room = await createLockedRoom(env);
  const id = randomUUID();
  const body = cipher(7);
  const created = await upload(env.relay, room, id, body);
  assert.equal(created.status, STATUS.CREATED, env.relay.output());
  assert.deepEqual(await created.json(), { id });
  assert.equal(created.headers.get('access-control-allow-origin'), ORIGIN);

  const fetched = await download(env.relay, room, id);
  assert.equal(fetched.status, STATUS.OK);
  assert.equal(fetched.headers.get('content-type'), 'application/octet-stream');
  assert.equal(fetched.headers.get('cache-control'), 'private, no-store');
  assert.equal(fetched.headers.get('access-control-allow-credentials'), 'true');
  assert.ok(Buffer.from(await fetched.arrayBuffer()).equals(body));
  assert.deepEqual(await e2eFiles(env.relay), [e2eBlobFilename(room.handle, id)]);

  await env.relay.stop();
  const stored = await storedMetas(env.relay, room.docName);
  assert.deepEqual(stored.inventory, [{ id, bytes: BLOB_BYTES, epoch: 0, stagedFor: null }]);
  assert.deepEqual(stored.usage, { bytes: BLOB_BYTES, files: 1 });

  await editStore(env.relay, room.docName, (ldb, docName) => ldb.setMeta(docName, ROOM_UPLOAD_USAGE_META, { bytes: 0, files: 0 }));
  const restarted = await lockedRelay(t, {}, { root });
  await restarted.relay.stop();
  assert.deepEqual((await storedMetas(restarted.relay, room.docName)).usage, { bytes: BLOB_BYTES, files: 1 }, 'startup scan counts the .e2e file');
});

test('blob routes answer 404 for a normal room, 401 without a current-epoch cookie, 400/415 for bad requests, 413 when too large', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const normal = await createNormalRoom(env.relay);
  const room = await createLockedRoom(env);
  const id = randomUUID();
  assert.equal((await upload(env.relay, normal, id, cipher(1))).status, STATUS.NOT_FOUND);
  assert.equal((await download(env.relay, normal, id)).status, STATUS.NOT_FOUND);
  assert.equal((await upload(env.relay, room, id, cipher(1), { cookie: null })).status, STATUS.UNAUTHORIZED);
  assert.equal((await download(env.relay, room, id, null)).status, STATUS.UNAUTHORIZED);

  assert.equal((await upload(env.relay, room, 'not-a-uuid', cipher(1))).status, STATUS.BAD_REQUEST);
  assert.equal((await upload(env.relay, room, randomUUID().toUpperCase(), cipher(1))).status, STATUS.BAD_REQUEST);
  assert.equal((await upload(env.relay, room, id, cipher(1), { headers: { 'x-blob-stage': 'nope' } })).status, STATUS.BAD_REQUEST);
  assert.equal((await upload(env.relay, room, id, cipher(1, E2E_CIPHERTEXT_OVERHEAD_BYTES - 1))).status, STATUS.BAD_REQUEST);
  assert.equal((await upload(env.relay, room, id, cipher(1), { headers: { 'content-type': 'image/png' } })).status, STATUS.UNSUPPORTED);
  assert.equal((await download(env.relay, room, 'not-a-uuid')).status, STATUS.NOT_FOUND);
  assert.equal((await download(env.relay, room, randomUUID())).status, STATUS.NOT_FOUND);

  assert.equal((await upload(env.relay, room, id, cipher(2, BLOB_LIMIT_BYTES + 1))).status, STATUS.TOO_LARGE);
  assert.equal((await upload(env.relay, room, id, cipher(2, BLOB_LIMIT_BYTES))).status, STATUS.CREATED);
  assert.deepEqual((await readdir(uploadsDir(env.relay))).filter((name) => name.endsWith('.tmp')), []);

  await env.relay.stop();
  await editStore(env.relay, room.docName, async (ldb, docName) => {
    await ldb.setMeta(docName, ROOM_LOCK_META, encodeLockRecord({ ...decodeLockRecord(await ldb.getMeta(docName, ROOM_LOCK_META)), keyEpoch: ROTATED_EPOCH }));
  });
  const rotated = await lockedRelay(t, {}, { root });
  assert.equal((await upload(rotated.relay, room, randomUUID(), cipher(1))).status, STATUS.UNAUTHORIZED, 'old-epoch cookie cannot upload');
  assert.equal((await download(rotated.relay, room, id)).status, STATUS.UNAUTHORIZED, 'old-epoch cookie cannot read');
});

test('a duplicate id is 409 and keeps the original bytes; concurrent uploads of one id give exactly one 201', async (t) => {
  const env = await lockedRelay(t, BURST_ENV);
  const room = await createLockedRoom(env);
  const id = randomUUID();
  assert.equal((await upload(env.relay, room, id, cipher(1))).status, STATUS.CREATED);
  assert.equal((await upload(env.relay, room, id, cipher(2))).status, STATUS.CONFLICT);
  assert.ok(Buffer.from(await (await download(env.relay, room, id)).arrayBuffer()).equals(cipher(1)), 'original bytes unchanged');

  const raced = randomUUID();
  const results = await Promise.all(Array.from({ length: RACERS }, (_, i) => upload(env.relay, room, raced, cipher(10 + i))));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [STATUS.CREATED, ...Array(RACERS - 1).fill(STATUS.CONFLICT)]);
  const winner = 10 + results.findIndex((r) => r.status === STATUS.CREATED);
  assert.ok(Buffer.from(await (await download(env.relay, room, raced)).arrayBuffer()).equals(cipher(winner)));
  assert.equal((await e2eFiles(env.relay)).length, 2);
});

test('the plaintext /upload route is refused for a locked room and still works for a normal room', async (t) => {
  const env = await lockedRelay(t);
  const locked = await createLockedRoom(env);
  const normal = await createNormalRoom(env.relay);
  const plainUpload = (room) => fetch(`${env.relay.url}/rooms/${room.handle}/upload`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'image/png', cookie: room.cookie }, body: PNG_SIGNATURE,
  });
  assert.equal((await plainUpload(locked)).status, STATUS.FORBIDDEN);
  assert.equal((await plainUpload(normal)).status, STATUS.OK);
  assert.deepEqual((await readdir(uploadsDir(env.relay))).filter((name) => /\.png$/.test(name) && name.startsWith(locked.handle)), []);
});

test('fetch-style preflight allows the blob headers for an allowed origin, refuses a foreign one, and 404s an unknown room', async (t) => {
  const env = await lockedRelay(t);
  const room = await createLockedRoom(env);
  const preflight = (origin, handle = room.handle) => fetch(`${env.relay.url}/rooms/${handle}/e2e-blobs`, {
    method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-blob-id,x-blob-stage' },
  });
  const allowed = await preflight(ORIGIN);
  assert.equal(allowed.status, STATUS.NO_CONTENT);
  assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  const allowedHeaders = allowed.headers.get('access-control-allow-headers').toLowerCase().split(/,\s*/);
  assert.ok(['content-type', 'x-blob-id', 'x-blob-stage'].every((name) => allowedHeaders.includes(name)));
  assert.equal((await preflight(FOREIGN_ORIGIN)).status, STATUS.FORBIDDEN);
  assert.equal((await preflight(ORIGIN, 'B'.repeat(32))).status, STATUS.NOT_FOUND);
});

test('the client roomFetch path accepts blob paths, and the id travels in a header because queries are rejected', () => {
  const id = randomUUID();
  assert.equal(normalizeRoomFetchPath('e2e-blobs'), '/e2e-blobs');
  assert.equal(normalizeRoomFetchPath(`e2e-blobs/${id}`), `/e2e-blobs/${id}`);
  assert.throws(() => normalizeRoomFetchPath(`e2e-blobs?id=${id}`));
});

test('startup removes only unreferenced, old .e2e files and keeps the inventoried and the young ones', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const room = await createLockedRoom(env);
  const kept = randomUUID();
  assert.equal((await upload(env.relay, room, kept, cipher(3))).status, STATUS.CREATED);
  await env.relay.stop();

  const names = {
    inventoried: e2eBlobFilename(room.handle, kept),
    oldOrphan: e2eBlobFilename(room.handle, randomUUID()),
    youngOrphan: e2eBlobFilename(room.handle, randomUUID()),
  };
  const now = Date.now();
  const ages = { inventoried: 3 * E2E_ORPHAN_MIN_AGE_MS, oldOrphan: 2 * E2E_ORPHAN_MIN_AGE_MS, youngOrphan: E2E_ORPHAN_MIN_AGE_MS / 6 };
  for (const [label, name] of Object.entries(names)) {
    const path = join(uploadsDir(env.relay), name);
    if (label !== 'inventoried') await writeFile(path, cipher(9));
    const at = new Date(now - ages[label]);
    await utimes(path, at, at);
  }
  const restarted = await lockedRelay(t, {}, { root });
  await restarted.relay.stop();
  assert.deepEqual(await e2eFiles(restarted.relay), [names.inventoried, names.youngOrphan].sort());
  assert.match(restarted.relay.output(), /e2e orphan blob sweep.*removed: 1/s);
  assert.deepEqual((await storedMetas(restarted.relay, room.docName)).usage, { bytes: BLOB_BYTES + BLOB_BYTES, files: 2 }, 'usage reconciled to the files that remain');
});

test('the one-shot image migration skips an encrypted room and still migrates a normal one', async (t) => {
  const root = await tempRoot(t);
  const env = await lockedRelay(t, {}, { root });
  const locked = await createLockedRoom(env);
  const normal = await createNormalRoom(env.relay);
  await env.relay.stop();
  const restarted = await lockedRelay(t, { YJS_MIGRATE_DOCS: `${locked.docName},${normal.docName}` }, { root });
  const output = restarted.relay.output();
  assert.match(output, /migration skipped: room is end-to-end encrypted/);
  assert.equal(output.match(/migrated doc/g)?.length, 1, 'only the normal room is migrated');
});
