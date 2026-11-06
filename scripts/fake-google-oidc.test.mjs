import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FAKE_GOOGLE_PROFILE, startFakeGoogleOidc } from './fake-google-oidc.mjs';

const VERIFIER = 'v'.repeat(43);
const REDIRECT_URI = 'http://localhost:1234/api/auth/google/callback';
const AUTH_PARAMS = Object.freeze({
  client_id: 'client-1', redirect_uri: REDIRECT_URI, state: 's'.repeat(43), nonce: 'n'.repeat(43),
  code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'), code_challenge_method: 'S256',
});

async function startStub(t) {
  const stub = await startFakeGoogleOidc();
  t.after(() => stub.close());
  return stub;
}

const authorize = (stub, decision) => fetch(`${stub.url}/auth?${new URLSearchParams({ ...AUTH_PARAMS, decision })}`, { redirect: 'manual' });
const redeem = (stub, code, verifier = VERIFIER) => fetch(`${stub.url}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: AUTH_PARAMS.client_id, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
});
const claimsOf = (idToken) => JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
const codeFrom = (response) => new URL(response.headers.get('location')).searchParams.get('code');

test('stub issues a verified ID token for the PKCE verifier exactly once', async (t) => {
  const stub = await startStub(t);
  const code = codeFrom(await authorize(stub, 'approve'));
  const response = await redeem(stub, code);
  assert.equal(response.status, 200);
  const claims = claimsOf((await response.json()).id_token);
  assert.equal(claims.iss, stub.url);
  assert.equal(claims.aud, AUTH_PARAMS.client_id);
  assert.equal(claims.nonce, AUTH_PARAMS.nonce);
  assert.equal(claims.sub, FAKE_GOOGLE_PROFILE.sub);
  assert.equal(claims.email_verified, true);
  assert.ok(Number.isSafeInteger(claims.exp) && claims.exp < Date.now(), 'exp is in seconds');
  assert.equal((await redeem(stub, code)).status, 400, 'a code is single use');
});

test('stub rejects a wrong verifier and burns the code', async (t) => {
  const stub = await startStub(t);
  const code = codeFrom(await authorize(stub, 'approve'));
  assert.equal((await redeem(stub, code, 'w'.repeat(43))).status, 400);
  assert.equal((await redeem(stub, code)).status, 400);
});

test('stub cancel returns access_denied with the state', async (t) => {
  const stub = await startStub(t);
  const location = new URL((await authorize(stub, 'cancel')).headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, new URL(REDIRECT_URI).href);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), AUTH_PARAMS.state);
  const consent = await fetch(`${stub.url}/auth?${new URLSearchParams(AUTH_PARAMS)}`);
  assert.match(await consent.text(), /id="approve"/);
});
