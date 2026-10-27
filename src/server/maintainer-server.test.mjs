import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { createMaintainerServer, maintainerConfig, startMaintainer } from './maintainer-server.js';

const key = randomBytes(32).toString('base64url');

async function fixture(t, snapshot = () => ({ rooms: [] }), roomLink) {
  const origins = new Set(['https://owner.example.ts.net']);
  const server = createMaintainerServer({ key, origins, snapshot, roomLink, assets: new Map([['/', { body: 'login', type: 'text/html' }]]) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (path = '/api/status', headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request(url + path, { headers, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: new Map(Object.entries(response.headers)), text: () => body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end();
  });
  return { get, server };
}

test('disabled unless explicitly configured; rejects weak keys, ports and public origins', async () => {
  assert.equal(maintainerConfig({}), null);
  assert.equal(await startMaintainer({}, () => { throw new Error('must not run'); }), null);
  for (const env of [{ YJS_MAINTAINER_KEY: 'short' }, { YJS_MAINTAINER_KEY: key, YJS_MAINTAINER_PORT: 'invalid' }, { YJS_MAINTAINER_KEY: key, YJS_MAINTAINER_ORIGIN: 'https://retroroom.party' }, { YJS_MAINTAINER_KEY: key, YJS_MAINTAINER_ORIGIN: 'http://owner.example.ts.net' }]) {
    assert.throws(() => maintainerConfig(env));
  }
  assert.equal(maintainerConfig({ YJS_MAINTAINER_KEY: key }).port, 1240);
});

test('only authenticated, same-origin read requests return status; no public/proxy-header bypass', async t => {
  let calls = 0;
  const { get, server } = await fixture(t, () => { calls += 1; return { rooms: ['protected'] }; });
  const auth = { Authorization: `Bearer ${key}` };
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal((await get()).status, 401);
  assert.equal((await get('/api/status', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal(calls, 0);
  for (const headers of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'retroroom.party', 'X-Forwarded-For': '127.0.0.1', 'Tailscale-User-Login': 'owner' }]) {
    assert.equal((await get('/api/status', { ...auth, ...headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await get('/api/status', auth, 'POST')).status, 405);
  assert.equal((await get('/api/status?key=secret', auth)).status, 404);
  const response = await get('/api/status', auth);
  assert.deepEqual(await response.json(), { rooms: ['protected'] });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await get('/api/status', { ...auth, Host: 'owner.example.ts.net', Origin: 'https://owner.example.ts.net' })).status, 200);
  assert.equal(calls, 1, 'reuses bounded snapshot cache');
  const login = await get('/');
  assert.equal(await login.text(), 'login');
});

test('snapshot failures return an empty 503 without leaking errors', async t => {
  const { get } = await fixture(t, () => { throw new Error('private diagnostic'); });
  const response = await get('/api/status', { Authorization: `Bearer ${key}` });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '');
});

test('login remembers a revocable session without exposing the owner key', async t => {
  const { get, server } = await fixture(t);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${key}`, Origin: origin };
  assert.equal((await get('/api/session', {}, 'POST')).status, 403);
  assert.equal((await get('/api/session', { Origin: origin }, 'POST')).status, 401);
  const login = await get('/api/session', auth, 'POST');
  assert.equal(login.status, 204);
  const cookieHeader = login.headers.get('set-cookie')[0];
  assert.match(cookieHeader, /HttpOnly; SameSite=Strict/);
  assert.match(cookieHeader, /Max-Age=2592000/);
  assert.ok(!cookieHeader.includes(key));
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await get('/api/status', { Cookie: cookie })).status, 200);
  assert.equal((await get('/api/status', { Cookie: `${cookie}; ${cookie}` })).status, 401);
  assert.equal((await get('/api/status', { Cookie: `${cookie}tampered` })).status, 401);
  const logout = await get('/api/session', { Cookie: cookie, Origin: origin }, 'DELETE');
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie')[0], /Max-Age=0/);
  assert.equal((await get('/api/status', { Cookie: cookie })).status, 401);
});

test('HTTPS sessions use Secure cookies and cross-site logout cannot revoke them', async t => {
  const { get } = await fixture(t);
  const headers = { Host: 'owner.example.ts.net', Origin: 'https://owner.example.ts.net', Authorization: `Bearer ${key}` };
  const login = await get('/api/session', headers, 'POST');
  assert.equal(login.status, 204);
  assert.match(login.headers.get('set-cookie')[0], /; Secure$/);
  const cookie = login.headers.get('set-cookie')[0].split(';')[0];
  assert.equal((await get('/api/session', { ...headers, Cookie: cookie, Origin: 'https://evil.example' }, 'DELETE')).status, 403);
  assert.equal((await get('/api/status', { Host: headers.Host, Cookie: cookie })).status, 200);
});


test('room entry requires owner authentication and an explicit same-origin POST', async t => {
  const handle='A'.repeat(32);
  let calls=0;
  const roomUrl='https://board.example/b/Room123#private-room-token';
  const {get,server}=await fixture(t,()=>({rooms:[{handle}]}), requested => {
    calls+=1;
    return requested === handle ? roomUrl : null;
  });
  const path=`/api/rooms/${handle}/join`;
  const Origin=`http://127.0.0.1:${server.address().port}`;
  const Authorization=`Bearer ${key}`;
  assert.equal((await get(path,{Origin},'POST')).status,401);
  assert.equal((await get(path,{Authorization},'POST')).status,403);
  assert.equal((await get(path,{Origin,Authorization})).status,405);
  assert.equal((await get(path,{Origin:'https://evil.example',Authorization},'POST')).status,403);
  assert.equal(calls,0);
  const status=await get('/api/status',{Authorization});
  assert.ok(!status.text().includes('private-room-token'));
  const login=await get('/api/session',{Origin,Authorization},'POST');
  const Cookie=login.headers.get('set-cookie')[0].split(';')[0];
  const entry=await get(path,{Origin,Cookie},'POST');
  assert.equal(entry.status,200);
  assert.deepEqual(entry.json(),{url:roomUrl});
  assert.equal(entry.headers.get('cache-control'),'no-store');
  assert.equal(entry.headers.get('referrer-policy'),'no-referrer');
  assert.equal((await get(`/api/rooms/${'B'.repeat(32)}/join`,{Origin,Cookie},'POST')).status,404);
  await get('/api/session',{Origin,Cookie},'DELETE');
  assert.equal((await get(path,{Origin,Cookie},'POST')).status,401);
});

test('private and Public console sessions coexist on the same host even with a shared owner key', async t => {
  const privateRelay=await fixture(t);
  const publicRelay=await fixture(t);
  const login=async relay=>{
    const Origin=`http://127.0.0.1:${relay.server.address().port}`;
    const response=await relay.get('/api/session',{Origin,Authorization:`Bearer ${key}`},'POST');
    return response.headers.get('set-cookie')[0].split(';')[0];
  };
  const privateCookie=await login(privateRelay);
  const publicCookie=await login(publicRelay);
  assert.notEqual(privateCookie.split('=')[0],publicCookie.split('=')[0]);
  const Cookie=`${privateCookie}; ${publicCookie}`;
  assert.equal((await privateRelay.get('/api/status',{Cookie})).status,200);
  assert.equal((await publicRelay.get('/api/status',{Cookie})).status,200);
});
