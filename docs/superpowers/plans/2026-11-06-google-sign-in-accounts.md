# Google sign-in, accounts and plan entitlements (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional Google sign-in on the relay, persistent accounts with a `free`/`pro` plan, one entitlement table, and owner plan grants in the maintainer console — without changing any room behaviour.

**Architecture:** OIDC authorization-code + PKCE in redirect mode, served by the existing relay under `/yjs/api/auth/*` and `/yjs/api/account*` (cloudflared routes `/yjs/*` straight to the relay, `cloudflared.prod.yml:14-16`; no nginx/CSP change). Accounts live as meta entries of a reserved, update-less document name in the existing LevelDB, written as one synchronous (fsync) batch per logical change. A stateless HMAC account cookie carries `accountId` + `sessionGeneration`; the store is the authority for logout-everywhere and deletion. Login flows are single-use through a bounded in-memory ledger.

**Tech Stack:** Node 24 (`node:crypto`, global `fetch`), y-leveldb 0.2.0 / classic-level, React 18 + Vite, `node:test`, global Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-11-06-room-password-e2e-google-auth-design.md` (§1, §4). Phases 2–3 (room password, E2E) get their own plan after this ships. Codex plan review (gpt-6.1-sol, medium, 2026-11-06) findings #1–#15 are folded in below.

## Global Constraints

- AGENTS.md hard rules apply to every task: Sonar-clean, cognitive complexity ≤15, named constants with units, imports at top, no new suppressions, colocated tests that fail when the code is reverted (state the revert check in each task report).
- `yjs-server.mjs` ceiling 1836 lines, `RetroBoard.jsx` 3993 (`src/rule-ratchets.test.js:8-9`); ceilings may only be lowered. New relay logic lives in `src/server/*.js` with `*.test.mjs`; the coordinator only constructs and wires.
- Every new relay module is added to the explicit `COPY` lists in `Dockerfile.yjs` and imported statically (the contract test only follows static imports).
- Every user-visible string — landing and maintainer — goes through `t()` with keys in both `th` and `en` of `src/client/ui/i18n.js`.
- UI uses `src/client/ui/theme.js` tokens and `UiPrimitives.jsx`; no colour literals.
- Account identity key is Google `sub`, never email. Scopes exactly `openid email profile`.
- Logs carry error codes only — never tokens, codes, cookies, URLs with queries, email or names. Repeated callback-failure lines are rate-limited with a suppressed count (reuse the relay's existing rejection counters if they fit).
- Every auth/account response sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer` (these responses bypass nginx headers).
- Do not read `.env`, credentials, `yjs-db/`, `uploads/` or production volumes. Never run a Compose command that would load the repo `.env`. Compose/`.env`/deploy changes are prepared for owner approval, never applied (Task 10). Docs/legal changes are committed on the feature branch; they ship only with the owner-approved deploy.
- Entitlement table starts with `free` = `pro` = `{ canCreateLockedRoom: true }` (owner decision 2026-11-06).
- Live runs: databases, uploads, browser scratch, screenshots and server logs under a per-run folder on `/Volumes/ssd-fluke/BaseData/retro-board/` (symlinked at `~/basedata/retro-board/<task>`); check the mount first and stop if missing. Long test/build runs are one blocking command redirected to a file; read only `tail`/`rg` of it. Unit-test temp files stay in the OS temp dir.

### Deviations from the spec

1. **TLS-only `id_token` validation (needs owner OK before Task 4).** The token comes straight from Google's fixed HTTPS token endpoint, which OIDC Core §3.1.3.7 item 6 and Google's docs allow in place of JWKS signature checks. Trust boundary: endpoint constant in production (override only in insecure dev), normal certificate validation, `redirect: 'error'`, never accept a browser-supplied ID token. Claims are still fully checked. The Compose change is general egress, not hostname-filtered.
2. Account key env/file follow the existing room-key pattern: `YJS_ACCOUNT_SESSION_SECRET` or persisted `<DB_DIR>/.account-session-key`.
3. Dev redirect URI is `http://localhost:1234/api/auth/google/callback` (dev relay is unprefixed on :1234).
4. Spec §4.5 says registry writes are "sync"; they are not (`y-leveldb.js:135` `db.put` without options). Accounts use explicit `sync: true` batches; the spec text is corrected in Task 9.

## Review Focus

1. **Callback replay / double-click / two tabs** — the same flow cookie bytes used twice (sequentially or concurrently) must fail the second time with `state_mismatch` and never issue a second session (Task 4 ledger tests, Task 5 route test).
2. **User cancels at Google** (`?error=access_denied`) — only after the flow cookie + state validate, return with `auth_error=access_denied`, no 500, no session; a forged error callback without a valid flow goes to the fixed fallback (Task 5).
3. **Open redirect / capability leak via `return`** — foreign origin, protocol-relative path or any fragment never leaves the server; the client never sends a fragment (Tasks 4, 7).
4. **Account deleted or logged-out-everywhere while a cookie is still alive** — `GET /api/account` answers 401 and clears the cookie (Task 3).
5. **Relay shutdown or storage failure during a login** — no session is issued after the store stopped or failed, and drain waits for in-flight token exchanges and account writes (Tasks 2, 5).

---

### Task 1: Free router lines in `yjs-server.mjs`

**Files:**
- Create: `src/server/relay-room-routes.js`, `src/server/relay-room-routes.test.mjs`
- Modify: `yjs-server.mjs:1378-1438` (`uploadMatch`/`roomImageMatch`, room preflight, room upload POST, room image GET, legacy image GET), `src/server/relay-http.js` (+ test), `Dockerfile.yjs`

**Interfaces:**
- Produces: `handleRoomRoute(req, res, routePath, ctx) → boolean` (synchronous match; async work is launched inside with `void`), `ctx = { hasQueryOrFragment, allowedOrigins, allowInsecureHttp, unavailable, rooms /* Map handle→docName */, authenticate /* (req, handle) → {docName}|null */, uploads, clientIp }`.
- Produces (`relay-http.js`): `sendCredentialPreflight(req, res, { allowedOrigins, allowInsecureHttp, methods }) → void` — Origin check, 204, methods, `Content-Type` allow-header, `CORS_PREFLIGHT_MAX_AGE_SECONDS`, `no-store`. Callers: coordinator `/api/rooms` + `/api/room-session` preflight, `handleRoomRoute`, Task 5.

- [ ] **Step 1: Failing tests** (fake `res`, stub `uploads`): `preflight for a registered room upload answers 204 with POST, OPTIONS`; `preflight for an unknown room handle answers 404`; `upload without a room session answers 401 and never calls uploads.handleUpload`; `room image with a foreign Origin answers 403`; `unrelated path returns false and writes nothing`; relay-http `preflight rejects a foreign Origin and sets max-age`.
- [ ] **Step 2:** run → FAIL (module/function missing)
- [ ] **Step 3:** Move the blocks into `handleRoomRoute` (behaviour unchanged); coordinator calls it once after `/readyz`; both preflight sites use `sendCredentialPreflight`.
- [ ] **Step 4:** full suite (redirected) → PASS; `wc -l yjs-server.mjs` ≤ 1800
- [ ] **Step 5:** Commit `refactor(relay): move room upload and image routes out of the coordinator`

### Task 2: Plan entitlements + durable account store

**Files:**
- Create: `src/domain/plan-entitlements.js` (+ `.test.js`), `src/server/account-store.js` (+ `.test.mjs`)
- Modify: `src/server/relay-storage.js` (+ test), `Dockerfile.yjs`

**Interfaces:**
- Domain: `PLAN = Object.freeze({ FREE: 'free', PRO: 'pro' })`; `entitlementsFor(plan) → { canCreateLockedRoom: boolean }` (unknown → all `false`); `isKnownPlan(plan) → boolean`.
- `relay-storage.js`: `durableMetaBatch(ldb, docName, ops /* [{ type: 'put', key, value } | { type: 'del', key }] */) → Promise<void>` — one `db.batch(…, { sync: true })` through `ldb._transact` using y-leveldb's `['v1', docName, 'meta', key]` key layout and `encodeAny` values (`y-leveldb.js:311, 560`); rejects with `STORAGE_FAILURE` when `_transact` swallows an error (null result). Document the private-API reliance next to the pinned y-leveldb version.
- Server: `ACCOUNTS_DOC_NAME = '\u0000accounts'`; `class AccountStore extends EventEmitter { constructor({ ldb, getMeta, hasCapacity, now = Date.now, randomId }); upsertFromGoogle({ sub, email, name }) → Promise<Account>; get(id); findByEmail(email); setPlan(id, plan) → Promise<Account|null>; bumpSessionGeneration(id); delete(id) → Promise<boolean>; get pendingOperations(): number; stop() → Promise<void> }`. Emits `'storage-failure'` (error) — the coordinator maps it to its existing storage-failure shutdown (lower-owned event, no callback into the coordinator). After `stop()` or a storage failure every mutation rejects with `ACCOUNT_STORE_UNAVAILABLE`; `hasCapacity()` false → `DATABASE_CAPACITY`.
- `Account = { id, googleSub, email, name /* '' when Google omits it */, plan, planGrantedAt /* ms|null */, sessionGeneration /* int ≥0 */, createdAt }`. Keys `acct:<id>`, `sub:<googleSub>` → id, `email:<lower-cased>` → id. Each logical change (create, email move, plan change, generation bump, delete) is exactly one `durableMetaBatch`. Mutations run through one promise chain that recovers after a rejection.

- [ ] **Step 1: Failing tests.** Domain: `free and pro both allow locked rooms`, `unknown plan has no entitlements`. Store (real `LeveldbPersistence` in an OS temp dir):
  - `upsert creates one free account per sub and is idempotent`
  - `concurrent upserts for one sub return the same id`
  - `upsert moves the email index when Google email changes`
  - `findByEmail is case-insensitive`
  - `setPlan rejects unknown plans and stamps planGrantedAt`
  - `delete removes record, sub and email indexes`
  - `accounts never appear in getAllDocNames`
  - `account records survive closing and reopening the database`
  - `a failed batch leaves no partial indexes and the next mutation still runs` (inject a failing `_transact`)
  - `storage failure emits storage-failure and later mutations reject`
  - `stop waits for queued mutations and rejects new ones`
  - `full database rejects upsert with DATABASE_CAPACITY`
  - relay-storage: `durableMetaBatch writes with sync true` (spy on `db.batch` options) and `null transact result raises STORAGE_FAILURE`
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `feat(accounts): plan entitlements and durable LevelDB account store`

### Task 3: Account session cookie

**Files:**
- Create: `src/server/auth-session.js` (+ `.test.mjs`)
- Modify: `src/server/relay-local-files.js` (+ test), `Dockerfile.yjs`

**Interfaces:**
- `loadSigningKey(dbDir, { envName, fileName }) → Buffer`; `loadSessionSigningKey(dbDir)` delegates with `{ envName: 'YJS_SESSION_SECRET', fileName: '.room-session-key' }`. Account key: `{ envName: 'YJS_ACCOUNT_SESSION_SECRET', fileName: '.account-session-key' }`.
- `ACCOUNT_SESSION_TTL_MS = 30 * MILLISECONDS_PER_DAY`; `accountCookiePath(prefixed) → '/yjs/api' | '/api'`; `class AccountSessions { constructor({ signingKey, allowInsecureHttp, maxCookieHeaderBytes }); createCookie(accountId, generation, path) → string; clearCookie(path) → string; read(req) → { accountId, generation, expiresAt } | null }`; `authenticateAccount(req, sessions, store) → Promise<Account|null>`.
- Cookie `rb_account=v1.<accountId>.<generation>.<expiresAt>.<hmac>`, host-only (no `Domain`), `HttpOnly; SameSite=Lax; Path=<path>; Max-Age`, `Secure` unless insecure dev. HMAC domain `account-session-v1\0`; compare with `fixedDigestEqual`. Duplicate names → null.

- [ ] **Step 1: Failing tests:** `round-trips a valid cookie`; `rejects tampered signature and non-canonical base64url`; `rejects expired and over-TTL expiry`; `rejects duplicate rb_account cookies`; `prefixed path is /yjs/api and Secure is set outside insecure dev`; `clearCookie uses the same path as createCookie`; `authenticateAccount rejects a stale generation`; `authenticateAccount rejects a deleted account`; `room and account keys load from different files`.
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `feat(accounts): signed account session cookie`

### Task 4: Google OIDC core

**Gate:** owner confirmed deviation 1 (TLS-only validation) — otherwise add JWKS verification to this task first.

**Files:**
- Create: `src/server/auth-google.js` (+ `.test.mjs`)
- Modify: `Dockerfile.yjs`

**Interfaces:**
- `googleOAuthConfig(env, { allowInsecureHttp }) → OAuthConfig | null` — null unless `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` are set. Endpoints `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`; `GOOGLE_OAUTH_ENDPOINT_BASE` overrides both and the expected `iss` only when `allowInsecureHttp`, else throws.
- Return contract — `returnUrl(raw, allowedOrigins, allowInsecureHttp) → string`: `raw` must parse as an absolute URL whose origin passes `isExactAllowedOrigin`, path starts with `/` not `//`; fragment is dropped; otherwise the fixed fallback `${allowedOrigins[0]}/`. `withAuthError(url, code) → string` sets `auth_error` via `URL.searchParams` (only codes from `AUTH_ERROR_CODES`).
- `class FlowLedger { constructor({ maxFlows = MAX_PENDING_FLOWS /* 10_000 */, ttlMs = FLOW_TTL_MS /* 600_000 */ }); register(state, expiresAt) → boolean /* false when full */; claim(state) → boolean /* true once */ }` — in memory; a relay restart invalidates outstanding flows (the user clicks sign-in again).
- `startAuthorization(config, returnTo, signingKey, ledger) → { location, flowCookie } | null` (null when ledger full → route 429). 32-byte `state`, `nonce`, PKCE verifier; `code_challenge_method=S256`; `prompt=select_account`. Flow cookie `rb_oauth_flow` = HMAC (domain `oauth-flow-v1\0`) over base64url JSON `{ state, nonce, verifier, returnTo, expiresAt }`; host-only, `HttpOnly; SameSite=Lax; Path=<prefix>/api/auth; Max-Age=600`, `Secure` unless insecure dev.
- `verifyFlow(query, flowCookieValue, signingKey, ledger, now) → Flow` — rejects duplicate `state`/`code` params, missing/duplicate/malformed cookie, bad HMAC (`fixedDigestEqual` on fixed-length buffers), expiry, `state` mismatch (`fixedDigestEqual`), then `ledger.claim(state)` **before** any token exchange. All → `state_mismatch`.
- `exchangeCode(config, flow, code, { fetchImpl = fetch, nowMs = Date.now() }) → Promise<{ sub, email, name }>` — form-encoded POST, `redirect: 'error'`, `AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS = 10_000)`, body capped at `MAX_TOKEN_RESPONSE_BYTES = 16_384`. Claims in **seconds**: `expSeconds`/`iatSeconds` must be safe integers; `expSeconds * 1000 > nowMs`; `iatSeconds * 1000 ≤ nowMs + CLOCK_SKEW_MS (60_000)`; `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`} (or dev override); `aud === clientId`; `nonce` matches (`fixedDigestEqual`); `sub` non-empty string ≤ `MAX_SUB_CHARACTERS = 255`; `email_verified === true`; `email` string ≤ 320; `name` optional string ≤ 200 (else `''`). Errors: `AuthError.code` ∈ `AUTH_ERROR_CODES = ['state_mismatch', 'access_denied', 'provider_error', 'token_exchange_failed', 'invalid_id_token', 'email_unverified']`.

- [ ] **Step 1: Failing tests** (stub `fetchImpl`; tokens use real seconds-based timestamps):
  - `config is null without all three env vars`; `endpoint override throws outside insecure dev`
  - `returnUrl rejects foreign origins and protocol-relative paths and drops fragments`; `withAuthError keeps existing query parameters`
  - `start builds an S256 challenge that matches the stored verifier`; `flow cookie is Secure outside insecure dev`
  - `verifyFlow accepts once and rejects the same cookie bytes again`; `two concurrent verifyFlow calls succeed exactly once`; `verifyFlow rejects missing, duplicate, tampered and expired cookies`; `verifyFlow rejects duplicate state parameters`; `ledger full makes start return null`
  - `exchange rejects wrong aud, wrong iss, expired exp, future iat, wrong nonce, missing or oversized sub`
  - `exchange rejects millisecond-valued exp as invalid_id_token` (guards the units)
  - `exchange rejects email_verified false`; `exchange accepts a missing name as empty`
  - `exchange maps non-200, redirects and oversized bodies to token_exchange_failed`
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement with `node:crypto` only.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `feat(auth): Google OIDC code flow with PKCE and single-use flows`

### Task 5: Auth and account HTTP routes, wired into the relay

**Files:**
- Create: `src/server/auth-routes.js` (+ `.test.mjs`), `src/server/auth-relay.test.mjs` (coordinator-level: starts `yjs-server.mjs` on a free port with a temp `YJS_DB_DIR`, the dev OIDC stub module `scripts/fake-google-oidc.mjs` (created here; Task 8 adds its CLI), and `YJS_ALLOW_INSECURE_HTTP` both on and off), `scripts/fake-google-oidc.mjs`
- Modify: `yjs-server.mjs` (construct ledger/store/sessions/config/routes; one dispatch call before `handleRoomRoute`; add `accountStore.pendingOperations > 0 || authRoutes.pendingExchanges > 0` to drain `isBusy`; `await accountStore.stop()` before `ldb.destroy()`; map `'storage-failure'` to the existing failure path), `Dockerfile.yjs`

**Interfaces:**
- `createAuthRoutes({ oauth, accountKey, sessions, store, ledger, allowedOrigins, allowInsecureHttp, maxBodyBytes, fetchImpl }) → { handle(req, res, routePath, { prefixed, clientIp, unavailable }) → boolean, get pendingExchanges(): number }` — `handle` matches synchronously, launches async work with `void` and a terminal catch that answers 503 once. It parses its own query (does **not** use the coordinator's `hasQueryOrFragment`); `unavailable` is lifecycle only.
- `startFakeGoogleOidc({ port }) → Promise<{ url, close }>` — `/o/oauth2/v2/auth` (consent + cancel), `/token` (checks PKCE verifier, single-use code, unsigned `id_token` with `iss = url`, seconds-based `exp`/`iat`, requested `nonce`, `email_verified: true`).
- Routes (bare and `/yjs`-prefixed):

| Method + path | Result |
|---|---|
| `GET /api/auth/google/start?return=` | 302 to Google + flow cookie; 429 when ledger full or per-IP limit; 404 when `oauth` null |
| `GET /api/auth/google/callback` | `verifyFlow` first. Valid + `error` param → 302 `withAuthError(returnTo, 'access_denied'|'provider_error')`. Valid + `code` → exchange, re-check `unavailable`/store, upsert, 302 `returnTo`, set `rb_account`. Invalid flow → 302 `withAuthError(fallback, 'state_mismatch')`. Always clear the flow cookie (separate `Set-Cookie` array entry). 404 when `oauth` null |
| `GET /api/account` | 200 `{ name, email, plan, entitlements }`; 401 + clear cookie when unauthenticated; 404 when `oauth` null. Origin: absent → allowed (same-origin prod); allowed → CORS headers; foreign or `null` → 403 (room-image GET pattern, `yjs-server.mjs:1426-1431`) |
| `POST /api/account/logout` · `/logout-all` · `/delete` | `acceptCredentialOrigin` (rejects missing, `null`, foreign); 204 + clear cookie; logout-all bumps generation; delete removes the account. Other methods → 405 |
| `OPTIONS /api/account*` | `sendCredentialPreflight` |

- Start/callback: per-IP `AUTH_FLOWS_PER_IP_PER_MINUTE = 20` via `trafficBucketFor` → 429. Every response: `no-store`, `no-referrer`.

- [ ] **Step 1: Failing tests.** `auth-routes.test.mjs` (real store on temp LevelDB, stub `fetchImpl`):
  - `auth routes answer 404 when Google is not configured`
  - `start sets rb_oauth_flow and redirects to the authorize endpoint`
  - `callback signs in, redirects to returnTo and sets rb_account while clearing rb_oauth_flow` (assert the `Set-Cookie` array)
  - `callback replayed with the original cookie bytes answers state_mismatch and sets no rb_account`
  - `callback with error=access_denied but a mismatched state goes to the fallback with state_mismatch`
  - `callback maps provider error to auth_error after a valid flow`
  - `callback after store stop or storage failure issues no session`
  - `account GET without an Origin header answers 200`; `account GET with a foreign or null Origin answers 403`
  - `account POSTs reject missing, null and foreign Origin with 403`; `GET on logout and delete answers 405`
  - `account answers 401 and clears the cookie after logout-all`
  - `delete removes the account and a later sign-in creates a new free account`
  - `start beyond 20 per minute from one IP answers 429`
  - `every auth response has no-store and no-referrer`

  `auth-relay.test.mjs` (real coordinator + stub): `prefixed callback sets Path=/yjs/api; Secure when insecure HTTP is off`; `callback query is not rejected by the coordinator`; `drain waits for an in-flight token exchange`.
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement and wire; `wc -l yjs-server.mjs` ≤ 1836.
- [ ] **Step 4:** full suite (redirected) → PASS
- [ ] **Step 5:** Commit `feat(auth): sign-in, account and logout routes on the relay`

### Task 6: Maintainer console — Accounts

**Files:**
- Create: `src/server/maintainer-accounts.js` (+ `.test.mjs`), `src/client/maintainer/Accounts.jsx` (+ `.test.js`)
- Modify: `src/server/maintainer-server.js` (`startMaintainer(env, snapshot, roomAccess, retireIdle = null, accounts = null)` forwards `accounts` into `createMaintainerServer({ …, accounts })`; dispatch after `allowedRequest`), `yjs-server.mjs:1320` call, `src/client/maintainer/Maintainer.jsx`, `src/client/ui/i18n.js` (th + en), `Dockerfile.yjs`

**Interfaces:**
- `handleMaintainerAccounts(req, res, { store, origins, authenticated /* (req) → boolean */ }) → boolean` (sync match, async inside with terminal catch): `GET /api/accounts?email=<email>` → 200 `{ id, email, name, plan, planGrantedAt }` | 404; `POST /api/accounts/<id>/plan` JSON `{ plan }` via `readJsonBody` with a small cap → 200 account | 400 | 404. Exact-Origin check on POST like `joinRoom` (`maintainer-server.js:76-82`); unauthenticated → 401.
- UI: follow `RoomAccess.jsx` (fetch with `credentials: 'same-origin'`, timeout, `t()` errors). Keys: `maintainer.accounts.title`, `.search`, `.notFound`, `.grantPro`, `.revokePro`, `.plan.free`, `.plan.pro`, `.error`.

- [ ] **Step 1: Failing tests:** listening-server integration `requires the owner key or session`, `rejects wrong Host and foreign Origin`, `rejects malformed JSON with 400`, `finds by email case-insensitively`, `grants and revokes pro`, `rejects unknown plan with 400`; UI `shows not-found for an unknown email`, `toggles grant and revoke`, `every maintainer.accounts key exists in th and en`.
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `feat(maintainer): find accounts and grant or revoke pro`

### Task 7: Client account menu

**Files:**
- Create: `src/client/account/account-api.js` (+ `.test.js`), `src/client/account/in-app-browser.js` (+ `.test.js`), `src/client/account/AccountMenu.jsx` (+ `.test.js`), `src/client/account/account.css`
- Modify: `src/client/app/SiteMasthead.jsx` (`CornerToggles` renders `<AccountMenu />` before `LanguagePicker`), `src/client/ui/i18n.js` (th + en)

**Interfaces:**
- Consumes Task 5 routes via `getRelayHttpBaseUrl()` (`src/client/session/room-session.js:115`); all account fetches use `credentials: 'include'`.
- `fetchAccount() → Promise<{ status: 'disabled'|'signed-out'|'signed-in'|'unavailable', account? }>` (404 → disabled, 401 → signed-out, 200 → signed-in, network/5xx → unavailable); `signInHref() → string` — `return` is `location.origin + location.pathname + location.search`, never the fragment; `logout()`, `logoutAll()`, `deleteAccount()`; `isInAppBrowser(userAgent)` true for `Line/`, `FBAN`, `FBAV`, `FB_IAB`, `Messenger`, `Instagram`; `readAuthError(search) → string|null` (only `AUTH_ERROR_CODES`; strips the param with `history.replaceState`).
- UI: disabled → nothing; unavailable → small retry button; signed-out → "Sign in with Google" link, or in-app notice + copy-link; signed-in → name + plan badge, menu Sign out / Sign out everywhere / Delete account (existing confirm primitive). `auth_error` → toast `t('account.error.<code>')`.
- Keys (th + en): `account.signIn`, `account.signOut`, `account.signOutAll`, `account.delete`, `account.deleteConfirm`, `account.plan.free`, `account.plan.pro`, `account.inAppBrowser`, `account.copyLink`, `account.retry`, `account.error.<each AUTH_ERROR_CODES entry>`.

- [ ] **Step 1: Failing tests:** `fetchAccount maps 404/401/200/503/network`; `signInHref never contains the fragment`; `isInAppBrowser detects LINE and Facebook but not Chrome or Safari`; `readAuthError ignores unknown codes and strips the parameter`; `AccountMenu renders nothing when disabled`; `shows in-app notice instead of the sign-in link inside LINE`; `every account.* key exists in th and en`.
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement with theme tokens only.
- [ ] **Step 4:** run → PASS; `npm run build` (redirected) → success
- [ ] **Step 5:** Commit `feat(account): sign-in menu on the home masthead`

### Task 8: Dev OIDC CLI and live checks

**Files:**
- Create: `scripts/account-live-check.mjs`
- Modify: `scripts/fake-google-oidc.mjs` (CLI entry when run directly, port `${FAKE_OIDC_PORT:-4455}`), `scripts/README.md`, `package.json` (`"oidc:dev": "node scripts/fake-google-oidc.mjs"`)

**Interfaces:**
- `node scripts/account-live-check.mjs <local-base-url> <BaseData output>` — header documents isolated servers like `ui-live-check.mjs:4-8`: relay with `YJS_DB_DIR=<out>/db`, `YJS_UPLOADS_DIR=<out>/uploads`, `GOOGLE_OAUTH_ENDPOINT_BASE`, dummy client id/secret, `GOOGLE_OAUTH_REDIRECT_URI=http://localhost:<relay>/api/auth/google/callback`; server logs to `<out>/relay.log`.
- Checks (contexts A en, B th): A signs in → name + Free; maintainer API grants Pro → A sees Pro after reload; A reloads and stays signed in; cancel at the stub → `access_denied` toast; A "Sign out everywhere" → signed-out; A delete account → signed-out and a new sign-in shows Free; B stays a guest and creates a board; A and B open the same board, edit both ways, undo/redo — proves sign-in changed nothing in collaboration (reuse `ui-live-check.mjs` helpers if exported, else run it as a second step).

- [ ] **Step 1:** Write the scripts.
- [ ] **Step 2:** Check `/Volumes/ssd-fluke/BaseData` is mounted; create `retro-board/account-live-<YYYYMMDD>` + `~/basedata` symlink; start stub, relay, Vite; run the check redirected → `report.json` all PASS; `node scripts/ui-live-check.mjs` on the same servers → PASS.
- [ ] **Step 3:** Commit `test(account): dev OIDC CLI and two-context live check`

Residual risk stated in the report: browsers' handling of `Secure` + `Path=/yjs/api` over real HTTPS is covered by coordinator tests (Task 5) and the production smoke check in Task 10, not by a local browser run.

### Task 9: Docs, legal and backup verification

**Files:**
- Modify: `SECURITY.md` (Accounts section: optional Google identity, stored fields, cookie flags, single-use flows, TLS-only token trust boundary, accounts do not change room capability rules), `DEPLOYMENT.md` (env names, Google console setup, egress requirement, account backup decision), `src/client/legal/legal-content.js` + i18n th/en (privacy: Google `sub`, email, name, plan; purpose; deletion; bump `LEGAL_EFFECTIVE_DATE_ISO`), spec §4 (deviations 1–4), `scripts/verify-production-backup.sh` + its helper (decode every `acct:` record, check `sub:`/`email:` indexes point to existing accounts and every account has both; backups without an accounts namespace still pass), `src/rule-ratchets.test.js` (lower `YJS_SERVER_MAX_LINES` to final `wc -l yjs-server.mjs`)

- [ ] **Step 1: Failing tests:** `privacy policy has an accounts section in th and en`; verifier fixture tests on a synthetic LevelDB (OS temp dir): `known account, grant and generation verify`, `a dangling email index fails`, `a corrupt account record fails`, `a pre-accounts backup still verifies`.
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Write docs/legal/verifier changes; lower the ratchet.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `docs(accounts): security model, deployment, privacy policy and backup verification`

### Task 10: Production preparation (owner approval — prepare, then stop)

**Files:**
- Create: `docs/plans/2026-11-06-google-sign-in-rollout.md`

- [ ] **Step 1:** Draft the `docker-compose.prod.yml` diff: non-internal `relay_egress` network on `yjs` only (general egress — say so), env passthrough `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI=https://retroroom.party/yjs/api/auth/google/callback`, optional `YJS_ACCOUNT_SESSION_SECRET`. Not applied.
- [ ] **Step 2:** Run the release-gate steps that do not invoke Compose (tests, build, image build with explicit build args) redirected; list the Compose steps as **pending owner** with the exact commands.
- [ ] **Step 3:** Write the post-deploy smoke check for the owner: sign in on retroroom.party, reload, sign out everywhere in a second browser, delete account, open an existing board.
- [ ] **Step 4:** Commit the rollout doc; report to the owner and stop.
