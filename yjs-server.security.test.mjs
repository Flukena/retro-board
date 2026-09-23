import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createMotionPublisher, sendOnlyLocalAwareness } from './src/awareness-transport.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Y = require('yjs');
const { LeveldbPersistence } = require('y-leveldb');
const { WebsocketProvider } = require('y-websocket');
const { Awareness } = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const syncProtocol = require('y-protocols/sync');
const ALLOWED_ORIGIN = 'https://allowed.example';
const CAPACITY_PROFILE = Object.fromEntries((await readFile(join(here, 'config/room-capacity.env'), 'utf8'))
  .split('\n').filter((line) => /^YJS_[A-Z_]+=\d+$/.test(line)).map((line) => line.split('=')));
const DEFAULT_SESSION_SECRET = 'test-only-session-secret-0000000000000000';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, message, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(message);
};

const directorySize = async (root) => {
  let total = 0;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return 0; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
};

const startServer = async (overrides = {}, suppliedRoot = null) => {
  const ownsRoot = suppliedRoot === null;
  const root = suppliedRoot || await mkdtemp(join(tmpdir(), 'retro-yjs-security-'));
  const dbDir = join(root, 'db');
  const uploadsDir = join(root, 'uploads');
  const child = spawn(process.execPath, ['yjs-server.mjs'], {
    cwd: here,
    env: {
      ...process.env,
      YJS_PORT: '0',
      YJS_HOST: '127.0.0.1',
      YJS_DB_DIR: dbDir,
      YJS_UPLOADS_DIR: uploadsDir,
      YJS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      YJS_ALLOW_INSECURE_HTTP: '0',
      YJS_ALLOW_LEGACY_ROOMS: '0',
      YJS_ALLOW_LEGACY_URL_TOKENS: '0',
      YJS_WIPE_DOCS: '',
      YJS_MIGRATE_DOCS: '',
      YJS_SESSION_SECRET: DEFAULT_SESSION_SECRET,
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let port;
  try {
    port = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.stdout.off('data', inspect);
        child.off('exit', onExit);
        callback(value);
      };
      const inspect = () => {
        const match = stdout.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)/);
        if (match) finish(resolve, Number(match[1]));
      };
      const onExit = (code) => finish(reject, new Error(`server exited ${code}\n${stdout}\n${stderr}`));
      const timeout = setTimeout(() => {
        finish(reject, new Error(`server start timed out\n${stdout}\n${stderr}`));
      }, 5_000);
      child.stdout.on('data', inspect);
      child.once('exit', onExit);
    });
  } catch (err) {
    if (child.exitCode == null) child.kill('SIGKILL');
    if (ownsRoot) await rm(root, { recursive: true, force: true });
    throw err;
  }

  let stopped = false;
  const stopProcess = async (signal) => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode == null) {
      child.kill(signal);
      await new Promise((resolve) => {
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
        killTimer.unref();
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
  };
  const stop = async () => {
    await stopProcess('SIGTERM');
    if (ownsRoot) await rm(root, { recursive: true, force: true });
  };
  const killAbruptly = () => stopProcess('SIGKILL');
  const terminateGracefully = async () => {
    await stopProcess('SIGTERM');
    return { exitCode: child.exitCode, signalCode: child.signalCode };
  };

  return {
    root,
    dbDir,
    uploadsDir,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    output: () => `${stdout}\n${stderr}`,
    killAbruptly,
    terminateGracefully,
    stop,
  };
};

const apiPost = (server, path, body = {}) => fetch(`${server.httpUrl}${path}`, {
  method: 'POST',
  headers: { origin: ALLOWED_ORIGIN, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const createRoom = async (server, prefix = '') => {
  const response = await apiPost(server, `${prefix}/api/rooms`);
  assert.equal(response.status, 201);
  return response.json();
};

const createSession = async (server, room, prefix = '') => {
  const response = await apiPost(server, `${prefix}/api/room-session`, room);
  assert.equal(response.status, 200);
  const session = await response.json();
  return { ...session, cookie: response.headers.get('set-cookie').split(';', 1)[0] };
};

const websocketOptions = (origin, cookie) => ({
  ...(origin === null ? {} : { origin }),
  ...(cookie ? { headers: { cookie } } : {}),
});

const openWs = (url, { origin = ALLOWED_ORIGIN, cookie } = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, websocketOptions(origin, cookie));
  const timeout = setTimeout(() => {
    ws.terminate();
    reject(new Error('websocket open timed out'));
  }, 3_000);
  ws.once('open', () => {
    clearTimeout(timeout);
    resolve(ws);
  });
  ws.once('error', (err) => {
    clearTimeout(timeout);
    reject(err);
  });
});

const rejectedWsStatus = (url, { origin = ALLOWED_ORIGIN, cookie } = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, websocketOptions(origin, cookie));
  const timeout = setTimeout(() => {
    ws.terminate();
    reject(new Error('websocket rejection timed out'));
  }, 3_000);
  ws.once('unexpected-response', (_request, response) => {
    clearTimeout(timeout);
    response.resume();
    resolve(response.statusCode);
  });
  ws.once('open', () => {
    clearTimeout(timeout);
    ws.close();
    reject(new Error('websocket unexpectedly opened'));
  });
  ws.once('error', () => { /* unexpected-response is authoritative */ });
});

const closeWs = async (ws) => {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, 'close');
  ws.close();
  await closed;
};

const encodeSyncUpdate = (update) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
};

const encodeSyncStep1 = (doc = new Y.Doc()) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
};

const encodeAwareness = (entries) => {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, entries.length);
  for (const { clientId, clock = 1, state = {} } of entries) {
    encoding.writeVarUint(update, clientId);
    encoding.writeVarUint(update, clock);
    encoding.writeVarString(update, JSON.stringify(state));
  }
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 1);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
};

const trackAwarenessStates = (ws) => {
  const states = new Map();
  const clocks = new Map();
  const onMessage = (data) => {
    try {
      const outer = decoding.createDecoder(data);
      if (decoding.readVarUint(outer) !== 1) return;
      const inner = decoding.createDecoder(decoding.readVarUint8Array(outer));
      const count = decoding.readVarUint(inner);
      for (let index = 0; index < count; index += 1) {
        const clientId = decoding.readVarUint(inner);
        const clock = decoding.readVarUint(inner);
        const state = JSON.parse(decoding.readVarString(inner));
        if ((clocks.get(clientId) || 0) > clock) continue;
        clocks.set(clientId, clock);
        if (state === null) states.delete(clientId);
        else states.set(clientId, state);
      }
    } catch { /* other protocol tests cover malformed server output */ }
  };
  ws.on('message', onMessage);
  return { states, stop: () => ws.off('message', onMessage) };
};

const waitForWsMessage = (ws, predicate, timeoutMs = 3_000) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    ws.off('message', onMessage);
    reject(new Error('websocket message timed out'));
  }, timeoutMs);
  const onMessage = (data) => {
    if (!predicate(data)) return;
    clearTimeout(timeout);
    ws.off('message', onMessage);
    resolve(data);
  };
  ws.on('message', onMessage);
});

const abortRoomCreationBody = async (server) => {
  const { port } = new URL(server.httpUrl);
  const socket = connect({ host: '127.0.0.1', port: Number(port) });
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  socket.write([
    'POST /api/rooms HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    `Origin: ${ALLOWED_ORIGIN}`,
    'Content-Type: application/json',
    'Content-Length: 100',
    'Connection: close',
    '',
    '{',
  ].join('\r\n'));
  await delay(25);
  socket.destroy();
  await closed;
  // Let the server's async body iterator observe the reset before checking its
  // process-wide storage health.
  await delay(75);
};

const testPng = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(592),
]);

const uploadImage = (server, session, image = testPng(), prefix = '') => fetch(
  `${server.httpUrl}${prefix}/rooms/${session.roomHandle}/upload`,
  {
    method: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'content-type': 'image/png',
      cookie: session.cookie,
    },
    body: image,
  },
);

const signedSessionCookie = (room, handle, expiresAt, secret = DEFAULT_SESSION_SECRET) => {
  const docName = `yjs/board-${room.code}-${room.token}`;
  const signature = createHmac('sha256', secret)
    .update('room-session-v1\0')
    .update(handle)
    .update('\0')
    .update(String(expiresAt))
    .update('\0')
    .update(docName)
    .digest('base64url');
  return `rb_room_session=v1.${handle}.${expiresAt}.${signature}`;
};

test('exchanges a body capability for an opaque cookie-bound WebSocket path', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const room = await createRoom(server);
  assert.match(room.code, /^[A-Za-z0-9_-]{8}$/);
  assert.match(room.token, /^[A-Za-z0-9_-]{32}$/);

  const wrongLast = room.token.endsWith('A') ? 'B' : 'A';
  const wrong = await apiPost(server, '/api/room-session', { code: room.code, token: `${room.token.slice(0, -1)}${wrongLast}` });
  assert.equal(wrong.status, 404);
  const queryToken = await apiPost(server, `/api/room-session?token=${room.token}`, room);
  assert.equal(queryToken.status, 404);

  const session = await createSession(server, room);
  assert.match(session.roomHandle, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(Number.isSafeInteger(session.expiresAt) && session.expiresAt > Date.now());
  assert.match(session.cookie, /^rb_room_session=v1\./);

  const wsPath = `/rooms/${session.roomHandle}`;
  assert.equal(wsPath.includes(room.token), false);
  const ws = await openWs(`${server.wsUrl}${wsPath}`, { cookie: session.cookie });
  await closeWs(ws);

  assert.equal(await rejectedWsStatus(`${server.wsUrl}${wsPath}`), 401);
  assert.equal(await rejectedWsStatus(`${server.wsUrl}${wsPath}?token=${room.token}`, { cookie: session.cookie }), 404);
  assert.equal(await rejectedWsStatus(`${server.wsUrl}/rooms/${'A'.repeat(32)}`, { cookie: session.cookie }), 404);
  assert.equal(await rejectedWsStatus(`${server.wsUrl}/board-${room.code}-${room.token}`, { cookie: session.cookie }), 404);
  assert.equal(server.output().includes(room.token), false);
});

test('rejects missing and hostile origins before HTTP or WebSocket admission', async (t) => {
  const server = await startServer();
  t.after(server.stop);

  const missingOrigin = await fetch(`${server.httpUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(missingOrigin.status, 403);

  const hostileOrigin = await fetch(`${server.httpUrl}/api/rooms`, {
    method: 'POST',
    headers: { origin: 'https://hostile.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(hostileOrigin.status, 403);
  assert.equal(hostileOrigin.headers.get('access-control-allow-origin'), null);

  const hostilePreflight = await fetch(`${server.httpUrl}/api/room-session`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://hostile.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(hostilePreflight.status, 403);
  assert.equal(hostilePreflight.headers.get('access-control-allow-origin'), null);

  const room = await createRoom(server);
  const session = await createSession(server, room);
  const missingSessionOrigin = await fetch(`${server.httpUrl}/api/room-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(room),
  });
  assert.equal(missingSessionOrigin.status, 403);
  const hostileUpload = await fetch(`${server.httpUrl}/rooms/${session.roomHandle}/upload`, {
    method: 'POST',
    headers: {
      origin: 'https://hostile.example',
      'content-type': 'image/png',
      cookie: session.cookie,
    },
    body: testPng(),
  });
  assert.equal(hostileUpload.status, 403);
  const wsUrl = `${server.wsUrl}/rooms/${session.roomHandle}`;
  assert.equal(await rejectedWsStatus(wsUrl, { origin: null, cookie: session.cookie }), 403);
  assert.equal(await rejectedWsStatus(wsUrl, {
    origin: 'https://hostile.example',
    cookie: session.cookie,
  }), 403);
});

test('fails startup for wildcard, path-bearing, or insecure production origins', async () => {
  await assert.rejects(
    startServer({ YJS_ALLOWED_ORIGINS: '*' }),
    /exact URL origins/,
  );
  await assert.rejects(
    startServer({ YJS_ALLOWED_ORIGINS: 'https://allowed.example/path' }),
    /exact HTTPS origins/,
  );
  await assert.rejects(
    startServer({ YJS_ALLOWED_ORIGINS: 'http://allowed.example' }),
    /exact HTTPS origins/,
  );
});

test('fails startup for a non-IP relay bind address', async () => {
  await assert.rejects(
    startServer({ YJS_HOST: 'all-interfaces.example' }),
    /YJS_HOST must be an IPv4 or IPv6 address/,
  );
});

test('defaults a direct relay process to the loopback interface', async (t) => {
  const server = await startServer({ YJS_HOST: '' });
  t.after(server.stop);
  assert.match(server.output(), /listening on ws:\/\/127\.0\.0\.1:/);
});

test('fails startup when a room awareness snapshot cannot fit the inbound envelope', async () => {
  await assert.rejects(
    startServer({
      YJS_MAX_AWARENESS_MESSAGE_BYTES: String(64 * 1024),
      YJS_MAX_AWARENESS_STATE_BYTES: String(64 * 1024),
    }),
    /too small for the configured awareness state\/client limits/,
  );
});

test('rejects tampered, duplicate, expired, and future-dated room sessions', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const upload = await uploadImage(server, session);
  assert.equal(upload.status, 200);
  const { url: imageUrl } = await upload.json();
  const resourceUrl = `${server.httpUrl}${imageUrl}`;
  const wsUrl = `${server.wsUrl}/rooms/${session.roomHandle}`;

  const replacement = session.cookie.endsWith('A') ? 'B' : 'A';
  const tampered = `${session.cookie.slice(0, -1)}${replacement}`;
  assert.equal((await fetch(resourceUrl, { headers: { cookie: tampered } })).status, 401);
  assert.equal(await rejectedWsStatus(wsUrl, { cookie: tampered }), 401);

  const duplicate = `${session.cookie}; ${session.cookie}`;
  assert.equal((await fetch(resourceUrl, { headers: { cookie: duplicate } })).status, 401);
  assert.equal(await rejectedWsStatus(wsUrl, { cookie: duplicate }), 401);

  const overlong = `rb_room_session=${'A'.repeat(4096)}`;
  assert.equal((await fetch(resourceUrl, { headers: { cookie: overlong } })).status, 401);
  assert.equal(await rejectedWsStatus(wsUrl, { cookie: overlong }), 401);

  const expired = signedSessionCookie(room, session.roomHandle, Date.now() - 1);
  assert.equal((await fetch(resourceUrl, { headers: { cookie: expired } })).status, 401);
  assert.equal(await rejectedWsStatus(wsUrl, { cookie: expired }), 401);

  const tooFarInFuture = signedSessionCookie(
    room,
    session.roomHandle,
    Date.now() + (8 * 24 * 60 * 60 * 1000),
  );
  assert.equal((await fetch(resourceUrl, { headers: { cookie: tooFarInFuture } })).status, 401);
  assert.equal(await rejectedWsStatus(wsUrl, { cookie: tooFarInFuture }), 401);
});

test('expires an already-open WebSocket at its signed session deadline', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const expiresAt = Date.now() + 750;
  const cookie = signedSessionCookie(room, session.roomHandle, expiresAt);
  const ws = await openWs(`${server.wsUrl}/rooms/${session.roomHandle}`, { cookie });
  const [closeCode, reason] = await once(ws, 'close');
  assert.equal(closeCode, 1008);
  assert.equal(reason.toString(), 'session expired');
  assert.ok(Date.now() >= expiresAt);
});

test('applies the per-IP WebSocket cap after cookie authentication', async (t) => {
  const server = await startServer({ YJS_MAX_CONNECTIONS_PER_IP: '1' });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const url = `${server.wsUrl}/rooms/${session.roomHandle}`;
  const first = await openWs(url, { cookie: session.cookie });
  assert.equal(await rejectedWsStatus(url, { cookie: session.cookie }), 429);
  await closeWs(first);
});

test('rate-limits repeated cold-room WebSocket hydration', async (t) => {
  const server = await startServer({
    YJS_COLD_ROOM_OPEN_IP_BURST: '20',
    YJS_COLD_ROOM_OPENS_PER_IP_PER_MINUTE: '20',
    YJS_COLD_ROOM_OPEN_ROOM_BURST: '2',
    YJS_COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE: '1',
    YJS_GLOBAL_COLD_ROOM_OPEN_BURST: '20',
    YJS_GLOBAL_COLD_ROOM_OPENS_PER_MINUTE: '20',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const url = `${server.wsUrl}/rooms/${session.roomHandle}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ws = await openWs(url, { cookie: session.cookie });
    await closeWs(ws);
    // writeState resolves in a microtask, after which y-websocket destroys and
    // evicts the now-cold document.
    await delay(50);
  }

  assert.equal(await rejectedWsStatus(url, { cookie: session.cookie }), 429);
  assert.equal((await fetch(`${server.httpUrl}/readyz`)).status, 200);
});

test('rejects unauthenticated upload before writing and atomically publishes an authenticated upload', async (t) => {
  const server = await startServer({
    YJS_MAX_UPLOAD_BYTES: '1024',
    YJS_MAX_UPLOAD_STORAGE_BYTES: '1024',
    YJS_MAX_ROOM_UPLOAD_BYTES: '1024',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const uploadUrl = `${server.httpUrl}/rooms/${session.roomHandle}/upload`;
  const image = testPng();
  const upload = (cookie) => fetch(uploadUrl, {
    method: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'content-type': 'image/png',
      ...(cookie ? { cookie } : {}),
    },
    body: image,
  });

  const unauthorized = await upload();
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await readdir(server.uploadsDir), []);

  const authorized = await upload(session.cookie);
  assert.equal(authorized.status, 200);
  const { url: imageUrl } = await authorized.json();
  assert.match(imageUrl, new RegExp(`^/rooms/${session.roomHandle}/images/[a-f0-9-]+\\.png$`));
  const files = await readdir(server.uploadsDir);
  assert.equal(files.filter((name) => name.endsWith('.png')).length, 1);
  assert.equal(files[0].startsWith(`${session.roomHandle}.`), true);
  assert.equal(files.filter((name) => name.endsWith('.tmp')).length, 0);

  const unauthenticatedRead = await fetch(`${server.httpUrl}${imageUrl}`);
  assert.equal(unauthenticatedRead.status, 401);
  const authenticatedRead = await fetch(`${server.httpUrl}${imageUrl}`, { headers: { cookie: session.cookie } });
  assert.equal(authenticatedRead.status, 200);
  assert.equal(authenticatedRead.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await authenticatedRead.arrayBuffer()), image);

  const secondRoom = await createRoom(server);
  const secondSession = await createSession(server, secondRoom);
  const crossRoomRead = await fetch(`${server.httpUrl}${imageUrl}`, { headers: { cookie: secondSession.cookie } });
  assert.equal(crossRoomRead.status, 401);
  const imageId = imageUrl.split('/').pop();
  const reboundPath = `/rooms/${secondSession.roomHandle}/images/${imageId}`;
  const reboundRead = await fetch(`${server.httpUrl}${reboundPath}`, { headers: { cookie: secondSession.cookie } });
  assert.equal(reboundRead.status, 404);
  assert.equal((await fetch(`${server.httpUrl}/images/${imageId}`)).status, 404);
  const unknownHandlePath = `/rooms/${'A'.repeat(32)}/images/${imageId}`;
  assert.equal((await fetch(`${server.httpUrl}${unknownHandlePath}`, { headers: { cookie: session.cookie } })).status, 404);

  const overQuota = await upload(session.cookie);
  assert.equal(overQuota.status, 507);
});

test('rate-limits authenticated image reads by byte budget', async (t) => {
  const image = testPng();
  const server = await startServer({
    YJS_IMAGE_READ_BURST: '2',
    YJS_IMAGE_READS_PER_SECOND: '1',
    YJS_IMAGE_READ_BURST_BYTES: String(image.byteLength),
    YJS_IMAGE_READ_BYTES_PER_SECOND: '1',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const upload = await uploadImage(server, session, image);
  assert.equal(upload.status, 200);
  const { url: imageUrl } = await upload.json();

  const first = await fetch(`${server.httpUrl}${imageUrl}`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(first.status, 200);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), image);

  const limited = await fetch(`${server.httpUrl}${imageUrl}`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '2');
  assert.equal((await fetch(`${server.httpUrl}/readyz`)).status, 200);
});

test('rate-limits authenticated image reads by request budget', async (t) => {
  const server = await startServer({
    YJS_IMAGE_READ_BURST: '1',
    YJS_IMAGE_READS_PER_SECOND: '1',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const upload = await uploadImage(server, session);
  assert.equal(upload.status, 200);
  const { url: imageUrl } = await upload.json();

  const first = await fetch(`${server.httpUrl}${imageUrl}`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  const limited = await fetch(`${server.httpUrl}${imageUrl}`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '2');
});

test('room creation has a separate per-IP rate limit', async (t) => {
  const server = await startServer({
    YJS_ROOM_CREATE_BURST: '1',
    YJS_ROOM_CREATES_PER_HOUR: '1',
  });
  t.after(server.stop);
  assert.equal((await apiPost(server, '/api/rooms')).status, 201);
  const limited = await apiPost(server, '/api/rooms');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('room creation also has an independent global rate limit', async (t) => {
  const server = await startServer({
    YJS_ROOM_CREATE_BURST: '10',
    YJS_ROOM_CREATES_PER_HOUR: '10',
    YJS_GLOBAL_ROOM_CREATE_BURST: '1',
    YJS_GLOBAL_ROOM_CREATES_PER_MINUTE: '1',
  });
  t.after(server.stop);
  assert.equal((await apiPost(server, '/api/rooms')).status, 201);
  const limited = await apiPost(server, '/api/rooms');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('an aborted room-creation body cannot degrade storage readiness', async (t) => {
  const server = await startServer({ YJS_ROOM_CREATE_BURST: '10' });
  t.after(server.stop);
  await abortRoomCreationBody(server);
  const readiness = await fetch(`${server.httpUrl}/readyz`);
  assert.equal(readiness.status, 200);
  assert.equal(await readiness.text(), 'ready');
  assert.equal(server.output().includes('storage degraded'), false);
  assert.equal((await apiPost(server, '/api/rooms')).status, 201);
});

test('invalid session flood cannot lock out a valid room capability sharing the IP', async (t) => {
  const server = await startServer({
    YJS_SESSION_FAILURE_BURST: '2',
    YJS_SESSION_FAILURES_PER_HOUR: '1',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const invalid = { code: room.code, token: 'A'.repeat(32) };
  assert.equal((await apiPost(server, '/api/room-session', invalid)).status, 404);
  assert.equal((await apiPost(server, '/api/room-session', invalid)).status, 404);
  assert.equal((await apiPost(server, '/api/room-session', invalid)).status, 429);
  const valid = await apiPost(server, '/api/room-session', room);
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get('set-cookie') || '', /^rb_room_session=v1\./);
});

test('valid capability exchanges have an independent abuse budget', async (t) => {
  const server = await startServer({
    YJS_SESSION_EXCHANGE_BURST: '1',
    YJS_SESSION_EXCHANGES_PER_MINUTE: '1',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  assert.equal((await apiPost(server, '/api/room-session', room)).status, 200);
  const limited = await apiPost(server, '/api/room-session', room);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '2');
});

test('prefixed capability exchange has credentialed exact-origin CORS and scoped secure cookie', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const preflight = await fetch(`${server.httpUrl}/yjs/api/room-session`, {
    method: 'OPTIONS',
    headers: {
      origin: ALLOWED_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);

  const createResponse = await apiPost(server, '/yjs/api/rooms');
  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(createResponse.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(createResponse.headers.get('cache-control'), 'no-store');
  const room = await createResponse.json();

  const sessionResponse = await apiPost(server, '/yjs/api/room-session', room);
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionResponse.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(sessionResponse.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(sessionResponse.headers.get('cache-control'), 'no-store');
  const session = await sessionResponse.json();
  const setCookie = sessionResponse.headers.get('set-cookie') || '';
  assert.match(setCookie, /^rb_room_session=v1\./);
  assert.match(setCookie, new RegExp(`(?:^|; )Path=/yjs/rooms/${session.roomHandle}(?:;|$)`));
  assert.match(setCookie, /(?:^|; )HttpOnly(?:;|$)/);
  assert.match(setCookie, /(?:^|; )SameSite=Strict(?:;|$)/);
  assert.match(setCookie, /(?:^|; )Max-Age=\d+(?:;|$)/);
  assert.match(setCookie, /(?:^|; )Secure(?:;|$)/);

  const cookie = setCookie.split(';', 1)[0];
  const ws = await openWs(`${server.wsUrl}/yjs/rooms/${session.roomHandle}`, { cookie });
  await closeWs(ws);
});

test('persisted room handle and image survive session-key rotation while the old cookie expires', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-security-restart-'));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  server = await startServer({ YJS_SESSION_SECRET: 'A'.repeat(32) }, root);
  const room = await createRoom(server);
  const oldSession = await createSession(server, room);
  const image = testPng();
  const upload = await uploadImage(server, oldSession, image);
  assert.equal(upload.status, 200);
  const { url: imageUrl } = await upload.json();
  const oldHandle = oldSession.roomHandle;
  const oldCookie = oldSession.cookie;
  await server.stop();

  server = await startServer({ YJS_SESSION_SECRET: 'B'.repeat(32) }, root);
  const newSession = await createSession(server, room);
  assert.equal(newSession.roomHandle, oldHandle);
  assert.equal((await fetch(`${server.httpUrl}${imageUrl}`, { headers: { cookie: oldCookie } })).status, 401);
  const restoredImage = await fetch(`${server.httpUrl}${imageUrl}`, { headers: { cookie: newSession.cookie } });
  assert.equal(restoredImage.status, 200);
  assert.deepEqual(Buffer.from(await restoredImage.arrayBuffer()), image);
});

test('wiping a persisted document retires its old capability and handle on restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-security-wipe-'));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  server = await startServer({}, root);
  const room = await createRoom(server);
  const oldSession = await createSession(server, room);
  await server.stop();

  const docName = `yjs/board-${room.code}-${room.token}`;
  server = await startServer({ YJS_WIPE_DOCS: docName }, root);
  assert.equal((await apiPost(server, '/api/room-session', room)).status, 404);
  assert.equal(
    await rejectedWsStatus(`${server.wsUrl}/rooms/${oldSession.roomHandle}`, { cookie: oldSession.cookie }),
    404,
  );
});

test('quarantines a token-shaped document without the room commit marker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-security-incomplete-room-'));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  const code = 'Orphan12';
  const token = 'A'.repeat(32);
  const docName = `yjs/board-${code}-${token}`;
  const seed = new Y.Doc();
  seed.getMap('meta').set('__roomRegistered', 1);
  const persisted = new LeveldbPersistence(join(root, 'db'));
  await persisted.storeUpdate(docName, Y.encodeStateAsUpdate(seed));
  await persisted.destroy();
  seed.destroy();

  server = await startServer({}, root);
  assert.equal((await apiPost(server, '/api/room-session', { code, token })).status, 404);
  assert.match(server.output(), /quarantined incomplete room/);
});

test('finalizes an expired vote when the room reopens without an admin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-expired-vote-'));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });
  server = await startServer({}, root);
  const room = await createRoom(server);
  await server.stop();

  const docName = `yjs/board-${room.code}-${room.token}`;
  const persisted = new LeveldbPersistence(join(root, 'db'));
  const doc = await persisted.getYDoc(docName);
  const items = doc.getMap('items');
  const zone = new Y.Map();
  Object.entries({ type: 'zone', x: 0, y: 0, w: 800, h: 600, voteTimer: { endsAt: Date.now() - 1000 } })
    .forEach(([key, value]) => zone.set(key, value));
  const sticky = new Y.Map();
  Object.entries({ type: 'sticky', x: 80, y: 120, w: 200, h: 180, parentZoneId: 'zone' })
    .forEach(([key, value]) => sticky.set(key, value));
  items.set('zone', zone);
  items.set('note', sticky);
  doc.getMap('kv').set('s||vote:note:alice', 1);
  await persisted.storeUpdate(docName, Y.encodeStateAsUpdate(doc));
  doc.destroy();
  await persisted.destroy();

  server = await startServer({}, root);
  const session = await createSession(server, room);
  const ws = await openWs(`${server.wsUrl}/rooms/${session.roomHandle}`, { cookie: session.cookie });
  await delay(200);
  await closeWs(ws);
  await server.stop();
  const saved = new LeveldbPersistence(join(root, 'db'));
  const result = await saved.getYDoc(docName);
  assert.equal(result.getMap('items').get('zone').get('voteTimer'), null);
  assert.ok(result.getMap('items').get('zone').get('lastResultsAt'));
  assert.notEqual(result.getMap('items').get('note').get('x'), 80);
  result.destroy();
  await saved.destroy();
});

test('relay closes a live vote at its deadline without an admin connection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-live-vote-'));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });
  server = await startServer({}, root);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const ws = await openWs(`${server.wsUrl}/rooms/${session.roomHandle}`, { cookie: session.cookie });
  const source = new Y.Doc();
  const zone = new Y.Map();
  Object.entries({ type: 'zone', x: 0, y: 0, w: 800, h: 600, voteTimer: { endsAt: Date.now() + 350 } })
    .forEach(([key, value]) => zone.set(key, value));
  source.getMap('items').set('zone', zone);
  ws.send(encodeSyncUpdate(Y.encodeStateAsUpdate(source)));
  await delay(650);
  await closeWs(ws);
  source.destroy();
  await server.stop();
  const saved = new LeveldbPersistence(join(root, 'db'));
  const doc = await saved.getYDoc(`yjs/board-${room.code}-${room.token}`);
  assert.equal(doc.getMap('items').get('zone').get('voteTimer'), null);
  assert.ok(doc.getMap('items').get('zone').get('lastResultsAt'));
  doc.destroy();
  await saved.destroy();
});

test('reconciles persisted room upload usage with protected files on restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-security-upload-reconcile-'));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  server = await startServer({
    YJS_MAX_UPLOAD_BYTES: '1024',
    YJS_MAX_ROOM_UPLOAD_BYTES: '1024',
  }, root);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  assert.equal((await uploadImage(server, session)).status, 200);
  await server.stop();

  const docName = `yjs/board-${room.code}-${room.token}`;
  const persisted = new LeveldbPersistence(server.dbDir);
  await persisted.setMeta(docName, 'retro-room-upload-usage-v1', { bytes: 0, files: 0 });
  await persisted.destroy();

  server = await startServer({
    YJS_MAX_UPLOAD_BYTES: '1024',
    YJS_MAX_ROOM_UPLOAD_BYTES: '1024',
  }, root);
  const restoredSession = await createSession(server, room);
  assert.equal((await uploadImage(server, restoredSession)).status, 507);
  assert.match(server.output(), /reconciled room upload usage/);
  await server.stop();

  const verified = new LeveldbPersistence(server.dbDir);
  const usage = await verified.getMeta(docName, 'retro-room-upload-usage-v1');
  assert.deepEqual(usage, { bytes: testPng().byteLength, files: 1 });
  await verified.destroy();
});

test('fails startup when an explicitly requested migration cannot run', async () => {
  await assert.rejects(
    startServer({ YJS_MIGRATE_DOCS: 'not-a-registered-room' }),
    /migration target is not a registered tokenized room/,
  );
});

test('legacy embedded-image migration is durable and idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-security-migration-'));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  server = await startServer({}, root);
  const room = await createRoom(server);
  await server.stop();

  const docName = `yjs/board-${room.code}-${room.token}`;
  const seed = new Y.Doc();
  const image = new Y.Map();
  seed.getMap('items').set('legacy-image', image);
  image.set('type', 'image');
  image.set('src', `data:image/png;base64,${testPng().toString('base64')}`);
  const persisted = new LeveldbPersistence(server.dbDir);
  await persisted.storeUpdate(docName, Y.encodeStateAsUpdate(seed));
  await persisted.destroy();
  seed.destroy();

  server = await startServer({ YJS_MIGRATE_DOCS: docName }, root);
  assert.match(server.output(), /rewritten: 1/);
  await server.stop();

  const firstFiles = (await readdir(server.uploadsDir)).filter((name) => name.endsWith('.png'));
  assert.equal(firstFiles.length, 1);
  const afterFirst = new LeveldbPersistence(server.dbDir);
  const firstDoc = await afterFirst.getYDoc(docName);
  const firstSrc = firstDoc.getMap('items').get('legacy-image').get('src');
  assert.match(firstSrc, /^\/rooms\/[A-Za-z0-9_-]{32}\/images\/[a-f0-9-]+\.png$/);
  firstDoc.destroy();
  await afterFirst.destroy();

  server = await startServer({ YJS_MIGRATE_DOCS: docName }, root);
  assert.match(server.output(), /rewritten: 0/);
  await server.stop();

  const secondFiles = (await readdir(server.uploadsDir)).filter((name) => name.endsWith('.png'));
  assert.deepEqual(secondFiles, firstFiles);
  const afterSecond = new LeveldbPersistence(server.dbDir);
  const secondDoc = await afterSecond.getYDoc(docName);
  assert.equal(secondDoc.getMap('items').get('legacy-image').get('src'), firstSrc);
  secondDoc.destroy();
  await afterSecond.destroy();
});

test('rejects an update before applying it when persistence backlog cannot reserve it', async (t) => {
  const server = await startServer({
    YJS_MAX_PENDING_STORE_BYTES: String(64 * 1024),
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const url = `${server.wsUrl}/rooms/${session.roomHandle}`;
  const observer = await openWs(url, { cookie: session.cookie });
  const observed = new Y.Doc();
  observer.on('message', (data) => {
    try {
      const decoder = decoding.createDecoder(data);
      if (decoding.readVarUint(decoder) !== 0) return;
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), observed, null);
    } catch { /* malformed output would fail the other protocol tests */ }
  });
  const writer = await openWs(url, { cookie: session.cookie });
  const source = new Y.Doc();
  let update;
  source.on('update', (value) => { update = value; });
  source.getText('backlog').insert(0, 'q'.repeat(70 * 1024));

  const rejected = once(writer, 'close');
  writer.send(encodeSyncUpdate(update));
  const [closeCode] = await rejected;
  assert.equal(closeCode, 1008);
  await delay(50);
  assert.equal(observed.getText('backlog').toString(), '');
  assert.equal(observer.readyState, WebSocket.OPEN);
  source.destroy();
  observed.destroy();
  await closeWs(observer);
});

test('closes a sender after a framed but invalid Yjs update', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const url = `${server.wsUrl}/rooms/${session.roomHandle}`;
  const observer = await openWs(url, { cookie: session.cookie });
  const sender = await openWs(url, { cookie: session.cookie });
  const rejected = once(sender, 'close');
  sender.send(encodeSyncUpdate(Uint8Array.of(1)));
  const [closeCode] = await rejected;
  assert.equal(closeCode, 1008);
  assert.equal(observer.readyState, WebSocket.OPEN);
  assert.match(server.output(), /invalid sync message/);
  await closeWs(observer);
});

test('bounds aggregate active document memory and releases it on destroy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-security-active-docs-'));
  const limits = {
    YJS_MAX_DOCUMENT_BYTES: String(256 * 1024),
    YJS_MAX_ACTIVE_DOCUMENT_BYTES: '370000',
  };
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  server = await startServer(limits, root);
  const entries = [];
  for (let index = 0; index < 3; index += 1) {
    const room = await createRoom(server);
    const session = await createSession(server, room);
    const ws = await openWs(`${server.wsUrl}/rooms/${session.roomHandle}`, {
      cookie: session.cookie,
    });
    const source = new Y.Doc();
    let update;
    source.on('update', (nextUpdate) => { update = nextUpdate; });
    source.getText('payload').insert(0, String(index).repeat(170_000));
    ws.send(encodeSyncUpdate(update));
    await waitFor(() => (
      (server.output().match(/storeUpdate ok/g) || []).length >= index + 1
    ), `large room ${index} was not persisted`, 5_000);
    await closeWs(ws);
    source.destroy();
    await delay(50);
    entries.push({ room, session });
  }
  await server.stop();

  // On a clean process, two individually-valid rooms fit the aggregate
  // budget; hydrating the third must fail locally without degrading storage.
  server = await startServer(limits, root);
  const roomUrl = (entry) => `${server.wsUrl}/rooms/${entry.session.roomHandle}`;
  const first = await openWs(roomUrl(entries[0]), { cookie: entries[0].session.cookie });
  const second = await openWs(roomUrl(entries[1]), { cookie: entries[1].session.cookie });
  assert.equal(
    await rejectedWsStatus(roomUrl(entries[2]), { cookie: entries[2].session.cookie }),
    503,
  );
  assert.equal((await fetch(`${server.httpUrl}/readyz`)).status, 200);
  assert.doesNotMatch(server.output(), /storage degraded/);

  // Destroying one resident room releases its exact reservation, allowing a
  // previously-refused cold room to hydrate. A further update that would push
  // the aggregate over budget is rejected before application.
  await closeWs(first);
  await delay(100);
  const third = await openWs(roomUrl(entries[2]), { cookie: entries[2].session.cookie });
  const incremental = new Y.Doc();
  let incrementalUpdate;
  incremental.on('update', (nextUpdate) => { incrementalUpdate = nextUpdate; });
  incremental.getText('extra').insert(0, 'z'.repeat(40_000));
  const rejected = once(third, 'close');
  third.send(encodeSyncUpdate(incrementalUpdate));
  const [closeCode] = await rejected;
  assert.equal(closeCode, 1009);
  assert.equal(second.readyState, WebSocket.OPEN);
  assert.match(server.output(), /active document capacity reached/);

  incremental.destroy();
  await closeWs(second);
});

test('compacts persistent update churn while a room stays connected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'retro-yjs-security-churn-'));
  let server;
  t.after(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });
  server = await startServer({
    YJS_MAX_DOCUMENT_BYTES: String(4 * 1024 * 1024),
    YJS_ROOM_COMPACT_AFTER_BYTES: String(64 * 1024),
    YJS_ROOM_COMPACT_AFTER_UPDATES: '4',
    YJS_ROOM_COMPACTION_MIN_INTERVAL_MS: '1000',
    YJS_DOCUMENT_REMEASURE_MIN_INTERVAL_MS: '1000',
    YJS_ROOM_MAX_UNCOMPACTED_BYTES: String(2 * 1024 * 1024),
  }, root);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const ws = await openWs(`${server.wsUrl}/rooms/${session.roomHandle}`, { cookie: session.cookie });
  const source = new Y.Doc();
  const text = source.getText('churn');
  source.on('update', (update) => ws.send(encodeSyncUpdate(update)));

  const chunk = 'x'.repeat(32 * 1024);
  for (let cycle = 0; cycle < 20; cycle += 1) {
    text.insert(0, chunk);
    text.delete(0, chunk.length);
  }
  text.insert(0, 'survives-abrupt-restart');

  await waitFor(
    () => server.output().includes('room compacted'),
    `active-room compaction did not run\n${server.output()}`,
  );
  await waitFor(() => ws.bufferedAmount === 0, 'client WebSocket did not drain');
  await delay(300);
  assert.equal((await fetch(`${server.httpUrl}/readyz`)).status, 200);
  assert.ok(await directorySize(server.dbDir) < 8 * 1024 * 1024, 'compacted test DB grew unexpectedly');

  await server.killAbruptly();
  const persisted = new LeveldbPersistence(server.dbDir);
  const restored = await persisted.getYDoc(`yjs/board-${room.code}-${room.token}`);
  assert.equal(restored.getText('churn').toString(), 'survives-abrupt-restart');
  restored.destroy();
  await persisted.destroy();
});

test('gracefully drains an active WebSocket and persists its final state', async (t) => {
  const server = await startServer({ YJS_HTTP_SHUTDOWN_GRACE_MS: '100' });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const ws = await openWs(`${server.wsUrl}/rooms/${session.roomHandle}`, {
    cookie: session.cookie,
  });
  const source = new Y.Doc();
  let update;
  source.on('update', (nextUpdate) => { update = nextUpdate; });
  source.getText('shutdown').insert(0, 'survives-graceful-shutdown');
  ws.send(encodeSyncUpdate(update));
  await waitFor(() => ws.bufferedAmount === 0, 'shutdown update did not drain from the client');

  // Keep an otherwise valid anonymous create request stuck mid-body. Shutdown
  // must abort it after the bounded HTTP grace instead of waiting for the
  // longer ordinary request timeout and missing its final persistence flush.
  const { port } = new URL(server.httpUrl);
  const slowRequest = connect({ host: '127.0.0.1', port: Number(port) });
  t.after(() => slowRequest.destroy());
  await once(slowRequest, 'connect');
  slowRequest.write([
    'POST /api/rooms HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    `Origin: ${ALLOWED_ORIGIN}`,
    'Content-Type: application/json',
    'Content-Length: 100',
    'Connection: close',
    '',
    '{',
  ].join('\r\n'));
  await delay(25);

  const startedAt = Date.now();
  const result = await server.terminateGracefully();
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(result, { exitCode: 0, signalCode: null }, server.output());
  assert.ok(elapsedMs < 2_800, `graceful shutdown took ${elapsedMs}ms\n${server.output()}`);
  assert.match(server.output(), /\[yjs\] drained \{ rooms: 1 \}/);

  const persisted = new LeveldbPersistence(server.dbDir);
  const restored = await persisted.getYDoc(`yjs/board-${room.code}-${room.token}`);
  assert.equal(restored.getText('shutdown').toString(), 'survives-graceful-shutdown');
  restored.destroy();
  source.destroy();
  await persisted.destroy();
});

test('accepts bounded awareness echoes, binds one identity per connection, and reclaims it', async (t) => {
  const server = await startServer({
    YJS_MAX_AWARENESS_CLIENTS_PER_ROOM: '3',
    YJS_MAX_AWARENESS_IDS_PER_CONNECTION: '1',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const url = `${server.wsUrl}/rooms/${session.roomHandle}`;
  const observer = await openWs(url, { cookie: session.cookie });
  const attacker = await openWs(url, { cookie: session.cookie });
  const awareness = trackAwarenessStates(observer);

  observer.send(encodeAwareness([{
    clientId: 9001,
    clock: 5,
    state: { user: { name: 'owner' } },
  }]));
  await waitFor(
    () => awareness.states.get(9001)?.user?.name === 'owner',
    'owner awareness state was not broadcast',
  );
  attacker.send(encodeAwareness([{
    clientId: 1001,
    state: { user: { name: 'bounded' } },
  }]));
  await waitFor(
    () => awareness.states.get(1001)?.user?.name === 'bounded',
    'second owner awareness state was not broadcast',
  );

  // y-websocket echoes the multi-ID awareness snapshot it receives when a
  // third client connects. Even a newer foreign clock must be ignored without
  // disconnecting the relay or transferring/removing either real owner's ID.
  const snapshotRelay = await openWs(url, { cookie: session.cookie });
  snapshotRelay.send(encodeAwareness([
    {
      clientId: 9001,
      clock: 6,
      state: { user: { name: 'foreign-owner-1' } },
    },
    {
      clientId: 1001,
      clock: 2,
      state: { user: { name: 'foreign-owner-2' } },
    },
  ]));
  await delay(30);
  assert.equal(snapshotRelay.readyState, WebSocket.OPEN);
  assert.equal(awareness.states.get(9001)?.user?.name, 'owner');
  assert.equal(awareness.states.get(1001)?.user?.name, 'bounded');
  snapshotRelay.send(encodeAwareness([{
    clientId: 3001,
    state: { user: { name: 'third-owner' } },
  }]));
  await waitFor(
    () => awareness.states.get(3001)?.user?.name === 'third-owner',
    'third client could not claim its own awareness identity after the echo',
  );
  await closeWs(snapshotRelay);
  await waitFor(
    () => !awareness.states.has(3001),
    'third client awareness state was not reclaimed',
  );
  assert.equal(awareness.states.get(9001)?.user?.name, 'owner');
  assert.equal(awareness.states.get(1001)?.user?.name, 'bounded');
  assert.equal(observer.readyState, WebSocket.OPEN);

  // A null/non-null cycle keeps the same policy identity. y-websocket's own
  // controlled-ID set loses the ID during that cycle, so our close cleanup
  // must still remove the re-added state and its retained metadata.
  attacker.send(encodeAwareness([{ clientId: 1001, clock: 2, state: null }]));
  await waitFor(() => !awareness.states.has(1001), 'awareness null was not applied');
  attacker.send(encodeAwareness([{
    clientId: 1001,
    clock: 3,
    state: { user: { name: 're-added' } },
  }]));
  await waitFor(
    () => awareness.states.get(1001)?.user?.name === 're-added',
    'awareness identity was not re-added',
  );
  const rejected = once(attacker, 'close');
  attacker.send(encodeAwareness([{ clientId: 1002, state: { user: { name: 'second-id' } } }]));
  const [closeCode] = await rejected;
  assert.equal(closeCode, 1008);
  await waitFor(
    () => !awareness.states.has(1001),
    're-added awareness state survived its owner disconnect',
  );

  // Browsers echo server removal announcements. Once ownership metadata is
  // gone, that stale null must be a no-op rather than disconnecting the peer
  // or recreating unbounded awareness metadata.
  observer.send(encodeAwareness([{ clientId: 1001, clock: 3, state: null }]));
  await delay(30);
  assert.equal(observer.readyState, WebSocket.OPEN);
  assert.equal(awareness.states.has(1001), false);

  // Keep one anchor socket open while many short-lived peers use fresh IDs.
  // Without explicit metadata cleanup this eventually exhausts the room's
  // awareness cardinality even though only one peer is active at a time.
  for (let index = 0; index < 8; index += 1) {
    const peer = await openWs(url, { cookie: session.cookie });
    peer.send(encodeAwareness([{
      clientId: 2000 + index,
      state: { user: { name: `peer-${index}` } },
    }]));
    await delay(20);
    assert.equal(peer.readyState, WebSocket.OPEN);
    await closeWs(peer);
  }
  assert.equal((await fetch(`${server.httpUrl}/readyz`)).status, 200);
  awareness.stop();
  await closeWs(observer);
});

test('keeps three real y-websocket providers connected through awareness relay and removal echoes', async (t) => {
  const server = await startServer({
    YJS_MAX_AWARENESS_CLIENTS_PER_ROOM: '3',
    YJS_MAX_AWARENESS_IDS_PER_CONNECTION: '1',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const clients = [];

  class AuthenticatedWebSocket extends WebSocket {
    constructor(address, protocols) {
      super(address, protocols, websocketOptions(ALLOWED_ORIGIN, session.cookie));
    }
  }

  const addClient = (name) => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState({ user: { name } });
    const disconnects = [];
    const provider = new WebsocketProvider(
      server.wsUrl,
      `rooms/${session.roomHandle}`,
      doc,
      {
        WebSocketPolyfill: AuthenticatedWebSocket,
        awareness,
        params: { awarenessId: String(doc.clientID) },
      },
    );
    provider.on('status', ({ status }) => {
      if (status === 'disconnected') disconnects.push(Date.now());
    });
    const client = { awareness, disconnects, doc, provider, destroyed: false };
    clients.push(client);
    return client;
  };
  const destroyClient = (client) => {
    if (client.destroyed) return;
    client.destroyed = true;
    client.provider.destroy();
    client.doc.destroy();
  };
  const seesExactly = (client, expectedNames) => {
    const actual = new Set(Array.from(client.awareness.getStates().values())
      .map((state) => state?.user?.name)
      .filter(Boolean));
    return actual.size === expectedNames.length
      && expectedNames.every((name) => actual.has(name));
  };
  t.after(() => clients.forEach(destroyClient));

  const first = addClient('provider-1');
  const second = addClient('provider-2');
  await waitFor(
    () => first.provider.wsconnected
      && second.provider.wsconnected
      && seesExactly(first, ['provider-1', 'provider-2'])
      && seesExactly(second, ['provider-1', 'provider-2']),
    'first two providers did not converge',
  );

  const third = addClient('provider-3');
  await waitFor(
    () => clients.every((client) => client.provider.wsconnected
      && seesExactly(client, ['provider-1', 'provider-2', 'provider-3'])),
    'three providers did not converge',
  );
  await delay(100);
  assert.deepEqual(
    clients.map((client) => client.disconnects.length),
    [0, 0, 0],
    server.output(),
  );

  destroyClient(third);
  await waitFor(
    () => seesExactly(first, ['provider-1', 'provider-2'])
      && seesExactly(second, ['provider-1', 'provider-2']),
    'remaining providers did not converge after the third disconnected',
  );
  await delay(100);
  assert.equal(first.provider.wsconnected, true);
  assert.equal(second.provider.wsconnected, true);
  assert.deepEqual([first.disconnects.length, second.disconnects.length], [0, 0]);

  destroyClient(first);
  await waitFor(
    () => second.provider.wsconnected && seesExactly(second, ['provider-2']),
    'last provider did not survive the removal echo',
  );
  await delay(100);
  assert.equal(second.disconnects.length, 0);
  assert.doesNotMatch(server.output(), /protocol-policy close/);
});

test('rate-limits repeated full-state sync responses before encoding them', async (t) => {
  const maxDocumentBytes = 256 * 1024;
  const server = await startServer({
    YJS_MAX_DOCUMENT_BYTES: String(maxDocumentBytes),
    YJS_SYNC_RESPONSE_CONNECTION_BURST_BYTES: String(maxDocumentBytes),
    YJS_SYNC_RESPONSE_CONNECTION_BURST_MESSAGES: '2',
    YJS_SYNC_RESPONSES_PER_CONNECTION_PER_MINUTE: '1',
  });
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const url = `${server.wsUrl}/rooms/${session.roomHandle}`;
  const writer = await openWs(url, { cookie: session.cookie });
  const source = new Y.Doc();
  let largeUpdate;
  source.on('update', (update) => { largeUpdate = update; });
  source.getText('payload').insert(0, 'z'.repeat(180 * 1024));
  writer.send(encodeSyncUpdate(largeUpdate));
  await delay(100);

  const requester = await openWs(url, { cookie: session.cookie });
  const largeResponse = waitForWsMessage(requester, (data) => data.byteLength > 150 * 1024);
  requester.send(encodeSyncStep1());
  await largeResponse;
  const rejected = once(requester, 'close');
  requester.send(encodeSyncStep1());
  const [closeCode] = await rejected;
  assert.equal(closeCode, 1008);
  assert.equal(writer.readyState, WebSocket.OPEN);
  assert.equal((await fetch(`${server.httpUrl}/readyz`)).status, 200);
  await closeWs(writer);
});


test('four application providers sustain simultaneous motion without awareness echoes or disconnects', async (t) => {
  const server = await startServer();
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const clients = [];
  t.after(() => clients.forEach(({ motion, provider, doc }) => {
    motion.destroy(); provider.destroy(); doc.destroy();
  }));
  for (let index = 0; index < 4; index++) {
    let frames = 0;
    class Socket extends WebSocket {
      constructor(address, protocols) {
        super(address, protocols, websocketOptions(ALLOWED_ORIGIN, session.cookie));
      }
      send(data, ...args) {
        if (data[0] === 1) frames++;
        return super.send(data, ...args);
      }
    }
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(server.wsUrl, `rooms/${session.roomHandle}`, doc, {
      connect: false, disableBc: true, WebSocketPolyfill: Socket,
      params: { awarenessId: String(doc.clientID) },
    });
    sendOnlyLocalAwareness(provider);
    provider.awareness.setLocalStateField('user', { userId: `player-${index}` });
    const client = { doc, provider, motion: createMotionPublisher(provider.awareness), disconnects: 0, frames: () => frames };
    clients.push(client);
    provider.on('status', ({ status }) => { if (status === 'disconnected') client.disconnects++; });
    provider.connect();
  }
  await waitFor(() => clients.every(({ provider }) => provider.synced && provider.awareness.getStates().size === 4), 'players did not join');
  const before = clients.map((client) => client.frames());
  const started = Date.now();
  let sequence = 0;
  while (Date.now() - started < 8_100) {
    sequence++;
    for (const { motion } of clients) {
      motion.set('cursor', { x: sequence, y: 0, updatedAt: Date.now() });
      motion.set('view', { x: sequence, y: 0, zoom: 1, updatedAt: Date.now() });
    }
    await delay(24);
  }
  await waitFor(() => clients.every(({ provider }) => Array.from(provider.awareness.getStates().values())
    .every((state) => state.cursor?.x === sequence && state.view?.x === sequence)), 'final motion was not delivered');
  clients.forEach((client, index) => {
    assert.equal(client.disconnects, 0, server.output());
    assert.ok(client.frames() - before[index] <= 85, 'motion frames were echoed or not coalesced');
  });
  assert.doesNotMatch(server.output(), /rate-limit close|protocol-policy close/);
});


test('32 application providers sustain motion and persisted edits across compaction', async (t) => {
  const originalMaxListeners = process.getMaxListeners();
  process.setMaxListeners(originalMaxListeners + 32);
  t.after(() => process.setMaxListeners(originalMaxListeners));
  const server = await startServer(CAPACITY_PROFILE);
  t.after(server.stop);
  const room = await createRoom(server);
  const clients = [];
  t.after(() => clients.forEach(({ motion, provider, doc }) => {
    motion.destroy(); provider.destroy(); doc.destroy();
  }));
  let monitoring = false;
  let missingPlayers = 0;
  const latencies = [];
  for (let index = 0; index < 32; index++) {
    const session = await createSession(server, room);
    class Socket extends WebSocket {
      constructor(address, protocols) {
        super(address, protocols, websocketOptions(ALLOWED_ORIGIN, session.cookie));
      }
    }
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(server.wsUrl, `rooms/${session.roomHandle}`, doc, {
      connect: false, disableBc: true, WebSocketPolyfill: Socket,
      params: { awarenessId: String(doc.clientID) },
    });
    sendOnlyLocalAwareness(provider);
    provider.awareness.setLocalStateField('user', { userId: `player-${index}`, name: `Player ${index}`, lastSeen: Date.now() });
    const client = { doc, provider, motion: createMotionPublisher(provider.awareness), disconnects: 0 };
    clients.push(client);
    provider.on('status', ({ status }) => { if (status === 'disconnected') client.disconnects++; });
    provider.awareness.on('change', ({ added, updated }) => {
      if (!monitoring) return;
      if (provider.awareness.getStates().size !== 32) missingPlayers++;
      for (const id of [...added, ...updated]) {
        if (id === doc.clientID) continue;
        const at = provider.awareness.getStates().get(id)?.cursor?.updatedAt;
        if (at && index === 0) latencies.push(Date.now() - at);
      }
    });
    provider.connect();
    await waitFor(() => provider.synced, `player ${index} could not join`);
    if (index === 0) {
      doc.getText('board-content').insert(0, 'Representative board content. '.repeat(36_000));
      await delay(100);
    }
  }
  await waitFor(() => clients.every(({ provider }) => provider.awareness.getStates().size === 32), '32-player roster did not converge');
  assert.ok(Y.encodeStateAsUpdate(clients[0].doc).byteLength > 1024 * 1024);
  monitoring = true;
  const started = Date.now();
  let sequence = 0;
  let editSequence = 0;
  const editTimer = setInterval(() => {
    editSequence++;
    clients.forEach(({ doc }, index) => {
      doc.getMap('load-cards').set(`card-${index}`, { x: editSequence, text: `Player ${index} edit ${editSequence}` });
    });
  }, 60);
  t.after(() => clearInterval(editTimer));
  let lastBeatAt = 0;
  while (Date.now() - started < 70_000) {
    sequence++;
    const now = Date.now();
    const beat = now - lastBeatAt >= 5000;
    if (beat) lastBeatAt = now;
    clients.forEach(({ motion, doc, provider }, index) => {
      motion.set('cursor', { x: sequence, y: index, updatedAt: now });
      motion.set('view', { x: sequence, y: index, zoom: 1, updatedAt: now });
      if (beat) provider.awareness.setLocalStateField('user', { userId: `player-${index}`, name: `Player ${index}`, lastSeen: now });
    });
    await delay(24);
    assert.ok(clients.every((client) => client.disconnects === 0), server.output());
  }
  clearInterval(editTimer);
  await waitFor(() => clients.every(({ doc, provider }) => {
    const states = Array.from(provider.awareness.getStates().values());
    const cards = Array.from(doc.getMap('load-cards').values());
    return states.length === 32 && states.every((state) => state.cursor?.x === sequence && state.view?.x === sequence)
      && cards.length === 32 && cards.every((card) => card.x === editSequence);
  }), 'final cursor/view/edit state did not converge');
  assert.equal(missingPlayers, 0, 'players disappeared while connected');
  assert.ok(editSequence >= 1050, 'load generator did not sustain the intended edit rate');
  assert.ok((server.output().match(/room compacted/g) || []).length >= 2, 'scheduled compaction did not run again under sustained load');
  assert.doesNotMatch(server.output(), /rate-limit close|egress-limit close|protocol-policy close|room policy close/);
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  assert.ok(p95 < 2000, `p95 awareness delay was ${p95}ms`);
  assert.equal((await fetch(`${server.httpUrl}/readyz`)).status, 200);
  // Close clients, drain persistence, and read the actual persisted document.
  monitoring = false;
  for (const { motion, provider, doc } of clients) { motion.destroy(); provider.destroy(); doc.destroy(); }
  clients.length = 0;
  await server.terminateGracefully();
  const persisted = new LeveldbPersistence(server.dbDir);
  try {
    const restored = await persisted.getYDoc(`yjs/board-${room.code}-${room.token}`);
    assert.equal(restored.getMap('load-cards').size, 32);
    assert.ok(Array.from(restored.getMap('load-cards').values()).every((card) => card.x === editSequence));
    restored.destroy();
  } finally { await persisted.destroy(); }
  const restarted = await startServer(CAPACITY_PROFILE, server.root);
  try {
    await createSession(restarted, room);
    assert.equal((await fetch(`${restarted.httpUrl}/readyz`)).status, 200);
  } finally { await restarted.stop(); }
  t.diagnostic(`32 clients, 1MiB board, ${editSequence * 32} persisted edits, ${sequence} motion input samples/player, awareness p95=${p95}ms`);
});


test('32-client capacity profile still disconnects a flooding sender without evicting a healthy peer', async (t) => {
  const server = await startServer(CAPACITY_PROFILE);
  t.after(server.stop);
  const room = await createRoom(server);
  const session = await createSession(server, room);
  const url = `${server.wsUrl}/rooms/${session.roomHandle}`;
  const offender = await openWs(url, { cookie: session.cookie });
  const healthy = await openWs(url, { cookie: session.cookie });
  t.after(() => { offender.terminate(); healthy.terminate(); });
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  doc.getMap('test').set('value', 'valid-small-edit');
  const frame = encodeSyncUpdate(Y.encodeStateAsUpdate(doc));
  const closed = once(offender, 'close');
  for (let index = 0; index < 300; index++) offender.send(frame);
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.equal(healthy.readyState, WebSocket.OPEN);
  const reply = waitForWsMessage(healthy, (data) => data[0] === 0);
  healthy.send(encodeSyncStep1());
  await reply;
  assert.equal(healthy.readyState, WebSocket.OPEN);
  assert.match(server.output(), /rate-limit close/);
  assert.equal((await fetch(`${server.httpUrl}/readyz`)).status, 200);
});
