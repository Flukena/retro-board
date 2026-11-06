import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  AuthError, CLOCK_SKEW_MS, FLOW_TTL_MS, FlowLedger, MAX_SUB_CHARACTERS, MAX_TOKEN_RESPONSE_BYTES,
  clearFlowCookie, exchangeCode, googleOAuthConfig, readFlowCookie, returnUrl, startAuthorization, verifyFlow,
  withAuthError,
} from './auth-google.js';
import { AUTH_ERROR } from '../domain/auth-errors.js';
import { MILLISECONDS_PER_MINUTE, MILLISECONDS_PER_SECOND } from './relay-config.js';

const KEY_BYTES = 32;
const MAX_COOKIE_HEADER_BYTES = 4096;
const BOARD_ORIGIN = 'https://retroroom.party';
const ALLOWED_ORIGINS = Object.freeze([BOARD_ORIGIN]);
const RETURN_TO = `${BOARD_ORIGIN}/board/abc?x=1`;
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const ENV = Object.freeze({
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  GOOGLE_OAUTH_REDIRECT_URI: `${BOARD_ORIGIN}/yjs/api/auth/google/callback`,
});
const GOOGLE_ISSUER = 'https://accounts.google.com';
const ID_TOKEN_LIFETIME_SECONDS = 3600;
const STREAM_CHUNK_BYTES = 4096;
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const OVERSIZED_NAME_CHARACTERS = 201;
const FLOW_TTL_SECONDS = FLOW_TTL_MS / MILLISECONDS_PER_SECOND;

const config = (overrides = {}) => googleOAuthConfig(ENV, { allowInsecureHttp: false, ...overrides });
const newKey = () => randomBytes(KEY_BYTES);
const b64url = (value) => Buffer.from(value).toString('base64url');
const cookiePair = (setCookie) => setCookie.split(';')[0];
const cookieValue = (setCookie) => cookiePair(setCookie).slice(cookiePair(setCookie).indexOf('=') + 1);
const stateOf = (location) => new URL(location).searchParams.get('state');
const callbackQuery = (state, code = 'auth-code') => new URLSearchParams({ state, code });

function started({ key = newKey(), ledger = new FlowLedger(), nowMs = Date.now(), oauth = config() } = {}) {
  const result = startAuthorization(oauth, RETURN_TO, key, ledger, { prefixed: true, nowMs });
  return { ...result, key, ledger, nowMs, state: stateOf(result.location), value: cookieValue(result.flowCookie) };
}

const assertAuthError = (fn, code) => assert.throws(fn, (error) => error instanceof AuthError && error.code === code);
const assertRejectsAuth = (promise, code) => assert.rejects(promise, (error) => error instanceof AuthError && error.code === code);

// Signs a flow the way the cookie contract describes, to reach checks behind the HMAC.
function signedFlowValue(key, flow) {
  const payload = b64url(JSON.stringify(flow));
  return `${payload}.${createHmac('sha256', key).update('oauth-flow-v1\0').update(payload).digest('base64url')}`;
}

function streamedResponse(text) {
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += STREAM_CHUNK_BYTES) {
        controller.enqueue(bytes.subarray(offset, offset + STREAM_CHUNK_BYTES));
      }
      controller.close();
    },
  }), { status: HTTP_OK });
}

function idToken(claims) {
  return [b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), b64url(JSON.stringify(claims)), 'signature'].join('.');
}

function validClaims(flow, nowMs, overrides = {}) {
  const nowSeconds = Math.floor(nowMs / MILLISECONDS_PER_SECOND);
  return {
    iss: GOOGLE_ISSUER, aud: CLIENT_ID, sub: '1234567890', email: 'ada@example.com', email_verified: true,
    name: 'Ada', nonce: flow.nonce, iat: nowSeconds, exp: nowSeconds + ID_TOKEN_LIFETIME_SECONDS, ...overrides,
  };
}

const jsonResponse = (body, status = HTTP_OK) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

function verifiedFlow() {
  const flowStart = started();
  return verifyFlow(callbackQuery(flowStart.state), flowStart.value, flowStart.key, flowStart.ledger, flowStart.nowMs);
}

async function exchangeWith(claims, { nowMs = Date.now(), flow = verifiedFlow() } = {}) {
  const body = typeof claims === 'function' ? claims(flow, nowMs) : claims;
  const fetchImpl = async () => jsonResponse({ id_token: idToken(body), access_token: 'unused' });
  return exchangeCode(config(), flow, 'auth-code', { fetchImpl, nowMs });
}

test('config is null without all three env vars', () => {
  for (const name of Object.keys(ENV)) {
    const env = { ...ENV };
    delete env[name];
    assert.equal(googleOAuthConfig(env, { allowInsecureHttp: false }), null, name);
    assert.equal(googleOAuthConfig({ ...ENV, [name]: '' }, { allowInsecureHttp: false }), null, name);
  }
  const oauth = config();
  assert.equal(oauth.clientId, CLIENT_ID);
  assert.equal(oauth.authorizationEndpoint, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(oauth.tokenEndpoint, 'https://oauth2.googleapis.com/token');
});

test('endpoint override throws outside insecure dev', () => {
  const env = { ...ENV, GOOGLE_OAUTH_ENDPOINT_BASE: 'http://127.0.0.1:9999' };
  assert.throws(() => googleOAuthConfig(env, { allowInsecureHttp: false }));
  const dev = googleOAuthConfig(env, { allowInsecureHttp: true });
  assert.equal(dev.authorizationEndpoint, 'http://127.0.0.1:9999/auth');
  assert.equal(dev.tokenEndpoint, 'http://127.0.0.1:9999/token');
  assert.deepEqual(dev.issuers, ['http://127.0.0.1:9999']);
});

test('returnUrl rejects foreign origins and protocol-relative paths and drops fragments', () => {
  const fallback = `${BOARD_ORIGIN}/`;
  const resolve = (raw) => returnUrl(raw, ALLOWED_ORIGINS, false);
  assert.equal(resolve(`${BOARD_ORIGIN}/board/abc?x=1#token`), `${BOARD_ORIGIN}/board/abc?x=1`);
  for (const raw of [
    'https://evil.example/board', `${BOARD_ORIGIN}//evil.example/x`, '//evil.example/x', '/board/abc',
    'javascript:alert(1)', `${BOARD_ORIGIN}.evil.example/`, 'http://retroroom.party/', '', null, undefined,
    `${BOARD_ORIGIN}/${'a'.repeat(MAX_COOKIE_HEADER_BYTES)}`,
  ]) {
    assert.equal(resolve(raw), fallback, String(raw));
  }
});

test('withAuthError keeps existing query parameters', () => {
  const url = new URL(withAuthError(`${BOARD_ORIGIN}/board/abc?x=1&y=two`, AUTH_ERROR.ACCESS_DENIED));
  assert.equal(url.searchParams.get('x'), '1');
  assert.equal(url.searchParams.get('y'), 'two');
  assert.equal(url.searchParams.get('auth_error'), 'access_denied');
  assert.throws(() => withAuthError(`${BOARD_ORIGIN}/`, 'made_up_code'));
});

test('start builds an S256 challenge that matches the stored verifier', () => {
  const flowStart = started();
  const params = new URL(flowStart.location).searchParams;
  assert.equal(`${new URL(flowStart.location).origin}${new URL(flowStart.location).pathname}`, config().authorizationEndpoint);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('client_id'), CLIENT_ID);
  assert.equal(params.get('redirect_uri'), ENV.GOOGLE_OAUTH_REDIRECT_URI);
  assert.equal(params.get('scope'), 'openid email profile');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('prompt'), 'select_account');
  const flow = verifyFlow(callbackQuery(flowStart.state), flowStart.value, flowStart.key, flowStart.ledger, flowStart.nowMs);
  assert.equal(params.get('code_challenge'), createHash('sha256').update(flow.verifier).digest('base64url'));
  assert.equal(params.get('nonce'), flow.nonce);
  assert.equal(flow.returnTo, RETURN_TO);
  for (const value of [flow.state, flow.nonce, flow.verifier]) assert.equal(Buffer.from(value, 'base64url').byteLength, KEY_BYTES);
  assert.equal(new Set([flow.state, flow.nonce, flow.verifier]).size, 3);
});

test('flow cookie is Secure outside insecure dev', () => {
  const secure = started().flowCookie;
  assert.match(secure, /^rb_oauth_flow=[^;]+; Path=\/yjs\/api\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.doesNotMatch(secure, /Domain=/i);
  const dev = started({ oauth: config({ allowInsecureHttp: true }) }).flowCookie;
  assert.doesNotMatch(dev, /Secure/);
  const unprefixed = startAuthorization(config(), RETURN_TO, newKey(), new FlowLedger(), { prefixed: false }).flowCookie;
  assert.match(unprefixed, /; Path=\/api\/auth;/);
  assert.equal(clearFlowCookie(config(), { prefixed: true }), 'rb_oauth_flow=; Path=/yjs/api/auth; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
  assert.equal(FLOW_TTL_SECONDS, 600);
});

test('verifyFlow accepts once and rejects the same cookie bytes again', () => {
  const flowStart = started();
  const query = callbackQuery(flowStart.state);
  const flow = verifyFlow(query, flowStart.value, flowStart.key, flowStart.ledger, flowStart.nowMs);
  assert.equal(flow.state, flowStart.state);
  assertAuthError(() => verifyFlow(query, flowStart.value, flowStart.key, flowStart.ledger, flowStart.nowMs), AUTH_ERROR.STATE_MISMATCH);
});

test('two concurrent verifyFlow calls succeed exactly once', async () => {
  const flowStart = started();
  const attempt = async () => verifyFlow(callbackQuery(flowStart.state), flowStart.value, flowStart.key, flowStart.ledger, flowStart.nowMs);
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
});

test('verifyFlow rejects missing, duplicate, tampered and expired cookies', () => {
  const flowStart = started();
  const query = callbackQuery(flowStart.state);
  const check = (value, now = flowStart.nowMs, key = flowStart.key) => assertAuthError(
    () => verifyFlow(query, value, key, flowStart.ledger, now), AUTH_ERROR.STATE_MISMATCH,
  );
  const pair = cookiePair(flowStart.flowCookie);
  assert.equal(readFlowCookie({ headers: { cookie: pair } }, MAX_COOKIE_HEADER_BYTES), flowStart.value);
  check(null);
  check(readFlowCookie({ headers: { cookie: `${pair}; ${pair}` } }, MAX_COOKIE_HEADER_BYTES));
  check('not-a-cookie');
  const [payload, signature] = flowStart.value.split('.');
  const flipped = (text) => `${text[0] === 'A' ? 'B' : 'A'}${text.slice(1)}`;
  check(`${flipped(payload)}.${signature}`);
  check(`${payload}.${flipped(signature)}`);
  check(flowStart.value, flowStart.nowMs, newKey());
  check(flowStart.value, flowStart.nowMs + FLOW_TTL_MS);
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const farExpiry = flowStart.nowMs + FLOW_TTL_MS * 2;
  check(`${b64url(JSON.stringify({ ...forged, expiresAt: farExpiry }))}.${signature}`);
  const farLedger = new FlowLedger();
  farLedger.register(forged.state, farExpiry, flowStart.nowMs);
  assertAuthError(() => verifyFlow(query, signedFlowValue(flowStart.key, { ...forged, expiresAt: farExpiry }), flowStart.key, farLedger, flowStart.nowMs), AUTH_ERROR.STATE_MISMATCH);
  assertAuthError(() => verifyFlow(callbackQuery(started().state), flowStart.value, flowStart.key, flowStart.ledger, flowStart.nowMs), AUTH_ERROR.STATE_MISMATCH);
  // None of the rejected attempts spent the flow.
  assert.equal(verifyFlow(query, flowStart.value, flowStart.key, flowStart.ledger, flowStart.nowMs).state, flowStart.state);
});

test('verifyFlow rejects duplicate state parameters', () => {
  const flowStart = started();
  const verify = (query) => verifyFlow(query, flowStart.value, flowStart.key, flowStart.ledger, flowStart.nowMs);
  assertAuthError(() => verify(new URLSearchParams([['state', flowStart.state], ['state', flowStart.state], ['code', 'c']])), AUTH_ERROR.STATE_MISMATCH);
  assertAuthError(() => verify(new URLSearchParams([['state', flowStart.state], ['code', 'a'], ['code', 'b']])), AUTH_ERROR.STATE_MISMATCH);
  assertAuthError(() => verify(new URLSearchParams({ code: 'c' })), AUTH_ERROR.STATE_MISMATCH);
  assert.equal(verify(new URLSearchParams({ state: flowStart.state, error: 'access_denied' })).state, flowStart.state);
});

test('ledger full makes start return null', () => {
  const nowMs = Date.now();
  const ledger = new FlowLedger({ maxFlows: 2 });
  const start = (at) => startAuthorization(config(), RETURN_TO, newKey(), ledger, { prefixed: true, nowMs: at });
  assert.ok(start(nowMs));
  assert.ok(start(nowMs));
  assert.equal(start(nowMs), null);
  assert.ok(start(nowMs + FLOW_TTL_MS), 'expired flows are pruned to make room');
});

test('ledger claim is single use and refuses expired entries', () => {
  const nowMs = Date.now();
  const ledger = new FlowLedger({ maxFlows: 4, ttlMs: MILLISECONDS_PER_MINUTE });
  assert.equal(ledger.ttlMs, MILLISECONDS_PER_MINUTE);
  assert.equal(ledger.register('a', nowMs + MILLISECONDS_PER_MINUTE, nowMs), true);
  assert.equal(ledger.claim('a', nowMs), true);
  assert.equal(ledger.claim('a', nowMs), false);
  assert.equal(ledger.register('b', nowMs + MILLISECONDS_PER_MINUTE, nowMs), true);
  assert.equal(ledger.claim('b', nowMs + MILLISECONDS_PER_MINUTE), false);
  assert.equal(ledger.claim('unknown', nowMs), false);
});

test('exchange returns the verified profile and sends a PKCE form post', async () => {
  const nowMs = Date.now();
  const flow = verifiedFlow();
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return jsonResponse({ id_token: idToken(validClaims(flow, nowMs)) });
  };
  const profile = await exchangeCode(config(), flow, 'auth-code', { fetchImpl, nowMs });
  assert.deepEqual(profile, { sub: '1234567890', email: 'ada@example.com', name: 'Ada' });
  assert.equal(request.url, config().tokenEndpoint);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.equal(request.init.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(request.init.body);
  assert.deepEqual(Object.fromEntries(form), {
    grant_type: 'authorization_code', code: 'auth-code', client_id: CLIENT_ID, client_secret: 'client-secret',
    redirect_uri: ENV.GOOGLE_OAUTH_REDIRECT_URI, code_verifier: flow.verifier,
  });
});

test('exchange rejects wrong aud, wrong iss, expired exp, future iat, wrong nonce, missing or oversized sub', async () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / MILLISECONDS_PER_SECOND);
  const skewSeconds = CLOCK_SKEW_MS / MILLISECONDS_PER_SECOND;
  const cases = {
    aud: { aud: 'other-client' },
    audArray: { aud: [CLIENT_ID] },
    iss: { iss: 'https://evil.example' },
    exp: { exp: nowSeconds },
    expString: { exp: String(nowSeconds + ID_TOKEN_LIFETIME_SECONDS) },
    iat: { iat: nowSeconds + skewSeconds + 1 },
    iatFraction: { iat: nowSeconds + 0.5 },
    nonce: { nonce: b64url(randomBytes(KEY_BYTES)) },
    nonceMissing: { nonce: undefined },
    sub: { sub: undefined },
    subEmpty: { sub: '' },
    subLong: { sub: '1'.repeat(MAX_SUB_CHARACTERS + 1) },
    email: { email: undefined },
  };
  for (const [label, overrides] of Object.entries(cases)) {
    await assertRejectsAuth(exchangeWith((flow) => validClaims(flow, nowMs, overrides), { nowMs }), AUTH_ERROR.INVALID_ID_TOKEN).catch((error) => {
      throw new Error(`${label}: ${error.message}`);
    });
  }
  const subMax = await exchangeWith((flow) => validClaims(flow, nowMs, { sub: '1'.repeat(MAX_SUB_CHARACTERS) }), { nowMs });
  assert.equal(subMax.sub.length, MAX_SUB_CHARACTERS);
  const skewed = await exchangeWith((flow) => validClaims(flow, nowMs, { iat: nowSeconds + skewSeconds }), { nowMs });
  assert.equal(skewed.sub, '1234567890');
  const shortIssuer = await exchangeWith((flow) => validClaims(flow, nowMs, { iss: 'accounts.google.com' }), { nowMs });
  assert.equal(shortIssuer.sub, '1234567890');
});

test('exchange rejects millisecond-valued exp as invalid_id_token', async () => {
  const nowMs = Date.now();
  await assertRejectsAuth(
    exchangeWith((flow) => validClaims(flow, nowMs, { exp: nowMs + ID_TOKEN_LIFETIME_SECONDS * MILLISECONDS_PER_SECOND }), { nowMs }),
    AUTH_ERROR.INVALID_ID_TOKEN,
  );
  await assertRejectsAuth(
    exchangeWith((flow) => validClaims(flow, nowMs, { iat: nowMs }), { nowMs }),
    AUTH_ERROR.INVALID_ID_TOKEN,
  );
});

test('exchange rejects malformed id tokens', async () => {
  const flow = verifiedFlow();
  for (const token of [undefined, 42, 'only.two', 'a.b.c.d', `x.${b64url('not json')}.s`, `x.${b64url('[1]')}.s`, `x.${b64url('null')}.s`]) {
    const fetchImpl = async () => jsonResponse({ id_token: token });
    await assertRejectsAuth(exchangeCode(config(), flow, 'auth-code', { fetchImpl }), AUTH_ERROR.INVALID_ID_TOKEN);
  }
});

test('exchange rejects email_verified false', async () => {
  const nowMs = Date.now();
  for (const emailVerified of [false, 'true', undefined]) {
    await assertRejectsAuth(
      exchangeWith((flow) => validClaims(flow, nowMs, { email_verified: emailVerified }), { nowMs }),
      AUTH_ERROR.EMAIL_UNVERIFIED,
    );
  }
});

test('exchange accepts a missing name as empty', async () => {
  const nowMs = Date.now();
  const missing = await exchangeWith((flow) => validClaims(flow, nowMs, { name: undefined }), { nowMs });
  assert.equal(missing.name, '');
  const oversized = await exchangeWith((flow) => validClaims(flow, nowMs, { name: 'n'.repeat(OVERSIZED_NAME_CHARACTERS) }), { nowMs });
  assert.equal(oversized.name, '');
});

test('exchange maps non-200, redirects and oversized bodies to token_exchange_failed', async () => {
  const flow = verifiedFlow();
  // Valid apart from its size, so only the byte cap can reject it.
  const oversized = JSON.stringify({ id_token: idToken(validClaims(flow, Date.now())), padding: 'p'.repeat(MAX_TOKEN_RESPONSE_BYTES) });
  const failing = [
    async () => jsonResponse({ error: 'invalid_grant' }, HTTP_BAD_REQUEST),
    async (url, init) => {
      assert.equal(init.redirect, 'error');
      return new Response(null, { status: HTTP_FOUND, headers: { location: 'https://evil.example/' } });
    },
    async () => { throw new TypeError('fetch failed'); },
    async () => new Response('not json', { status: HTTP_OK }),
    async () => new Response(null, { status: HTTP_OK }),
    async () => streamedResponse(oversized),
  ];
  assert.ok(Buffer.byteLength(oversized) > MAX_TOKEN_RESPONSE_BYTES);
  for (const fetchImpl of failing) {
    await assertRejectsAuth(exchangeCode(config(), flow, 'auth-code', { fetchImpl }), AUTH_ERROR.TOKEN_EXCHANGE_FAILED);
  }
});
