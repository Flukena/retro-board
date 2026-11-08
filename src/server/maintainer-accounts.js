import { readJsonBody } from './relay-http.js';

const MAX_PLAN_BODY_BYTES = 256;
const MAX_EMAIL_LENGTH = 254;
const PLAN_ROUTE_RE = /^\/api\/accounts\/([A-Za-z0-9_-]{1,64})\/plan$/;
const SEARCH_ROUTE_RE = /^\/api\/accounts(?:\?|$)/;
const STATUS = Object.freeze({
  OK: 200, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, UNAVAILABLE: 503,
});
const RESPONSE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
const BAD_REQUEST_CODES = new Set(['BAD_JSON', 'BODY_TOO_LARGE', 'UNKNOWN_PLAN']);

const reply = (res, status, value = null) => {
  const headers = value === null ? RESPONSE_HEADERS : { ...RESPONSE_HEADERS, 'content-type': 'application/json' };
  res.writeHead(status, headers);
  res.end(value === null ? '' : JSON.stringify(value));
};

const publicAccount = ({ id, email, name, plan, planGrantedAt }) => ({ id, email, name, plan, planGrantedAt });

const replyAccount = (res, account) => (
  account ? reply(res, STATUS.OK, publicAccount(account)) : reply(res, STATUS.NOT_FOUND)
);

const failureStatus = (error) => (BAD_REQUEST_CODES.has(error?.code) ? STATUS.BAD_REQUEST : STATUS.UNAVAILABLE);

// Two Google identities can share an email, so a search answers every match.
async function search(req, res, store) {
  const email = new URL(req.url, 'http://maintainer.invalid').searchParams.get('email');
  if (!email || email.length > MAX_EMAIL_LENGTH) { reply(res, STATUS.NOT_FOUND); return; }
  const accounts = await store.findAllByEmail(email);
  if (accounts.length === 0) reply(res, STATUS.NOT_FOUND);
  else reply(res, STATUS.OK, { accounts: accounts.map(publicAccount) });
}

async function changePlan(req, res, store, id) {
  const { plan } = await readJsonBody(req, MAX_PLAN_BODY_BYTES);
  replyAccount(res, await store.setPlan(id, plan));
}

const guarded = (res, work) => {
  work().catch((error) => { if (!res.headersSent) reply(res, failureStatus(error)); });
};

/**
 * Serves the owner's account lookup and plan routes. Returns false when the
 * request is not an accounts route so the caller can continue dispatching.
 */
export function handleMaintainerAccounts(req, res, { store, origins, authenticated }) {
  const plan = PLAN_ROUTE_RE.exec(req.url);
  if (!plan && !SEARCH_ROUTE_RE.test(req.url)) return false;
  const isPlanRoute = Boolean(plan);
  const method = isPlanRoute ? 'POST' : 'GET';
  if (isPlanRoute && !origins.has(req.headers.origin)) reply(res, STATUS.FORBIDDEN);
  else if (req.method !== method) reply(res, STATUS.METHOD_NOT_ALLOWED);
  else if (!authenticated(req)) reply(res, STATUS.UNAUTHORIZED);
  else if (!store) reply(res, STATUS.NOT_FOUND);
  else guarded(res, () => (isPlanRoute ? changePlan(req, res, store, plan[1]) : search(req, res, store)));
  return true;
}
