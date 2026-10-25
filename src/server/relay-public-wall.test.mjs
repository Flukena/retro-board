import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

const ALLOWED_ORIGIN = 'https://retro.example';
const HANDLE = 'Abcdefghijklmnopqrstuvwxyz012345';
const DOC_NAME = 'private-canonical-name';
const CLIENT_IP = '127.0.0.1';
const IMAGE_ID = 'abcdef01.png';
const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; },
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
  end(body) { this.body = body; } });
const context = () => ({ allowedOrigins: [ALLOWED_ORIGIN], allowInsecureHttp: false,
  unavailable: false, takeSessionExchangeToken: () => true, writerCount: 0,
  sessionTtlMs: 60000, createSessionCookie: (_handle, _expiry, _name, path) => `signed; Path=${path}` });
const wall = async () => {
  const { RelayPublicWall } = await import('./relay-public-wall.js');
  return new RelayPublicWall({ docName: DOC_NAME, roomHandle: HANDLE });
};
test('public session uses origin checks, shared rate admission, scoped cookie and no capability', async () => {
  const publicWall = await wall();
  const req = { method: 'POST', headers: { origin: ALLOWED_ORIGIN } };
  const ctx = context();
  const res = response();
  publicWall.handleRequest(req, res, '/api/public-session', true, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['set-cookie'], new RegExp(`Path=/yjs-public/rooms/${HANDLE}$`));
  assert.deepEqual(Object.keys(JSON.parse(res.body)).sort(), ['expiresAt', 'roomHandle']);
  assert.equal(res.body.includes(DOC_NAME), false);
  for (const [override, status] of [[{ takeSessionExchangeToken: () => false }, 429], [{ writerCount: 500 }, 429], [{ unavailable: true }, 503]]) {
    const refused = response();
    publicWall.handleRequest(req, refused, '/api/public-session', false, { ...ctx, ...override });
    assert.equal(refused.status, status);
    assert.equal(refused.headers['set-cookie'], undefined);
  }
  const hostile = response();
  publicWall.handleRequest({ ...req, headers: { origin: 'https://evil.example' } }, hostile, '/api/public-session', false, ctx);
  assert.equal(hostile.status, 403);
});
test('public routes reject private APIs, legacy media and other handles, including OPTIONS', async () => {
  const publicWall = await wall();
  for (const method of ['POST', 'GET', 'OPTIONS']) {
    for (const path of ['/api/rooms', '/api/room-session', '/rooms/other/upload', '/rooms/other/images/a.png', '/images/a.png']) {
      const res = response();
      assert.equal(publicWall.handleRequest({ method, headers: {} }, res, path, true, context()), true);
      assert.equal(res.status, 404);
    }
  }
});

test('public upload admission requires exact origin and signed own-room session before using shared upload limits', async () => {
  const publicWall = await wall();
  const calls = [];
  const ctx = { ...context(), clientIp: CLIENT_IP, sessionAuthenticated: true,
    uploads: { handleUpload(...args) { calls.push(args); args[1].writeHead(200); args[1].end(); } } };
  const req = { method: 'POST', headers: { origin: ALLOWED_ORIGIN } };
  const accepted = response();
  assert.equal(publicWall.handleRequest(req, accepted, `/rooms/${HANDLE}/upload`, true, ctx), true);
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls[0], [req, accepted, CLIENT_IP, DOC_NAME, HANDLE]);
  for (const [headers, override, status] of [
    [{}, {}, 403], [{ origin: 'https://evil.example' }, {}, 403],
    [req.headers, { sessionAuthenticated: false }, 401], [req.headers, { unavailable: true }, 503],
    [req.headers, { hasQueryOrFragment: true }, 404],
  ]) {
    const denied = response();
    publicWall.handleRequest({ ...req, headers }, denied, `/rooms/${HANDLE}/upload`, true, { ...ctx, ...override });
    assert.equal(denied.status, status);
  }
  assert.equal(calls.length, 1);
  const preflight = response();
  publicWall.handleRequest({ ...req, method: 'OPTIONS' }, preflight, `/rooms/${HANDLE}/upload`, true,
    { ...ctx, sessionAuthenticated: false });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-methods'], 'POST, OPTIONS');
  assert.equal(calls.length, 1);
});

test('public own-room images are anonymously readable with optional exact-origin CORS and shared read budgets', async () => {
  const publicWall = await wall();
  const calls = [];
  const ctx = { ...context(), clientIp: CLIENT_IP,
    uploads: { handleGetRoomImage(...args) { calls.push(args); args[3].writeHead(200); args[3].end(); } } };
  const path = `/rooms/${HANDLE}/images/${IMAGE_ID}`;
  for (const headers of [{}, { origin: ALLOWED_ORIGIN }]) {
    const res = response();
    publicWall.handleRequest({ method: 'GET', headers }, res, path, true, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], headers.origin);
  }
  assert.deepEqual(calls[0].slice(0, -1), [HANDLE, IMAGE_ID, CLIENT_IP]);
  for (const [req, override, status] of [
    [{ method: 'GET', headers: { origin: 'https://evil.example' } }, {}, 403],
    [{ method: 'GET', headers: {} }, { hasQueryOrFragment: true }, 404],
    [{ method: 'POST', headers: {} }, {}, 404],
  ]) {
    const denied = response();
    publicWall.handleRequest(req, denied, path, true, { ...ctx, ...override });
    assert.equal(denied.status, status);
  }
  assert.equal(calls.length, 2);
});
test('public snapshot route serves geometry-valid cached JSON with ten-second public caching', async () => {
  const publicWall = await wall();
  const doc = new Y.Doc();
  doc.getMap('items').set('a', new Y.Map([['type', 'text'], ['x', 0], ['y', 0], ['text', 'live']]));
  const res = response();
  publicWall.handleRequest({ method: 'GET', headers: {} }, res, '/api/snapshot', true, { ...context(), doc });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'public, max-age=10');
  assert.equal(JSON.parse(res.body).items[0].text, 'live');
  doc.destroy();
});
test('public provisioning creates through registry once and reuses only its committed room', async () => {
  const { provisionPublicWall } = await import('./relay-public-wall.js');
  const registeredDocs = new Set();
  let creations = 0;
  const registry = { registeredDocs, roomHandleForDoc: () => HANDLE,
    async createRoom() { creations++; registeredDocs.add(DOC_NAME); return { token: 'must-not-leak' }; } };
  const first = await provisionPublicWall(registry);
  const second = await provisionPublicWall(registry);
  assert.equal(creations, 1);
  assert.equal(first.docName, DOC_NAME);
  assert.equal(second.roomHandle, HANDLE);
  assert.equal(JSON.stringify(second).includes('must-not-leak'), false);
  registeredDocs.add('other');
  await assert.rejects(provisionPublicWall(registry), /exactly one/);
});

test('a signed existing writer renews at capacity, while an unsigned refresh is refused', async () => {
  const publicWall = await wall();
  const req = { method: 'POST', headers: { origin: ALLOWED_ORIGIN } };
  const path = `/rooms/${HANDLE}/public-session`;
  const denied = response();
  publicWall.handleRequest(req, denied, path, true, { ...context(), writerCount: 500 });
  assert.equal(denied.status, 401);
  const renewed = response();
  publicWall.handleRequest(req, renewed, path, true, { ...context(), writerCount: 500, sessionAuthenticated: true });
  assert.equal(renewed.status, 200);
  assert.match(renewed.headers['set-cookie'], /Path=\/yjs-public\/rooms\//);
});

test('snapshot subscriber retains only the public document without allocating a writer socket', async () => {
  const { retainPublicDocument } = await import('./relay-public-wall.js');
  const doc = new Y.Doc();
  doc.conns = new Map();
  retainPublicDocument(doc);
  assert.equal(doc.conns.size, 1);
  const [subscriber] = doc.conns.keys();
  let acknowledged = false;
  subscriber.send(new Uint8Array(), () => { acknowledged = true; });
  assert.equal(acknowledged, true);
  assert.equal(subscriber.readyState, 1);
  doc.destroy();
  assert.equal(doc.conns.size, 0);
});
