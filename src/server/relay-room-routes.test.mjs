import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRoomRoute } from './relay-room-routes.js';

const ORIGIN = 'https://allowed.example';
const HANDLE = 'A'.repeat(32);
const DOC_NAME = 'room-doc';
const IMAGE_NAME = '123e4567-e89b-12d3-a456-426614174000.png';
const response = () => ({
  headers: {}, status: undefined, ended: false,
  setHeader(name, value) { this.headers[name] = value; },
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
  end() { this.ended = true; },
});
const uploadsStub = () => {
  const calls = [];
  return {
    calls,
    handleUpload: (...args) => calls.push(['upload', ...args]),
    handleGetRoomImage: (...args) => calls.push(['image', ...args]),
    handleGetLegacyImage: (...args) => calls.push(['legacy', ...args]),
  };
};
const context = (overrides = {}) => ({
  hasQueryOrFragment: false,
  allowedOrigins: [ORIGIN],
  allowInsecureHttp: false,
  unavailable: false,
  rooms: new Map([[HANDLE, DOC_NAME]]),
  authenticate: () => null,
  uploads: uploadsStub(),
  clientIp: '203.0.113.9',
  ...overrides,
});
const req = (method, headers = {}) => ({ method, headers });

test('preflight for a registered room upload answers 204 with POST, OPTIONS', () => {
  const res = response();
  assert.equal(handleRoomRoute(req('OPTIONS', { origin: ORIGIN }), res, `/rooms/${HANDLE}/upload`, context()), true);
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
});

test('preflight for an unknown room handle answers 404', () => {
  const res = response();
  const unknown = 'B'.repeat(32);
  assert.equal(handleRoomRoute(req('OPTIONS', { origin: ORIGIN }), res, `/rooms/${unknown}/upload`, context()), true);
  assert.equal(res.status, 404);
});

test('upload without a room session answers 401 and never calls uploads.handleUpload', () => {
  const ctx = context();
  const res = response();
  assert.equal(handleRoomRoute(req('POST', { origin: ORIGIN }), res, `/rooms/${HANDLE}/upload`, ctx), true);
  assert.equal(res.status, 401);
  assert.equal(ctx.uploads.calls.length, 0);
});

test('upload with a room session is handed to uploads for that room document', () => {
  const ctx = context({ authenticate: () => ({ docName: DOC_NAME }) });
  const request = req('POST', { origin: ORIGIN });
  assert.equal(handleRoomRoute(request, response(), `/rooms/${HANDLE}/upload`, ctx), true);
  assert.deepEqual([ctx.uploads.calls[0][0], ...ctx.uploads.calls[0].slice(4)], ['upload', DOC_NAME, HANDLE]);
});

test('room image with a foreign Origin answers 403', () => {
  const res = response();
  const ctx = context({ authenticate: () => ({ docName: DOC_NAME }) });
  const request = req('GET', { origin: 'https://hostile.example' });
  assert.equal(handleRoomRoute(request, res, `/rooms/${HANDLE}/images/${IMAGE_NAME}`, ctx), true);
  assert.equal(res.status, 403);
  assert.equal(ctx.uploads.calls.length, 0);
});

test('legacy image path is delegated to uploads', () => {
  const ctx = context();
  assert.equal(handleRoomRoute(req('GET'), response(), '/images/abc.png', ctx), true);
  assert.equal(ctx.uploads.calls[0][0], 'legacy');
  assert.equal(ctx.uploads.calls[0][1], 'abc.png');
});

test('unrelated path returns false and writes nothing', () => {
  const res = response();
  assert.equal(handleRoomRoute(req('GET'), res, '/api/rooms', context()), false);
  assert.equal(res.status, undefined);
  assert.equal(res.ended, false);
});

test('preflight for room creation and session exchange answers 204; with a query it is not handled', () => {
  for (const path of ['/api/rooms', '/api/room-session']) {
    const res = response();
    assert.equal(handleRoomRoute(req('OPTIONS', { origin: ORIGIN }), res, path, context()), true);
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-methods'], 'POST, OPTIONS');
  }
  const res = response();
  assert.equal(handleRoomRoute(req('OPTIONS', { origin: ORIGIN }), res, '/api/rooms', context({ hasQueryOrFragment: true })), false);
});

test('preflight for the lock routes is credentialed for allowed origins only', () => {
  for (const suffix of ['password', 'rotate/begin', 'rotate/commit', 'rotate/abort']) {
    const allowed = response();
    assert.equal(handleRoomRoute(req('OPTIONS', { origin: ORIGIN }), allowed, `/api/rooms/${HANDLE}/lock/${suffix}`, context()), true);
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
    assert.equal(allowed.headers['access-control-allow-methods'], 'POST, OPTIONS');
    const foreign = response();
    handleRoomRoute(req('OPTIONS', { origin: 'https://evil.example' }), foreign, `/api/rooms/${HANDLE}/lock/${suffix}`, context());
    assert.equal(foreign.status, 403);
  }
  assert.equal(handleRoomRoute(req('OPTIONS', { origin: ORIGIN }), response(), `/api/rooms/${HANDLE}/lock/other`, context()), false);
});
