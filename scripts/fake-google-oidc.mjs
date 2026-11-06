// Dev-only stand-in for Google's OIDC endpoints, matching the relay's
// GOOGLE_OAUTH_ENDPOINT_BASE override: `${url}/auth`, `${url}/token`, iss === url.
// It issues unsigned ID tokens, so it must never face real users.
// CLI (`npm run oidc:dev`): listens on 127.0.0.1:${FAKE_OIDC_PORT:-4455}, prints its URL
// (use it as GOOGLE_OAUTH_ENDPOINT_BASE) and stops on SIGINT/SIGTERM.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOST = '127.0.0.1';
const AUTH_PATH = '/auth';
const TOKEN_PATH = '/token';
const DECISION_PARAM = 'decision';
const APPROVE = 'approve';
const CANCEL = 'cancel';
const CODE_BYTES = 24;
const BASE64URL = 'base64url';
const MAX_TOKEN_BODY_BYTES = 16_384;
const MILLISECONDS_PER_SECOND = 1000;
const ID_TOKEN_LIFETIME_SECONDS = 3600;
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const INVALID_GRANT = 'invalid_grant';
const UNSIGNED_JWT_HEADER = Object.freeze({ alg: 'none', typ: 'JWT' });
const DEFAULT_CLI_PORT = 4455;
const MAX_PORT = 65_535;
const STOP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM']);
const AUTH_PARAMS = Object.freeze(['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']);
export const FAKE_GOOGLE_PROFILE = Object.freeze({ sub: 'fake-google-sub-1', email: 'dev.user@example.com', name: 'Dev User' });

const base64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString(BASE64URL);
const s256 = (verifier) => createHash('sha256').update(verifier).digest(BASE64URL);
const escapeHtml = (text) => text.replace(/[&<>"]/g, (character) => `&#${character.codePointAt(0)};`);

function reply(res, status, headers = {}, body = '') {
  if (res.headersSent) return;
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function decisionHref(url, decision) {
  const target = new URL(url);
  target.searchParams.set(DECISION_PARAM, decision);
  return `${target.pathname}${target.search}`;
}

function consentPage(url) {
  const approve = escapeHtml(decisionHref(url, APPROVE));
  const cancel = escapeHtml(decisionHref(url, CANCEL));
  return `<!doctype html><meta charset="utf-8"><title>Fake Google sign-in</title>
<p>Sign in as ${escapeHtml(FAKE_GOOGLE_PROFILE.email)}?</p>
<p><a id="approve" href="${approve}">Continue</a> <a id="cancel" href="${cancel}">Cancel</a></p>`;
}

function callbackLocation(redirectUri, params) {
  const target = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
  return target.href;
}

function handleAuthorize(url, codes, res) {
  const params = Object.fromEntries(AUTH_PARAMS.map((name) => [name, url.searchParams.get(name)]));
  if (AUTH_PARAMS.some((name) => !params[name]) || url.searchParams.get('code_challenge_method') !== 'S256') {
    reply(res, HTTP_BAD_REQUEST);
    return;
  }
  const decision = url.searchParams.get(DECISION_PARAM);
  if (decision === CANCEL) {
    reply(res, HTTP_FOUND, { location: callbackLocation(params.redirect_uri, { error: 'access_denied', state: params.state }) });
    return;
  }
  if (decision !== APPROVE) {
    reply(res, HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }, consentPage(url));
    return;
  }
  const code = randomBytes(CODE_BYTES).toString(BASE64URL);
  codes.set(code, params);
  reply(res, HTTP_FOUND, { location: callbackLocation(params.redirect_uri, { code, state: params.state }) });
}

async function formBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_TOKEN_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function idToken(issuer, grant) {
  const issuedAt = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  const claims = {
    iss: issuer, aud: grant.client_id, ...FAKE_GOOGLE_PROFILE, email_verified: true,
    nonce: grant.nonce, iat: issuedAt, exp: issuedAt + ID_TOKEN_LIFETIME_SECONDS,
  };
  return `${base64urlJson(UNSIGNED_JWT_HEADER)}.${base64urlJson(claims)}.`;
}

// A code is spent on first use, whether or not the rest of the request matches.
function redeemedGrant(form, codes) {
  const code = form.get('code');
  const grant = codes.get(code);
  codes.delete(code);
  const matches = grant && form.get('grant_type') === 'authorization_code'
    && form.get('client_id') === grant.client_id && form.get('redirect_uri') === grant.redirect_uri
    && s256(form.get('code_verifier') || '') === grant.code_challenge;
  return matches ? grant : null;
}

async function handleToken(req, res, { codes, issuer, onTokenRequest }) {
  const form = await formBody(req);
  if (!form) { reply(res, HTTP_PAYLOAD_TOO_LARGE); return; }
  await onTokenRequest();
  const grant = redeemedGrant(form, codes);
  if (!grant) {
    reply(res, HTTP_BAD_REQUEST, { 'content-type': 'application/json' }, JSON.stringify({ error: INVALID_GRANT }));
    return;
  }
  const body = JSON.stringify({ access_token: randomBytes(CODE_BYTES).toString(BASE64URL), token_type: 'Bearer', id_token: idToken(issuer, grant) });
  reply(res, HTTP_OK, { 'content-type': 'application/json' }, body);
}

const noWait = async () => {};

/**
 * Starts the stub on 127.0.0.1. `issuer` defaults to the stub's own origin;
 * `onTokenRequest` may delay token responses (tests use it to hold an exchange open).
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startFakeGoogleOidc({ port = 0, issuer = null, onTokenRequest = noWait } = {}) {
  const codes = new Map();
  const state = { codes, issuer, onTokenRequest };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === AUTH_PATH) { handleAuthorize(url, codes, res); return; }
    if (req.method === 'POST' && url.pathname === TOKEN_PATH) {
      handleToken(req, res, state).catch(() => reply(res, HTTP_BAD_REQUEST));
      return;
    }
    reply(res, HTTP_NOT_FOUND);
  });
  await new Promise((resolve) => server.listen(port, LOOPBACK_HOST, resolve));
  const url = `http://${LOOPBACK_HOST}:${server.address().port}`;
  state.issuer = issuer ?? url;
  const close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return { url, close };
}

function cliPort(raw = String(DEFAULT_CLI_PORT)) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) throw new Error(`Invalid FAKE_OIDC_PORT: ${raw}`);
  return port;
}

async function main() {
  const stub = await startFakeGoogleOidc({ port: cliPort(process.env.FAKE_OIDC_PORT) });
  console.log(`fake Google OIDC listening on ${stub.url}`);
  for (const signal of STOP_SIGNALS) process.once(signal, () => { void stub.close(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
