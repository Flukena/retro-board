import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { restorePublicWall } from './src/server/public-wall-restore.js';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const ORIGIN = 'https://wall.example';
const START_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const WRITER_COUNT = 32;
const REQUIRED_PUBLIC_CONNECTION_COUNT = 500;
const SYNC_MESSAGE_TYPE = 0;
const SYNC_UPDATE_TYPE = 2;
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const TEST_MAX_UPLOAD_BYTES = 1024;
const INCOMPLETE_PNG_HEADER_BYTES = 8;
const readProfile = async name => Object.fromEntries((await readFile(new URL(`./config/${name}`, import.meta.url), 'utf8'))
  .split('\n').filter(line => /^YJS_[A-Z_]+=\d+$/.test(line)).map(line => line.split('=')));
const PROFILE = await readProfile('room-capacity.env');
const PUBLIC_PROFILE = await readProfile('public-room-capacity.env');

async function relay(t, root, publicWall = true, environment = {}) {
  const directory = root || await mkdtemp(join(tmpdir(), 'public-relay-'));
  if (!root) t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['yjs-server.mjs'], {
    env: { ...process.env, ...PROFILE, ...(publicWall ? PUBLIC_PROFILE : {}), YJS_PUBLIC_WALL: String(publicWall), YJS_PORT: '0', YJS_HOST: '127.0.0.1',
      YJS_DB_DIR: join(directory, 'db'), YJS_UPLOADS_DIR: join(directory, 'uploads'), YJS_ALLOWED_ORIGINS: ORIGIN,
      YJS_ALLOW_INSECURE_HTTP: 'false', YJS_ALLOW_LEGACY_URL_TOKENS: 'false', YJS_ALLOW_LEGACY_ROOMS: 'false',
      YJS_WIPE_DOCS: '', YJS_MIGRATE_DOCS: '', ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const port = await new Promise((resolvePort, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Relay startup timeout')); }, START_TIMEOUT_MS);
    const inspect = chunk => {
      output += chunk;
      const match = output.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); child.off('exit', onExit); child.stdout.off('data', inspect); resolvePort(Number(match[1])); }
    };
    const onExit = code => { clearTimeout(timeout); reject(new Error(`Relay exited ${code}: ${output}`)); };
    child.once('exit', onExit);
    child.stdout.on('data', inspect);
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const done = once(child, 'exit');
    const timeout = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_TIMEOUT_MS);
    child.kill('SIGTERM');
    try { const [code] = await done; assert.equal(code, 0, output); }
    finally { clearTimeout(timeout); }
  };
  t.after(stop);
  return { base: `http://127.0.0.1:${port}`, root: directory, stop };
}
const requestSession = (server, origin = ORIGIN) => fetch(`${server.base}/yjs-public/api/public-session`, {
  method: 'POST', headers: { origin },
});
async function session(server) {
  const response = await requestSession(server);
  assert.equal(response.status, 200);
  return { ...await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
}
async function writer(t, server, credentials) {
  const ws = new WebSocket(`${server.base.replace('http:', 'ws:')}/yjs-public/rooms/${credentials.roomHandle}`, {
    headers: { origin: ORIGIN, cookie: credentials.cookie },
  });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return ws;
}

async function sendBoardUpdate(ws, doc) {
  const echoed = new Promise(resolveEcho => {
    const inspect = data => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(decoder) === SYNC_MESSAGE_TYPE && decoding.readVarUint(decoder) === SYNC_UPDATE_TYPE) {
        ws.off('message', inspect); resolveEcho();
      }
    };
    ws.on('message', inspect);
  });
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, SYNC_MESSAGE_TYPE);
  encoding.writeVarUint(message, SYNC_UPDATE_TYPE);
  encoding.writeVarUint8Array(message, Y.encodeStateAsUpdate(doc));
  ws.send(encoding.toUint8Array(message));
  await echoed;
}

test('public process provisions once, rejects private APIs and enforces session origin across restart', async t => {
  const server = await relay(t);
  const credentials = await session(server);
  assert.deepEqual(Object.keys(credentials).sort(), ['cookie', 'expiresAt', 'roomHandle']);
  assert.equal((await requestSession(server, 'https://evil.example')).status, 403);
  assert.equal((await fetch(`${server.base}/yjs-public/api/rooms`, { method: 'POST', headers: { origin: ORIGIN } })).status, 404);
  await server.stop();
  const restarted = await relay(t, server.root);
  assert.equal((await session(restarted)).roomHandle, credentials.roomHandle);
});

test('public signed uploads preserve raster validation and expose only own-room images anonymously', async t => {
  const server = await relay(t, null, true, { YJS_UPLOAD_BURST: '100', YJS_MAX_UPLOAD_BYTES: String(TEST_MAX_UPLOAD_BYTES) });
  const credentials = await session(server);
  const uploadPath = `/yjs-public/rooms/${credentials.roomHandle}/upload`;
  const upload = (headers = {}, body = PNG_BYTES, path = uploadPath) => fetch(`${server.base}${path}`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: credentials.cookie, 'content-type': 'image/png', ...headers }, body,
  });
  const uploaded = await upload();
  assert.equal(uploaded.status, 200);
  const { url } = await uploaded.json();
  assert.equal((await upload({ cookie: '' })).status, 401);
  assert.equal((await upload({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await upload({ origin: '' })).status, 403);
  assert.equal((await upload({ 'content-type': 'image/svg+xml' })).status, 415);
  assert.equal((await upload({}, Buffer.from('not an image'))).status, 422);
  assert.equal((await upload({}, PNG_BYTES.subarray(0, INCOMPLETE_PNG_HEADER_BYTES))).status, 422);
  assert.equal((await upload({}, Buffer.alloc(TEST_MAX_UPLOAD_BYTES + 1))).status, 413);
  assert.equal((await upload({}, PNG_BYTES, `${uploadPath}?query=invalid`)).status, 404);
  const preflight = await fetch(`${server.base}${uploadPath}`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  const imageURL = `${server.base}/yjs-public${url}`;
  const anonymous = await fetch(imageURL);
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await anonymous.arrayBuffer()), PNG_BYTES);
  const corsImage = await fetch(imageURL, { headers: { origin: ORIGIN } });
  assert.equal(corsImage.status, 200);
  assert.equal(corsImage.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await fetch(imageURL, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${imageURL}?invalid=1`)).status, 404);
  const otherHandle = `${credentials.roomHandle[0] === 'A' ? 'B' : 'A'}${credentials.roomHandle.slice(1)}`;
  assert.equal((await fetch(imageURL.replace(credentials.roomHandle, otherHandle))).status, 404);
  assert.equal((await fetch(`${server.base}/yjs-public/images/${url.split('/').at(-1)}`)).status, 404);
  assert.equal((await fetch(`${server.base}/yjs-public/rooms/${credentials.roomHandle}/images/bad.svg`)).status, 404);
});

test('public media retains shared room upload quota and anonymous image read budgets', async t => {
  const server = await relay(t, null, true, { YJS_MAX_ROOM_UPLOAD_FILES: '1', YJS_IMAGE_READ_BURST: '1',
    YJS_IMAGE_READS_PER_SECOND: '1', YJS_UPLOAD_BURST: '100' });
  const credentials = await session(server);
  const upload = () => fetch(`${server.base}/yjs-public/rooms/${credentials.roomHandle}/upload`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: credentials.cookie, 'content-type': 'image/png' }, body: PNG_BYTES,
  });
  const first = await upload();
  assert.equal(first.status, 200);
  const { url } = await first.json();
  assert.equal((await upload()).status, 507);
  assert.equal((await fetch(`${server.base}/yjs-public${url}`)).status, 200);
  const limited = await fetch(`${server.base}/yjs-public${url}`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('cache-control'), 'no-store');
});

test('offline public restore rotates image URLs without copying bytes and rejects stale media handles and sessions', async t => {
  const server = await relay(t);
  const credentials = await session(server);
  const uploaded = await fetch(`${server.base}/yjs-public/rooms/${credentials.roomHandle}/upload`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: credentials.cookie, 'content-type': 'image/png' }, body: PNG_BYTES,
  });
  assert.equal(uploaded.status, 200);
  const { url } = await uploaded.json();
  const imageId = url.split('/').at(-1);
  const ws = await writer(t, server, credentials);
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  doc.getMap('items').set('image', new Y.Map(Object.entries({ type: 'image', x: 0, y: 0, w: 100, h: 100,
    src: `/yjs-public${url}` })));
  await sendBoardUpdate(ws, doc);
  const snapshotDirectory = join(server.root, 'db', 'snapshots');
  await mkdir(snapshotDirectory, { recursive: true });
  const snapshot = join(snapshotDirectory, `wall-${Date.now()}.bin`);
  await writeFile(snapshot, Y.encodeStateAsUpdate(doc));
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  await server.stop();
  const previousUploads = process.env.YJS_UPLOADS_DIR;
  process.env.YJS_UPLOADS_DIR = join(server.root, 'uploads');
  try { await restorePublicWall(join(server.root, 'db'), snapshot); }
  finally {
    if (previousUploads === undefined) delete process.env.YJS_UPLOADS_DIR;
    else process.env.YJS_UPLOADS_DIR = previousUploads;
  }
  const restarted = await relay(t, server.root);
  const fresh = await session(restarted);
  assert.notEqual(fresh.roomHandle, credentials.roomHandle);
  const preview = await fetch(`${restarted.base}/yjs-public/api/snapshot`);
  const source = (await preview.json()).items.find(item => item.id === 'image')?.src;
  assert.equal(source, `/yjs-public/rooms/${fresh.roomHandle}/images/${imageId}`);
  const image = await fetch(`${restarted.base}${source}`);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG_BYTES);
  const originalFile = join(server.root, 'uploads', `${credentials.roomHandle}.${imageId}`);
  const restoredFile = join(server.root, 'uploads', `${fresh.roomHandle}.${imageId}`);
  const [original, restored] = await Promise.all([stat(originalFile), stat(restoredFile)]);
  assert.equal(restored.ino, original.ino);
  assert.equal(restored.dev, original.dev);
  assert.equal((await fetch(`${restarted.base}/yjs-public${url}`)).status, 404);
  const staleUpload = await fetch(`${restarted.base}/yjs-public/rooms/${fresh.roomHandle}/upload`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: credentials.cookie, 'content-type': 'image/png' }, body: PNG_BYTES,
  });
  assert.equal(staleUpload.status, 401);
});

test('public admission allows500 connections and rejects501 while existing sessions renew', async t => {
  const server = await relay(t);
  const credentials = await session(server);
  for (let index = 0; index < REQUIRED_PUBLIC_CONNECTION_COUNT; index++) await writer(t, server, credentials);
  assert.equal((await requestSession(server)).status, 429);
  const refused = new WebSocket(`${server.base.replace('http:', 'ws:')}/yjs-public/rooms/${credentials.roomHandle}`, {
    headers: { origin: ORIGIN, cookie: credentials.cookie },
  });
  t.after(() => refused.terminate());
  const status = await new Promise((resolveStatus, reject) => {
    refused.once('unexpected-response', (_req, response) => { response.resume(); resolveStatus(response.statusCode); });
    refused.once('open', () => reject(new Error('501st writer was admitted')));
    refused.once('error', reject);
  });
  assert.equal(status, 429);
  const renewal = await fetch(`${server.base}/yjs-public/rooms/${credentials.roomHandle}/public-session`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: credentials.cookie },
  });
  assert.equal(renewal.status, 200);
});

test('live CRDT edit reaches snapshot and survives the last writer leaving', async t => {
  const server = await relay(t);
  const credentials = await session(server);
  const ws = await writer(t, server, credentials);
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  doc.getMap('items').set('live', new Y.Map([['type', 'text'], ['x', -10], ['y', 20], ['text', new Y.Text('hello wall')]]));
  await sendBoardUpdate(ws, doc);
  const response = await fetch(`${server.base}/yjs-public/api/snapshot`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=10');
  assert.equal((await response.json()).items[0].text, 'hello wall');
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  const snapshot = await fetch(`${server.base}/yjs-public/api/snapshot`);
  assert.equal((await snapshot.json()).items[0].text, 'hello wall');
});

test('public flood cannot consume the main relay session or health budgets', async t => {
  const publicServer = await relay(t, null, true, { YJS_SESSION_EXCHANGE_BURST: '1', YJS_SESSION_EXCHANGES_PER_MINUTE: '1' });
  const main = await relay(t, null, false);
  assert.equal((await requestSession(publicServer)).status, 200);
  for (let index = 0; index < WRITER_COUNT; index++) assert.equal((await requestSession(publicServer)).status, 429);
  const created = await fetch(`${main.base}/api/rooms`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(created.status, 201);
  const capability = await created.json();
  const exchanged = await fetch(`${main.base}/api/room-session`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(capability),
  });
  assert.equal(exchanged.status, 200);
  const privateSession = await exchanged.json();
  const cookie = exchanged.headers.get('set-cookie').split(';')[0];
  const uploaded = await fetch(`${main.base}/rooms/${privateSession.roomHandle}/upload`, {
    method: 'POST', headers: { origin: ORIGIN, cookie, 'content-type': 'image/png' }, body: PNG_BYTES,
  });
  assert.equal(uploaded.status, 200);
  const { url } = await uploaded.json();
  assert.equal((await fetch(`${main.base}${url}`)).status, 401);
  const authenticatedImage = await fetch(`${main.base}${url}`, { headers: { cookie } });
  assert.equal(authenticatedImage.status, 200);
  assert.deepEqual(Buffer.from(await authenticatedImage.arrayBuffer()), PNG_BYTES);
  assert.equal((await fetch(`${main.base}/readyz`)).status, 200);
});
