import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Readable, Writable, PassThrough } from 'node:stream';
import { readRelayConfig } from './relay-config.js';
import { createUploadState, scanUploadUsage, createRelayUploads, createImageReadBudgets, matchesMagicBytes, UPLOAD_STORAGE_FAILURE_EVENT } from './relay-uploads.js';
import { IMAGE_MAX_BYTES, IMAGE_SOURCE_MAX_DIMENSION, GIF_MAX_FRAMES, GIF_MAX_TOTAL_FRAME_PIXELS } from '../domain/security-boundaries.js';

const ORIGIN = 'https://allowed.example';
const CLIENT_IP = '127.0.0.1';
const ROOM_HANDLE = 'a'.repeat(32);
const DOC_NAME = 'test-room';
const IMAGE_ID = 'abcdef01.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_UPLOAD_BYTES = 1024;
const OVER_LIMIT_BYTES = MAX_UPLOAD_BYTES + 1;
const ONE_FILE = 1;
const STRICT_FIXTURE_MAX_BYTES = 4096;
const PNG_WIDTH_OFFSET_BYTES = 16;
const PNG_HEIGHT_OFFSET_BYTES = 20;
const PIXEL_BUDGET_TEST_DIMENSION_PX = 5000;
const GIF_HEADER_BYTES = 19;
const PNG_IHDR_END_BYTES = 33;
const PNG_ANIMATION_CHUNK_BYTES = 20;
const PNG_CHUNK_TYPE_OFFSET_BYTES = 4;
const PNG_ANIMATION_DATA_BYTES = 8;
const GIF_BUDGET_DIMENSION_PX = 1000;
const GIF_WIDTH_OFFSET_BYTES = 6;
const GIF_HEIGHT_OFFSET_BYTES = 8;
const GIF_FRAME_WIDTH_OFFSET_BYTES = 5;
const GIF_FRAME_HEIGHT_OFFSET_BYTES = 7;
const VALID_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const VALID_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

class Response extends Writable {
  headers = {};
  chunks = [];
  status;
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }
  setHeader(name, value) { this.headers[name] = value; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  get body() { return Buffer.concat(this.chunks); }
}

const uploadRequest = (bytes = PNG, headers = {}) => Object.assign(Readable.from([bytes]), {
  headers: { origin: ORIGIN, 'content-type': 'image/png', 'content-length': String(bytes.length), ...headers },
});

const setup = async (t, env = {}, storage = { async setMeta() {} }, strictRasterValidation = false) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-uploads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = readRelayConfig({ YJS_UPLOADS_DIR: root, YJS_MAX_UPLOAD_BYTES: String(MAX_UPLOAD_BYTES), ...env });
  const state = createUploadState(config);
  const room = { bytes: 0, files: 0, active: 0, reservedBytes: 0 };
  const roomUploadUsage = new Map([[DOC_NAME, room]]);
  const imageReads = createImageReadBudgets(config);
  const uploads = createRelayUploads({ config, state, roomUploadUsage, imageReads, storage,
    allowedOrigins: [ORIGIN], allowInsecureHttp: false, strictRasterValidation });
  return { root, config, state, room, roomUploadUsage, imageReads, uploads };
};

const sendUpload = async (uploads, req = uploadRequest()) => {
  const res = new Response();
  const finished = once(res, 'finish');
  await uploads.handleUpload(req, res, CLIENT_IP, DOC_NAME, ROOM_HANDLE);
  await finished;
  return res;
};

const readImage = async (uploads, legacy = false, imageId = IMAGE_ID) => {
  const res = new Response();
  const finished = once(res, 'finish');
  if (legacy) uploads.handleGetLegacyImage(imageId, CLIENT_IP, res);
  else uploads.handleGetRoomImage(ROOM_HANDLE, imageId, CLIENT_IP, res);
  await finished;
  return res;
};

test('magic sniff preserves shallow PNG JPEG GIF WEBP signatures and rejects mismatches', () => {
  assert.equal(matchesMagicBytes(PNG, 'image/png'), true);
  assert.equal(matchesMagicBytes(PNG.subarray(0, -1), 'image/png'), false);
  assert.equal(matchesMagicBytes(Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'), true);
  assert.equal(matchesMagicBytes(Buffer.from('GIF87a'), 'image/gif'), true);
  assert.equal(matchesMagicBytes(Buffer.from('GIF89a'), 'image/gif'), true);
  assert.equal(matchesMagicBytes(Buffer.from('RIFFxxxxWEBP'), 'image/webp'), true);
  assert.equal(matchesMagicBytes(Buffer.from('RIFFxxxxWEBX'), 'image/webp'), false);
  assert.equal(matchesMagicBytes(PNG, 'image/jpeg'), false);
  assert.equal(matchesMagicBytes(PNG, 'image/svg+xml'), false);
});

test('usage scan counts all file bytes, only image files, and room image totals', async (t) => {
  const { root, config } = await setup(t);
  await writeFile(join(root, `${ROOM_HANDLE}.${IMAGE_ID}`), PNG);
  await writeFile(join(root, IMAGE_ID), PNG);
  await writeFile(join(root, '.upload-pending.tmp'), PNG);
  await mkdir(join(root, 'ignored-directory'));
  const scanned = scanUploadUsage(config);
  assert.equal(scanned.bytes, PNG.length * 3);
  assert.equal(scanned.files, 2);
  assert.equal(scanned.complete, true);
  assert.deepEqual(scanned.roomsByHandle.get(ROOM_HANDLE), { bytes: PNG.length, files: ONE_FILE });
  const failed = scanUploadUsage({ ...config, UPLOADS_DIR: join(root, 'missing') });
  assert.equal(failed.complete, false);
  assert.equal(failed.bytes, config.MAX_UPLOAD_STORAGE_BYTES);
  assert.equal(failed.files, config.MAX_UPLOAD_FILES);
});

test('upload restart accounting counts shared hardlink bytes once while retaining every alias and room charge', async t => {
  const { root, config } = await setup(t, { YJS_MAX_UPLOAD_STORAGE_BYTES: String(MAX_UPLOAD_BYTES) });
  const oldHandle = 'b'.repeat(32);
  const original = join(root, `${oldHandle}.${IMAGE_ID}`);
  await writeFile(original, PNG);
  await link(original, join(root, `${ROOM_HANDLE}.${IMAGE_ID}`));
  const state = createUploadState(config);
  assert.equal(state.bytes, PNG.length);
  assert.equal(state.files, 2);
  assert.deepEqual(state.initialUsage.roomsByHandle.get(oldHandle), { bytes: PNG.length, files: 1 });
  assert.deepEqual(state.initialUsage.roomsByHandle.get(ROOM_HANDLE), { bytes: PNG.length, files: 1 });
  const room = { ...state.initialUsage.roomsByHandle.get(ROOM_HANDLE), active: 0, reservedBytes: 0 };
  const uploads = createRelayUploads({ config, state, roomUploadUsage: new Map([[DOC_NAME, room]]),
    imageReads: createImageReadBudgets(config), storage: { async setMeta() {} },
    allowedOrigins: [ORIGIN], allowInsecureHttp: false });
  const body = Buffer.alloc(MAX_UPLOAD_BYTES - PNG.length);
  PNG.copy(body);
  assert.equal((await sendUpload(uploads, uploadRequest(body))).status, 200);
  assert.equal(state.bytes, MAX_UPLOAD_BYTES);
});

test('strict public uploads reject malformed and excessive raster headers before publish and release reservations', async t => {
  const records = [];
  const { uploads, root, state, room } = await setup(t, { YJS_MAX_UPLOAD_BYTES: String(STRICT_FIXTURE_MAX_BYTES) },
    { async setMeta(...args) { records.push(args); } }, true);
  const hugeDimension = Buffer.from(VALID_PNG);
  hugeDimension.writeUInt32BE(IMAGE_SOURCE_MAX_DIMENSION + 1, PNG_WIDTH_OFFSET_BYTES);
  const hugePixels = Buffer.from(VALID_PNG);
  hugePixels.writeUInt32BE(PIXEL_BUDGET_TEST_DIMENSION_PX, PNG_WIDTH_OFFSET_BYTES);
  hugePixels.writeUInt32BE(PIXEL_BUDGET_TEST_DIMENSION_PX, PNG_HEIGHT_OFFSET_BYTES);
  const tooManyFrames = Buffer.concat([VALID_GIF.subarray(0, GIF_HEADER_BYTES),
    ...Array(GIF_MAX_FRAMES + 1).fill(VALID_GIF.subarray(GIF_HEADER_BYTES, -1)), VALID_GIF.subarray(-1)]);
  const gifHeader = Buffer.from(VALID_GIF.subarray(0, GIF_HEADER_BYTES));
  gifHeader.writeUInt16LE(GIF_BUDGET_DIMENSION_PX, GIF_WIDTH_OFFSET_BYTES);
  gifHeader.writeUInt16LE(GIF_BUDGET_DIMENSION_PX, GIF_HEIGHT_OFFSET_BYTES);
  const gifFrame = Buffer.from(VALID_GIF.subarray(GIF_HEADER_BYTES, -1));
  gifFrame.writeUInt16LE(GIF_BUDGET_DIMENSION_PX, GIF_FRAME_WIDTH_OFFSET_BYTES);
  gifFrame.writeUInt16LE(GIF_BUDGET_DIMENSION_PX, GIF_FRAME_HEIGHT_OFFSET_BYTES);
  const overBudgetFrames = Math.floor(GIF_MAX_TOTAL_FRAME_PIXELS / (GIF_BUDGET_DIMENSION_PX ** 2)) + 1;
  const hugeAnimation = Buffer.concat([gifHeader, ...Array(overBudgetFrames).fill(gifFrame), VALID_GIF.subarray(-1)]);
  const animationChunk = Buffer.alloc(PNG_ANIMATION_CHUNK_BYTES);
  animationChunk.writeUInt32BE(PNG_ANIMATION_DATA_BYTES);
  animationChunk.write('acTL', PNG_CHUNK_TYPE_OFFSET_BYTES);
  const animatedPng = Buffer.concat([VALID_PNG.subarray(0, PNG_IHDR_END_BYTES), animationChunk, VALID_PNG.subarray(PNG_IHDR_END_BYTES)]);
  for (const [bytes, mime] of [[PNG, 'image/png'], [hugeDimension, 'image/png'],
    [hugePixels, 'image/png'], [tooManyFrames, 'image/gif'], [hugeAnimation, 'image/gif'], [animatedPng, 'image/png']]) {
    const res = await sendUpload(uploads, uploadRequest(bytes, { 'content-type': mime }));
    assert.equal(res.status, 422);
    assert.equal(state.active, 0);
    assert.equal(state.reservedBytes, 0);
    assert.equal(state.bytes, 0);
    assert.equal(state.files, 0);
    assert.equal(room.active, 0);
    assert.equal(room.reservedBytes, 0);
    assert.deepEqual(await readdir(root), []);
  }
  assert.deepEqual(records, []);
  assert.equal((await sendUpload(uploads, uploadRequest(VALID_PNG))).status, 200);
  assert.equal((await sendUpload(uploads, uploadRequest(VALID_GIF, { 'content-type': 'image/gif' }))).status, 200);
});

test('strict public upload byte limits remain five MiB even when private upload configuration allows more', async t => {
  const oversizedBytes = IMAGE_MAX_BYTES + 1;
  const { uploads, root, state } = await setup(t, { YJS_MAX_UPLOAD_BYTES: String(oversizedBytes) }, undefined, true);
  const body = Buffer.alloc(oversizedBytes);
  PNG.copy(body);
  assert.equal((await sendUpload(uploads, uploadRequest(body))).status, 413);
  assert.equal(state.active, 0);
  assert.equal(state.reservedBytes, 0);
  assert.deepEqual(await readdir(root), []);
});

test('upload publishes atomically, persists accounting and releases reservations', async (t) => {
  const records = [];
  const { uploads, state, room, root } = await setup(t, {}, {
    async setMeta(...record) { records.push(record); },
  });
  const res = await sendUpload(uploads);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-length'], undefined);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  const { url } = JSON.parse(res.body.toString());
  assert.match(url, new RegExp(`^/rooms/${ROOM_HANDLE}/images/[a-f0-9-]+\\.png$`));
  const filename = `${ROOM_HANDLE}.${url.split('/').pop()}`;
  assert.deepEqual(await readFile(join(root, filename)), PNG);
  assert.deepEqual(await readdir(root), [filename]);
  assert.deepEqual(records, [[DOC_NAME, 'retro-room-upload-usage-v1', { bytes: PNG.length, files: ONE_FILE }]]);
  assert.deepEqual(room, { bytes: PNG.length, files: ONE_FILE, active: 0, reservedBytes: 0 });
  assert.equal(state.bytes, PNG.length);
  assert.equal(state.files, ONE_FILE);
  assert.equal(state.active, 0);
  assert.equal(state.reservedBytes, 0);
  assert.equal(state.activeByIp.size, 0);
});

test('upload validation preserves origin then token then media then length precedence', async (t) => {
  const { uploads, state } = await setup(t);
  const denied = await sendUpload(uploads, uploadRequest(PNG, { origin: 'https://hostile.example', 'content-type': 'text/plain' }));
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.headers, {});
  assert.equal(state.buckets.size, 0);
  const media = await sendUpload(uploads, uploadRequest(PNG, { 'content-type': 'image/svg+xml', 'content-length': 'NaN' }));
  assert.equal(media.status, 415);
  assert.equal(media.body.toString(), 'unsupported media type');
  assert.equal(media.headers['content-type'], 'text/plain');
  const length = await sendUpload(uploads, uploadRequest(PNG, { 'content-length': 'NaN' }));
  assert.equal(length.status, 400);
  const large = await sendUpload(uploads, uploadRequest(PNG, { 'content-length': String(OVER_LIMIT_BYTES) }));
  assert.equal(large.status, 413);
  state.buckets.set(CLIENT_IP, { tokens: 0, last: Date.now(), lastSeen: Date.now() });
  const token = await sendUpload(uploads, uploadRequest(PNG, { 'content-type': 'text/plain' }));
  assert.equal(token.status, 429);
  assert.equal(token.headers['retry-after'], undefined);
});

test('upload quotas retain concurrency, missing room, global and room precedence', async (t) => {
  const { uploads, state, room, roomUploadUsage, config } = await setup(t);
  state.active = config.MAX_ACTIVE_UPLOADS;
  assert.equal((await sendUpload(uploads)).headers['retry-after'], '2');
  state.active = 0;
  roomUploadUsage.delete(DOC_NAME);
  state.files = config.MAX_UPLOAD_FILES;
  assert.equal((await sendUpload(uploads)).status, 404);
  roomUploadUsage.set(DOC_NAME, room);
  room.files = config.MAX_ROOM_UPLOAD_FILES;
  assert.equal((await sendUpload(uploads)).body.toString(), 'upload capacity reached');
  state.files = 0;
  assert.equal((await sendUpload(uploads)).body.toString(), 'room upload capacity reached');
  assert.equal(state.reservedBytes, 0);
});

test('invalid magic is 422, streamed excess is 413, and private temp files are removed', async (t) => {
  const { uploads, state, room, root } = await setup(t);
  const invalid = await sendUpload(uploads, uploadRequest(Buffer.from('invalid')));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.toString(), 'invalid image data');
  assert.equal(invalid.headers['content-type'], 'text/plain');
  const largeRequest = uploadRequest(Buffer.alloc(OVER_LIMIT_BYTES));
  delete largeRequest.headers['content-length'];
  const large = await sendUpload(uploads, largeRequest);
  assert.equal(large.status, 413);
  assert.equal(large.body.length, 0);
  assert.deepEqual(await readdir(root), []);
  assert.equal(state.bytes, 0);
  assert.equal(state.active, 0);
  assert.equal(room.active, 0);
});

test('metadata failure emits the original error before rollback and removes published bytes', async (t) => {
  const failure = new Error('test storage failure');
  const { uploads, state, room, root } = await setup(t, {}, { async setMeta() { throw failure; } });
  let observed;
  let bytesAtFailure;
  state.events.on(UPLOAD_STORAGE_FAILURE_EVENT, (err) => { observed = err; bytesAtFailure = state.bytes; });
  const res = await sendUpload(uploads);
  assert.equal(res.status, 500);
  assert.equal(observed, failure);
  assert.equal(bytesAtFailure, PNG.length);
  assert.deepEqual(await readdir(root), []);
  assert.equal(state.bytes, 0);
  assert.equal(state.files, 0);
  assert.equal(state.active, 0);
  assert.deepEqual(room, { bytes: 0, files: 0, active: 0, reservedBytes: 0 });
});

test('room and legacy image streaming preserve bytes, headers and invalid-name rejection', async (t) => {
  const { root, uploads } = await setup(t);
  await writeFile(join(root, `${ROOM_HANDLE}.${IMAGE_ID}`), PNG);
  await writeFile(join(root, IMAGE_ID), PNG);
  const room = await readImage(uploads);
  assert.equal(room.status, 200);
  assert.deepEqual(room.body, PNG);
  assert.deepEqual(room.headers, { 'content-type': 'image/png', 'content-length': PNG.length,
    'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  const legacy = await readImage(uploads, true);
  assert.equal(legacy.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.deepEqual(legacy.body, PNG);
  assert.equal((await readImage(uploads, false, '../secret.png')).status, 404);
  assert.equal((await readImage(uploads, true, '../secret.png')).status, 404);
  assert.equal((await readImage(uploads, false, '0000.png')).status, 404);
});

test('image read shortage returns 429 with exact retry and cache headers', async (t) => {
  const { root, uploads } = await setup(t, { YJS_IMAGE_READ_BURST_BYTES: '1', YJS_IMAGE_READ_BYTES_PER_SECOND: '1' });
  await writeFile(join(root, `${ROOM_HANDLE}.${IMAGE_ID}`), PNG);
  const res = await readImage(uploads);
  assert.equal(res.status, 429);
  assert.equal(res.body.length, 0);
  assert.deepEqual(res.headers, { 'retry-after': '2', 'cache-control': 'no-store' });
});

test('failed published-file removal keeps conservative usage while releasing reservations', async (t) => {
  let root;
  const fixture = await setup(t, {}, {
    async setMeta() {
      const [filename] = (await readdir(root)).filter((name) => name.endsWith('.png'));
      const path = join(root, filename);
      await rm(path);
      await mkdir(path);
      await writeFile(join(path, 'occupied'), PNG);
      throw new Error('test metadata failure');
    },
  });
  root = fixture.root;
  fixture.state.events.on(UPLOAD_STORAGE_FAILURE_EVENT, () => {});
  const res = await sendUpload(fixture.uploads);
  assert.equal(res.status, 500);
  assert.equal(fixture.state.bytes, PNG.length);
  assert.equal(fixture.state.files, ONE_FILE);
  assert.equal(fixture.room.bytes, PNG.length);
  assert.equal(fixture.room.files, ONE_FILE);
  assert.equal(fixture.state.active, 0);
  assert.equal(fixture.room.active, 0);
});

test('in-flight byte reservations prevent a concurrent upload from exceeding room capacity', async (t) => {
  const { uploads, room, state } = await setup(t, { YJS_MAX_ROOM_UPLOAD_BYTES: String(MAX_UPLOAD_BYTES) });
  const req = new PassThrough();
  req.headers = { origin: ORIGIN, 'content-type': 'image/png', 'content-length': String(MAX_UPLOAD_BYTES) };
  const first = sendUpload(uploads, req);
  assert.equal(room.active, ONE_FILE);
  assert.equal(room.reservedBytes, MAX_UPLOAD_BYTES);
  assert.equal(room.bytes, 0);
  const concurrent = await sendUpload(uploads);
  assert.equal(concurrent.status, 507);
  assert.equal(concurrent.body.toString(), 'room upload capacity reached');
  req.end(PNG);
  assert.equal((await first).status, 200);
  assert.equal(state.active, 0);
  assert.equal(room.reservedBytes, 0);
  assert.equal((await sendUpload(uploads)).status, 200);
});
