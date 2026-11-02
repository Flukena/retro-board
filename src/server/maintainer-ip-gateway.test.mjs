import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { createMaintainerIpGateway } from './maintainer-ip-gateway.js';
import { createMaintainerServer } from './maintainer-server.js';

const ORIGIN = 'http://100.92.238.57:1240';
const KEY_BYTES = 32;
const ROOM_HANDLE = 'H'.repeat(32);

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}
function send(port, path = '/', headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port, path, method, headers: {Host: new URL(ORIGIN).host, ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject);
    req.end();
  });
}
async function fixture(t) {
  const key = randomBytes(KEY_BYTES).toString('base64url');
  const consoleServer = createMaintainerServer({key, snapshot: () => ({rooms: []}),
    assets: new Map([['/', {body: '<main>login</main>', type: 'text/html'}]]), roomLink: () => 'https://board.example/public'});
  const upstreamPort = await listen(t, consoleServer);
  const gateway = createMaintainerIpGateway({externalOrigin: ORIGIN, upstreamPort});
  const port = await listen(t, gateway);
  return {port, key};
}

test('serves login directly without redirect or DNS and requires the real console credential', async t => {
  const {port, key} = await fixture(t);
  const root = await send(port);
  assert.equal(root.status, 200);
  assert.equal(root.headers.location, undefined);
  assert.match(root.body, /<main>login/);
  assert.match(root.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await send(port, '/api/status')).status, 401);
  const auth = {Origin: ORIGIN, Authorization: `Bearer ${key}`};
  const login = await send(port, '/api/session', auth, 'POST');
  assert.equal(login.status, 204);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(cookie, /; Secure|Domain=/);
  const session = {Cookie: cookie.split(';')[0]};
  assert.equal((await send(port, '/api/status', session)).status, 200);
  assert.equal((await send(port, `/api/rooms/${ROOM_HANDLE}/join`, {...session, Origin: ORIGIN}, 'POST')).status, 200);
  assert.equal((await send(port, '/api/session', {...session, Origin: ORIGIN}, 'DELETE')).status, 204);
  assert.equal((await send(port, '/api/status', session)).status, 401);
});

test('rejects foreign origins, host spoofing, missing write origins and duplicate credentials before proxying', async t => {
  const {port, key} = await fixture(t);
  const auth = {Authorization: `Bearer ${key}`};
  for (const headers of [{Origin: 'https://evil.example'}, {Host: 'evil.example'}, {'Sec-Fetch-Site': 'cross-site'},
    {Origin: 'null'}, {Authorization: [auth.Authorization, auth.Authorization]}]) {
    assert.equal((await send(port, '/api/status', {...auth, ...headers})).status, 403);
  }
  assert.equal((await send(port, '/api/session', auth, 'POST')).status, 403);
  assert.equal((await send(port, '/api/session', {Origin: ORIGIN, Authorization: 'Bearer invalid'}, 'POST')).status, 401);
  const bodyRejected = await send(port, '/api/session', {...auth, Origin: ORIGIN, 'Content-Length': '1'}, 'POST');
  assert.equal(bodyRejected.status, 413);
  assert.equal(bodyRejected.headers.connection, 'close');
  for (const path of ['/public', '/api/status?other=1', '/.env']) {
    assert.equal((await send(port, path, auth)).status, 404);
  }
  {
    const malformed = await send(port, '//evil.example', auth);
    assert.equal(malformed.status, 404);
  }
});

test('upstream failures return an uncached 502 rather than a redirect', async t => {
  const upstream = createServer((req, res) => res.destroy());
  const upstreamPort = await listen(t, upstream);
  const port = await listen(t, createMaintainerIpGateway({externalOrigin: ORIGIN, upstreamPort}));
  const response = await send(port);
  assert.equal(response.status, 502);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.location, undefined);
});

test('configuration accepts only exact HTTP tailnet IPv4 origins and valid local upstream ports', () => {
  for (const externalOrigin of ['http://127.0.0.1:1240', 'http://192.168.1.1', 'https://100.92.238.57:1240',
    `${ORIGIN}/`, 'http://100.63.1.1', 'http://100.128.1.1']) {
    assert.throws(() => createMaintainerIpGateway({externalOrigin, upstreamPort: 1240}));
  }
  for (const upstreamPort of [0, -1, 65536, '1240']) {
    assert.throws(() => createMaintainerIpGateway({externalOrigin: ORIGIN, upstreamPort}));
  }
});

test('public direct-IP gateway forwards only the public origin and keeps its console protected', async t => {
  const publicOrigin = 'http://100.92.238.57:1241';
  const key = randomBytes(KEY_BYTES).toString('base64url');
  const upstream = createMaintainerServer({key, snapshot: () => ({rooms: []}),
    assets: new Map([['/', {body: '<main>public login</main>', type: 'text/html'}]])});
  const upstreamPort = await listen(t, upstream);
  const port = await listen(t, createMaintainerIpGateway({externalOrigin: publicOrigin, upstreamPort}));
  const headers = {Host: new URL(publicOrigin).host};
  assert.match((await send(port, '/', headers)).body, /public login/);
  assert.equal((await send(port, '/api/status', headers)).status, 401);
  assert.equal((await send(port, '/api/session', {...headers, Origin: ORIGIN, Authorization: `Bearer ${key}`}, 'POST')).status, 403);
  const login = await send(port, '/api/session', {...headers, Origin: publicOrigin, Authorization: `Bearer ${key}`}, 'POST');
  assert.equal(login.status, 204);
  assert.equal((await send(port, '/api/status', {...headers, Cookie: login.headers['set-cookie'][0].split(';')[0]})).status, 200);
});
