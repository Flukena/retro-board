import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { relayEntrypoint } from '../test-support/relay-entrypoint.js';
import * as uploadModule from './relay-uploads.js';
import * as sessionModule from './relay-session.js';
import * as publicWallModule from './relay-public-wall.js';
import * as publicConfig from './public-wall-config.js';
import * as trafficModule from './relay-ws-traffic.js';
import { RelayPublicWall } from './relay-public-wall.js';
import { docs as relayDocs } from '../../node_modules/y-websocket/bin/utils.js';
import * as Y from 'yjs';
import * as configHelpers from './relay-config.js';
import { createRoomSessionRoutes } from './room-session-routes.js';
import { acceptCredentialOrigin, isExactAllowedOrigin, readJsonBody, sendJson, sendIfWritable, sendUpgradeRejection, sendCredentialPreflight } from './relay-http.js';

const ORIGIN = 'https://allowed.example';
const MAX_BODY_BYTES = 16;
const HTTP_DISPATCH_TIMEOUT_MS = 5_000;
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
    'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true',
    'access-control-expose-headers': 'Retry-After', vary: 'Origin',
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
const entrypointHttp = async (t, overrides = {}) => {
  const context = {
    ...configHelpers.readRelayConfig({}),
    shuttingDown: false, storageFailure: null, PUBLIC_WALL: false, publicWall: null,
    registeredRoomsByHandle: new Map([[ROOM_HANDLE, 'doc']]),
    authenticatedDocFromRequest: () => null,
    takeCreateToken: () => 0, createRegisteredRoom: async () => ({ code: 'abc', token: 'capability' }),
    markStorageFailure() { assert.fail('unexpected storage failure'); },
    failureAttemptAvailable: () => true, recordSessionFailure() {},
    registeredDocForCapability: () => null,
    takeSessionExchangeToken: () => true, roomHandleForDoc: () => ROOM_HANDLE,
    createSessionCookie: () => 'scoped-cookie',
    uploads: { handleUpload() { assert.fail('unexpected upload dispatch'); },
      handleGetRoomImage() { assert.fail('unexpected image dispatch'); },
      handleGetLegacyImage() { assert.fail('unexpected legacy dispatch'); } },
    ...overrides,
  };
  // Session handlers are real; the complete entrypoint dispatches to this injected instance.
  const routes = createRoomSessionRoutes({
    registry: {
      createRoom: () => context.createRegisteredRoom(), registeredDocForCapability: (...args) => context.registeredDocForCapability(...args),
      roomHandleForDoc: (...args) => context.roomHandleForDoc(...args), isLocked: () => false,
    },
    sessions: { createCookie: (...args) => context.createSessionCookie(...args) },
    // These requests carry no account cookie, so a guest create never reaches the account store.
    accountSessions: { read: () => null },
    accountStore: { get() { assert.fail('unexpected account read'); } },
    buckets: {
      takeCreateToken: (...args) => context.takeCreateToken(...args), takeSessionExchangeToken: (...args) => context.takeSessionExchangeToken(...args),
      failureAttemptAvailable: (...args) => context.failureAttemptAvailable(...args), recordSessionFailure: (...args) => context.recordSessionFailure(...args),
    },
    config: { allowedOrigins: [ORIGIN], allowInsecureHttp: false, sessionTtlMs: context.ROOM_SESSION_TTL_MS, maxApiBodyBytes: context.MAX_API_BODY_BYTES },
    unavailable: () => context.shuttingDown || Boolean(context.storageFailure),
    onStorageFailure: (...args) => context.markStorageFailure(...args),
  });
  const state = await relayEntrypoint(t, { modules: {
    './src/server/room-session-routes.js': { createRoomSessionRoutes: () => routes },
    './src/server/relay-uploads.js': { ...uploadModule, createRelayUploads: () => context.uploads },
    './src/server/relay-session.js': { ...sessionModule, RoomSessions: class {
      createCookie(...args) { return context.createSessionCookie(...args); }
      authenticate(...args) { return context.authenticatedDocFromRequest(...args); }
    } },
    './src/server/public-wall-config.js': { ...publicConfig,
      isPublicWallEnabled: () => context.PUBLIC_WALL, publicRelayEnvironment: env => env,
    },
    './src/server/relay-public-wall.js': { ...publicWallModule,
      provisionPublicWall: async () => context.publicWall,
    },
    './src/server/relay-ws-traffic.js': { ...trafficModule, RelayWsTraffic: class extends trafficModule.RelayWsTraffic {
      constructor(...args) { super(...args); if (context.wsTraffic) this.connectionsByRoom = context.wsTraffic.connectionsByRoom; }
    } },
  } });
  state.registry.registeredRoomsByHandle.clear();
  for (const [handle, docName] of context.registeredRoomsByHandle) state.registry.registeredRoomsByHandle.set(handle, docName);
  if (context.shuttingDown) state.lifecycle.onStart('test drain');
  // Public snapshots must read the same real document map used by the entrypoint.
  if (context.docs) {
    for (const [name, doc] of context.docs) relayDocs.set(name, doc);
    t.after(() => { for (const name of context.docs.keys()) relayDocs.delete(name); });
  }
  return {
    dispatch: state.dispatch,
    handleCreateRoom: throughEntrypoint(state.dispatch, '/yjs/api/rooms'),
    handleRoomSession: throughEntrypoint(state.dispatch, '/yjs/api/room-session'),
  };
};
const throughEntrypoint = (dispatch, url) => (req, res) => new Promise(resolve => {
  const end = res.end;
  res.end = function (...args) { end.apply(this, args); resolve(); };
  dispatch(Object.assign(req, { method: 'POST', url }), res);
});
const routeRequest = (method, url, origin = ORIGIN) => ({ method, url, headers: { origin } });
const routeResponse = () => Object.assign(response(), { once() {} });

test('entrypoint preserves preflight headers and origin before unknown-room precedence', async t => {
  const { dispatch } = await entrypointHttp(t);
  const accepted = routeResponse();
  dispatch(routeRequest('OPTIONS', '/yjs/api/rooms'), accepted);
  assert.equal(accepted.status, 204);
  assert.deepEqual(accepted.headers, {
    'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true',
    'access-control-expose-headers': 'Retry-After', vary: 'Origin',
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

test('entrypoint preserves upload origin, unavailable, room and session guard precedence', async t => {
  for (const [overrides, handle, origin, expected] of [
    [{ shuttingDown: true }, UNKNOWN_HANDLE, 'https://hostile.example', 403],
    [{ shuttingDown: true }, UNKNOWN_HANDLE, ORIGIN, 503],
    [{}, UNKNOWN_HANDLE, ORIGIN, 404],
    [{}, ROOM_HANDLE, ORIGIN, 401],
  ]) {
    const { dispatch } = await entrypointHttp(t, overrides);
    const res = routeResponse();
    dispatch(routeRequest('POST', `/yjs/rooms/${handle}/upload`, origin), res);
    assert.equal(res.status, expected);
    assert.equal(res.body, undefined);
  }
});

test('entrypoint image access retains unknown room before session and skips origin checks', async t => {
  const { dispatch } = await entrypointHttp(t);
  for (const [handle, status] of [[UNKNOWN_HANDLE, 404], [ROOM_HANDLE, 401]]) {
    const res = routeResponse();
    dispatch(routeRequest('GET', `/rooms/${handle}/images/abcdef01.png`, 'https://hostile.example'), res);
    assert.equal(res.status, status);
    assert.deepEqual(res.headers, {});
  }
});

test('entrypoint retains creation and session JSON error and failure-budget precedence', { timeout: HTTP_DISPATCH_TIMEOUT_MS }, async t => {
  const limited = await entrypointHttp(t, { takeCreateToken: () => 60 });
  const create = routeResponse();
  await limited.handleCreateRoom(request(['bad'], { origin: ORIGIN, 'content-type': 'text/plain' }), create, 'ip');
  assert.equal(create.status, 429);
  assert.equal(create.headers['retry-after'], '60');
  assert.equal(create.headers['cache-control'], 'no-store');
  let failures = 0;
  const session = await entrypointHttp(t, { failureAttemptAvailable: () => false, recordSessionFailure() { failures += 1; } });
  const denied = routeResponse();
  await session.handleRoomSession(request(['bad'], { origin: ORIGIN }), denied, 'ip', true);
  assert.equal(denied.status, 429);
  assert.equal(denied.headers['retry-after'], '60');
  assert.equal(failures, 0);
  const invalid = routeResponse();
  await (await entrypointHttp(t)).handleRoomSession(request(['{}'], { origin: ORIGIN }), invalid, 'ip', true);
  assert.equal(invalid.status, 404);
});

test('entrypoint retains successful room creation and signed session response shape', { timeout: HTTP_DISPATCH_TIMEOUT_MS }, async t => {
  const endpoints = await entrypointHttp(t, { registeredDocForCapability: () => 'doc' });
  const created = routeResponse();
  await endpoints.handleCreateRoom(request(['{}'], { origin: ORIGIN }), created, 'ip');
  assert.equal(created.status, 201);
  assert.equal(created.body, '{"code":"abc","token":"capability"}');
  const session = routeResponse();
  await endpoints.handleRoomSession(request(['{"code":"abc","token":"capability"}'], { origin: ORIGIN }), session, 'ip', true);
  assert.equal(session.status, 200);
  assert.equal(JSON.parse(session.body).roomHandle, ROOM_HANDLE);
  assert.equal(Number.isSafeInteger(JSON.parse(session.body).expiresAt), true);
  assert.equal(session.headers['set-cookie'], 'scoped-cookie');
  assert.equal(session.headers['cache-control'], 'no-store');
});

test('public entrypoint dispatches isolated snapshot and writer admission without private handlers', async t => {
  const doc = new Y.Doc();
  t.after(() => doc.destroy());
  doc.getMap('items').set('visible', new Y.Map([['type', 'text'], ['x', 0], ['y', 0], ['text', 'public']]));
  const publicWall = new RelayPublicWall({ docName: 'public-document', roomHandle: ROOM_HANDLE });
  const connections = new Map();
  const { dispatch } = await entrypointHttp(t, { PUBLIC_WALL: true, publicWall,
    docs: new Map([['public-document', doc]]), wsTraffic: { connectionsByRoom: connections } });
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
});

test('authenticated image reads expose credentialed CORS only to an exact allowed origin', async t => {
  let reads = 0;
  const { dispatch } = await entrypointHttp(t, { authenticatedDocFromRequest: () => ({ docName: 'doc' }),
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

test('allowed-origin image authentication errors remain readable for the client session refresh flow', async t => {
  const { dispatch } = await entrypointHttp(t); const res=routeResponse();
  dispatch(routeRequest('GET', `/rooms/${ROOM_HANDLE}/images/abcdef01.png`),res);
  assert.equal(res.status,401); assert.equal(res.headers['access-control-allow-origin'],ORIGIN);
});

test('preflight rejects a foreign Origin and sets max-age', () => {
  const denied = response();
  sendCredentialPreflight({ headers: { origin: 'https://hostile.example' } }, denied, { allowedOrigins: [ORIGIN], allowInsecureHttp: false, methods: 'POST, OPTIONS' });
  assert.equal(denied.status, 403);
  const accepted = response();
  sendCredentialPreflight({ headers: { origin: ORIGIN } }, accepted, { allowedOrigins: [ORIGIN], allowInsecureHttp: false, methods: 'POST, OPTIONS' });
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(accepted.headers['access-control-allow-headers'], 'Content-Type');
  assert.equal(accepted.headers['access-control-max-age'], String(configHelpers.CORS_PREFLIGHT_MAX_AGE_SECONDS));
  assert.equal(accepted.headers['cache-control'], 'no-store');
});
