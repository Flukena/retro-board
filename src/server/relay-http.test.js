import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { RelayPublicWall } from './relay-public-wall.js';
import { PUBLIC_RELAY_PREFIX } from '../domain/public-wall-contract.js';
import * as Y from 'yjs';
import * as configHelpers from './relay-config.js';
import { isRelayReady } from './relay-lifecycle.js';
import { setCredentialCors, acceptCredentialOrigin, isExactAllowedOrigin, readJsonBody, sendJson, sendIfWritable, sendUpgradeRejection } from './relay-http.js';

const ORIGIN = 'https://allowed.example';
const MAX_BODY_BYTES = 16;
const response = () => ({
  headers: {}, body: undefined, status: undefined,
  setHeader(name, value) { this.headers[name] = value; },
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
  end(body) { this.body = body; this.writableEnded = true; },
});
const request = (chunks, headers = {}) => Object.assign(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), {
  headers: { 'content-type': 'application/json', ...headers },
});

test('origin rejection precedes CORS and localhost fallback remains exact', () => {
  const denied = response();
  assert.equal(acceptCredentialOrigin({ headers: { origin: 'https://hostile.example' } }, denied, [ORIGIN], false), false);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.headers, {});
  assert.equal(denied.body, undefined);
  const accepted = response();
  assert.equal(acceptCredentialOrigin({ headers: { origin: ORIGIN } }, accepted, [ORIGIN], false), true);
  assert.deepEqual(accepted.headers, {
    'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true', vary: 'Origin',
  });
  assert.equal(isExactAllowedOrigin('http://localhost:5173', [], true), true);
  assert.equal(isExactAllowedOrigin('http://localhost:5173/', [], true), false);
  assert.equal(isExactAllowedOrigin('http://localhost:5173', [ORIGIN], true), false);
  assert.equal(isExactAllowedOrigin('', [], true), false);
});

test('JSON media rejection precedes length and only objects are accepted', async () => {
  await assert.rejects(readJsonBody(request(['{}'], { 'content-type': 'text/plain', 'content-length': '999' }), MAX_BODY_BYTES), { code: 'BAD_JSON' });
  for (const text of ['null', '[]', '1', 'false', '{']) {
    await assert.rejects(readJsonBody(request([text]), MAX_BODY_BYTES), { code: 'BAD_JSON' });
  }
  assert.deepEqual(await readJsonBody(request(['{"a":', '1}']), MAX_BODY_BYTES), { a: 1 });
  assert.deepEqual(await readJsonBody(request([]), MAX_BODY_BYTES, { allowEmpty: true }), {});
  await assert.rejects(readJsonBody(request([]), MAX_BODY_BYTES), { code: 'BAD_JSON' });
});

test('JSON limits accept exact bytes and reject declared or streamed excess', async () => {
  const exact = '{"a":"12345678"}';
  assert.deepEqual(await readJsonBody(request([exact], { 'content-length': '16' }), MAX_BODY_BYTES), { a: '12345678' });
  await assert.rejects(readJsonBody(request([exact, ' ']), MAX_BODY_BYTES), { code: 'BODY_TOO_LARGE' });
  for (const length of ['17', '-1', 'NaN']) {
    await assert.rejects(readJsonBody(request(['{}'], { 'content-length': length }), MAX_BODY_BYTES), { code: 'BODY_TOO_LARGE' });
  }
});

test('JSON and empty responses retain exact headers, body and writable guards', () => {
  const res = response();
  sendJson(res, 201, { name: 'ไทย' }, { 'set-cookie': 'golden-cookie' });
  assert.equal(res.status, 201);
  assert.equal(res.body, '{"name":"ไทย"}');
  assert.deepEqual(res.headers, {
    'content-type': 'application/json', 'content-length': 20, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'set-cookie': 'golden-cookie',
  });
  sendJson(res, 500, {});
  assert.equal(res.status, 201);
  const destroyed = response(); destroyed.destroyed = true;
  sendIfWritable(destroyed, 500);
  assert.equal(destroyed.status, undefined);
  const empty = response(); sendIfWritable(empty, 429, { 'retry-after': '2' });
  assert.equal(empty.body, undefined);
  assert.equal(empty.status, 429);
});

test('upgrade rejection bytes and socket failure behavior remain exact', () => {
  const reasons = new Map([[400, 'Bad Request'], [401, 'Unauthorized'], [403, 'Forbidden'],
    [404, 'Not Found'], [431, 'Request Header Fields Too Large'], [429, 'Too Many Requests'], [503, 'Service Unavailable']]);
  for (const [status, reason] of reasons) {
    let body;
    sendUpgradeRejection({ end(value) { body = value; } }, status);
    assert.equal(body, `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  let destroyed = false;
  sendUpgradeRejection({ end() { throw new Error('closed'); }, destroy() { destroyed = true; } }, 503);
  assert.equal(destroyed, true);
});

const ROOM_HANDLE = 'a'.repeat(32);
const UNKNOWN_HANDLE = 'b'.repeat(32);
const SERVER_SOURCE = readFileSync(new URL('../../yjs-server.mjs', import.meta.url), 'utf8');
const sourceSection = (start, end) => {
  const offset = SERVER_SOURCE.indexOf(start);
  assert.ok(offset >= 0, `missing entrypoint seam ${start}`);
  const endOffset = SERVER_SOURCE.indexOf(end, offset);
  assert.ok(endOffset > offset, `missing entrypoint seam ${end}`);
  return SERVER_SOURCE.slice(offset, endOffset);
};
const entrypointHttp = (overrides = {}) => {
  let dispatch;
  const context = {
    ...configHelpers, ...configHelpers.readRelayConfig({}),
    URL, Buffer, Object, Date, String, Number,
    isRelayReady, isExactAllowedOrigin, setCredentialCors, acceptCredentialOrigin, readJsonBody, sendJson, sendIfWritable,
    ALLOWED_ORIGINS: [ORIGIN], ALLOW_INSECURE_HTTP: false,
    shuttingDown: false, storageFailure: null, PUBLIC_WALL: false, publicWall: null,
    registeredRoomsByHandle: new Map([[ROOM_HANDLE, 'doc']]),
    clientIpFromRequest: () => 'test-ip',
    reserveHttpRequest: () => ({ status: 0, release() {} }),
    rejectionCounters: { observeResponse() {} },
    authenticatedDocFromRequest: () => null,
    takeCreateToken: () => true, createRegisteredRoom: async () => ({ code: 'abc', token: 'capability' }),
    markStorageFailure() { assert.fail('unexpected storage failure'); },
    failureAttemptAvailable: () => true, recordSessionFailure() {},
    registeredDocForCapability: () => null,
    takeSessionExchangeToken: () => true, roomHandleForDoc: () => ROOM_HANDLE,
    createSessionCookie: () => 'scoped-cookie',
    http: { createServer(_options, callback) { dispatch = callback; return {}; } },
    uploads: { handleUpload() { assert.fail('unexpected upload dispatch'); },
      handleGetRoomImage() { assert.fail('unexpected image dispatch'); },
      handleGetLegacyImage() { assert.fail('unexpected legacy dispatch'); } },
    ...overrides,
  };
  const handlers = sourceSection('const handleCreateRoom =', '\nconst globalTrafficLimits');
  const server = sourceSection('const server = http.createServer', '\nserver.requestTimeout');
  const endpoints = runInNewContext(`${handlers}\n${server}\n({ handleCreateRoom, handleRoomSession });`, context);
  return { dispatch, ...endpoints };
};
const routeRequest = (method, url, origin = ORIGIN) => ({ method, url, headers: { origin } });
const routeResponse = () => Object.assign(response(), { once() {} });

test('entrypoint preserves preflight headers and origin before unknown-room precedence', () => {
  const { dispatch } = entrypointHttp();
  const accepted = routeResponse();
  dispatch(routeRequest('OPTIONS', '/yjs/api/rooms'), accepted);
  assert.equal(accepted.status, 204);
  assert.deepEqual(accepted.headers, {
    'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true', vary: 'Origin',
    'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type',
    'access-control-max-age': '600', 'cache-control': 'no-store',
  });
  const denied = routeResponse();
  dispatch(routeRequest('OPTIONS', `/yjs/rooms/${UNKNOWN_HANDLE}/upload`, 'https://hostile.example'), denied);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.headers, {});
  const unknown = routeResponse();
  dispatch(routeRequest('OPTIONS', `/rooms/${UNKNOWN_HANDLE}/upload`), unknown);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers['access-control-allow-origin'], ORIGIN);
});

test('entrypoint preserves upload origin, unavailable, room and session guard precedence', () => {
  for (const [overrides, handle, origin, expected] of [
    [{ shuttingDown: true }, UNKNOWN_HANDLE, 'https://hostile.example', 403],
    [{ shuttingDown: true }, UNKNOWN_HANDLE, ORIGIN, 503],
    [{}, UNKNOWN_HANDLE, ORIGIN, 404],
    [{}, ROOM_HANDLE, ORIGIN, 401],
  ]) {
    const { dispatch } = entrypointHttp(overrides);
    const res = routeResponse();
    dispatch(routeRequest('POST', `/yjs/rooms/${handle}/upload`, origin), res);
    assert.equal(res.status, expected);
    assert.equal(res.body, undefined);
  }
});

test('entrypoint image access retains unknown room before session and skips origin checks', () => {
  const { dispatch } = entrypointHttp();
  for (const [handle, status] of [[UNKNOWN_HANDLE, 404], [ROOM_HANDLE, 401]]) {
    const res = routeResponse();
    dispatch(routeRequest('GET', `/rooms/${handle}/images/abcdef01.png`, 'https://hostile.example'), res);
    assert.equal(res.status, status);
    assert.deepEqual(res.headers, {});
  }
});

test('entrypoint retains creation and session JSON error and failure-budget precedence', async () => {
  const limited = entrypointHttp({ takeCreateToken: () => false });
  const create = response();
  await limited.handleCreateRoom(request(['bad'], { origin: ORIGIN, 'content-type': 'text/plain' }), create, 'ip');
  assert.equal(create.status, 429);
  assert.equal(create.headers['retry-after'], '60');
  assert.equal(create.headers['cache-control'], 'no-store');
  let failures = 0;
  const session = entrypointHttp({ failureAttemptAvailable: () => false, recordSessionFailure() { failures += 1; } });
  const denied = response();
  await session.handleRoomSession(request(['bad'], { origin: ORIGIN }), denied, 'ip', true);
  assert.equal(denied.status, 429);
  assert.equal(denied.headers['retry-after'], '60');
  assert.equal(failures, 0);
  const invalid = response();
  await entrypointHttp().handleRoomSession(request(['{}'], { origin: ORIGIN }), invalid, 'ip', true);
  assert.equal(invalid.status, 404);
});

test('entrypoint retains successful room creation and signed session response shape', async () => {
  const endpoints = entrypointHttp({ registeredDocForCapability: () => 'doc' });
  const created = response();
  await endpoints.handleCreateRoom(request(['{}'], { origin: ORIGIN }), created, 'ip');
  assert.equal(created.status, 201);
  assert.equal(created.body, '{"code":"abc","token":"capability"}');
  const session = response();
  await endpoints.handleRoomSession(request(['{"code":"abc","token":"capability"}'], { origin: ORIGIN }), session, 'ip', true);
  assert.equal(session.status, 200);
  assert.equal(JSON.parse(session.body).roomHandle, ROOM_HANDLE);
  assert.equal(Number.isSafeInteger(JSON.parse(session.body).expiresAt), true);
  assert.equal(session.headers['set-cookie'], 'scoped-cookie');
  assert.equal(session.headers['cache-control'], 'no-store');
});

test('public entrypoint dispatches isolated snapshot and writer admission without private handlers', () => {
  const doc = new Y.Doc();
  doc.getMap('items').set('visible', new Y.Map([['type', 'text'], ['x', 0], ['y', 0], ['text', 'public']]));
  const publicWall = new RelayPublicWall({ docName: 'public-document', roomHandle: ROOM_HANDLE });
  const connections = new Map();
  const { dispatch } = entrypointHttp({ PUBLIC_WALL: true, PUBLIC_RELAY_PREFIX, publicWall,
    docs: new Map([['public-document', doc]]), wsConnectionsByRoom: connections });
  const snapshot = routeResponse();
  dispatch(routeRequest('GET', '/yjs-public/api/snapshot'), snapshot);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers['cache-control'], 'public, max-age=10');
  assert.equal(JSON.parse(snapshot.body).items[0].text, 'public');
  const session = routeResponse();
  dispatch(routeRequest('POST', '/yjs-public/api/public-session'), session);
  assert.equal(session.status, 200);
  assert.equal(session.headers['set-cookie'], 'scoped-cookie');
  connections.set('public-document', 500);
  const full = routeResponse();
  dispatch(routeRequest('POST', '/yjs-public/api/public-session'), full);
  assert.equal(full.status, 429);
  const creation = routeResponse();
  dispatch(routeRequest('POST', '/yjs-public/api/rooms'), creation);
  assert.equal(creation.status, 404);
  const upload = routeResponse();
  dispatch(routeRequest('POST', `/yjs-public/rooms/${ROOM_HANDLE}/upload`), upload);
  assert.equal(upload.status, 401);
  assert.equal(upload.headers['cache-control'], 'no-store');
  const foreignUpload = routeResponse();
  dispatch(routeRequest('POST', `/yjs-public/rooms/${UNKNOWN_HANDLE}/upload`), foreignUpload);
  assert.equal(foreignUpload.status, 404);
  doc.destroy();
});

test('room target parser accepts public opaque handles and rejects capability-bearing or malformed targets', () => {
  const source = sourceSection('const roomTargetFromRequest =', '\nconst normalizeIp');
  const parsePublic = runInNewContext(`${source}\nroomTargetFromRequest;`, { PUBLIC_WALL: true, Number });
  const parsePrivate = runInNewContext(`${source}\nroomTargetFromRequest;`, { PUBLIC_WALL: false, Number });
  assert.equal(parsePublic({ url: `/yjs-public/rooms/${ROOM_HANDLE}?awarenessId=42` }).handle, ROOM_HANDLE);
  assert.equal(parsePrivate({ url: `/yjs-public/rooms/${ROOM_HANDLE}` }), null);
  for (const suffix of ['#secret', '?token=secret', '?awarenessId=-1', '?awarenessId=42&token=secret']) {
    assert.equal(parsePublic({ url: `/yjs-public/rooms/${ROOM_HANDLE}${suffix}` }), null);
  }
});

test('authenticated image reads expose credentialed CORS only to an exact allowed origin', () => {
  let reads = 0;
  const { dispatch } = entrypointHttp({ authenticatedDocFromRequest: () => ({ docName: 'doc' }),
    uploads: { handleGetRoomImage(_handle, _image, _ip, res) { reads++; res.writeHead(200); res.end(); } } });
  const allowed = routeResponse();
  dispatch(routeRequest('GET', `/rooms/${ROOM_HANDLE}/images/abcdef01.png`), allowed);
  assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  const hostile = routeResponse();
  dispatch(routeRequest('GET', `/rooms/${ROOM_HANDLE}/images/abcdef01.png`, 'https://hostile.example'), hostile);
  assert.equal(hostile.status, 403); assert.equal(reads, 1);
  const native = routeResponse();
  // Native image requests have no Origin header and keep their existing cookie-only access.
  const noOrigin = routeRequest('GET', `/rooms/${ROOM_HANDLE}/images/abcdef01.png`); delete noOrigin.headers.origin;
  dispatch(noOrigin, native); assert.equal(native.status, 200);
});

test('allowed-origin image authentication errors remain readable for the client session refresh flow', () => {
  const { dispatch } = entrypointHttp(); const res=routeResponse();
  dispatch(routeRequest('GET', `/rooms/${ROOM_HANDLE}/images/abcdef01.png`),res);
  assert.equal(res.status,401); assert.equal(res.headers['access-control-allow-origin'],ORIGIN);
});
