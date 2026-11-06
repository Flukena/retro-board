import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { createMaintainerServer } from './maintainer-server.js';

const key = randomBytes(32).toString('base64url');
const ACCOUNT = { id: 'acc_1', googleSub: 'sub-secret', email: 'Owner@Example.com', name: 'Owner', plan: 'free', planGrantedAt: null, sessionGeneration: 3, createdAt: 1 };

function fakeStore() {
  const account = { ...ACCOUNT };
  return {
    findByEmail: async (email) => (email.toLowerCase() === account.email.toLowerCase() ? { ...account } : null),
    get: async (id) => (id === account.id ? { ...account } : null),
    setPlan: async (id, plan) => {
      if (id !== account.id) return null;
      if (plan !== 'free' && plan !== 'pro') throw Object.assign(new Error('unknown plan'), { code: 'UNKNOWN_PLAN' });
      Object.assign(account, { plan, planGrantedAt: plan === 'pro' ? 5 : null });
      return { ...account };
    },
  };
}

async function fixture(t, store = fakeStore()) {
  const origins = new Set(['https://owner.example.ts.net']);
  const server = createMaintainerServer({ key, origins, snapshot: () => ({ rooms: [] }), accounts: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const Origin = `http://127.0.0.1:${port}`;
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
  const auth = { Authorization: `Bearer ${key}` };
  const post = (path, body, headers = {}) => send(path, { method: 'POST', headers: { Origin, 'content-type': 'application/json', ...auth, ...headers }, body });
  return { send, post, auth, Origin };
}

test('requires the owner key or session', async t => {
  const { send, post, Origin, auth } = await fixture(t);
  assert.equal((await send('/api/accounts?email=owner@example.com')).status, 401);
  assert.equal((await send('/api/accounts?email=owner@example.com', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await post('/api/accounts/acc_1/plan', '{"plan":"pro"}', { Authorization: 'Bearer wrong' })).status, 401);
  const login = await send('/api/session', { method: 'POST', headers: { Origin, ...auth } });
  const Cookie = login.headers['set-cookie'][0].split(';')[0];
  const found = await send('/api/accounts?email=owner@example.com', { headers: { Cookie } });
  assert.equal(found.status, 200);
  await send('/api/session', { method: 'DELETE', headers: { Origin, Cookie } });
  assert.equal((await send('/api/accounts?email=owner@example.com', { headers: { Cookie } })).status, 401);
});

test('rejects wrong Host and foreign Origin', async t => {
  const { send, post, auth } = await fixture(t);
  assert.equal((await send('/api/accounts?email=owner@example.com', { headers: { ...auth, Host: 'evil.example' } })).status, 403);
  assert.equal((await post('/api/accounts/acc_1/plan', '{"plan":"pro"}', { Origin: 'https://evil.example' })).status, 403);
  const noOrigin = await send('/api/accounts/acc_1/plan', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"plan":"pro"}' });
  assert.equal(noOrigin.status, 403);
  const check = await send('/api/accounts?email=owner@example.com', { headers: auth });
  assert.equal(check.json().plan, 'free', 'rejected writes changed nothing');
});

test('rejects malformed JSON with 400', async t => {
  const { post } = await fixture(t);
  assert.equal((await post('/api/accounts/acc_1/plan', '{nope')).status, 400);
  assert.equal((await post('/api/accounts/acc_1/plan', '[]')).status, 400);
  assert.equal((await post('/api/accounts/acc_1/plan', '{"plan":"pro"}', { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await post('/api/accounts/acc_1/plan', JSON.stringify({ plan: 'x'.repeat(4096) }))).status, 400);
});

test('finds by email case-insensitively and exposes only public fields', async t => {
  const { send, auth } = await fixture(t);
  const found = await send('/api/accounts?email=OWNER%40example.COM', { headers: auth });
  assert.equal(found.status, 200);
  assert.deepEqual(found.json(), { id: 'acc_1', email: 'Owner@Example.com', name: 'Owner', plan: 'free', planGrantedAt: null });
  assert.equal(found.headers['cache-control'], 'no-store');
  assert.equal(found.headers['referrer-policy'], 'no-referrer');
  assert.equal((await send('/api/accounts?email=nobody@example.com', { headers: auth })).status, 404);
  assert.equal((await send('/api/accounts', { headers: auth })).status, 404);
});

test('grants and revokes pro', async t => {
  const { post, send, auth } = await fixture(t);
  const granted = await post('/api/accounts/acc_1/plan', '{"plan":"pro"}');
  assert.equal(granted.status, 200);
  assert.deepEqual(granted.json(), { id: 'acc_1', email: 'Owner@Example.com', name: 'Owner', plan: 'pro', planGrantedAt: 5 });
  assert.equal((await send('/api/accounts?email=owner@example.com', { headers: auth })).json().plan, 'pro');
  assert.equal((await post('/api/accounts/acc_1/plan', '{"plan":"free"}')).json().plan, 'free');
  assert.equal((await post('/api/accounts/missing/plan', '{"plan":"pro"}')).status, 404);
});

test('rejects unknown plan with 400', async t => {
  const { post } = await fixture(t);
  assert.equal((await post('/api/accounts/acc_1/plan', '{"plan":"gold"}')).status, 400);
  assert.equal((await post('/api/accounts/acc_1/plan', '{}')).status, 400);
});

test('maps store outages to 503 and answers 404 when no store exists', async t => {
  const down = Object.assign(new Error('down'), { code: 'ACCOUNT_STORE_UNAVAILABLE' });
  const broken = { findByEmail: async () => { throw down; }, setPlan: async () => { throw down; } };
  const { send, post, auth } = await fixture(t, broken);
  assert.equal((await send('/api/accounts?email=a@b.c', { headers: auth })).status, 503);
  assert.equal((await post('/api/accounts/acc_1/plan', '{"plan":"pro"}')).status, 503);
  const none = await fixture(t, null);
  assert.equal((await none.send('/api/accounts?email=a@b.c', { headers: none.auth })).status, 404);
});
