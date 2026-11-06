# Google sign-in, accounts and plan entitlements (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional Google sign-in on the relay, persistent accounts with a `free`/`pro` plan, one entitlement table, and owner plan grants in the maintainer console — without changing any room behaviour.

**Architecture:** OIDC authorization-code + PKCE in redirect mode, served by the existing relay under `/yjs/api/auth/*` and `/yjs/api/account*` (cloudflared already routes `/yjs/*` to the relay; no nginx/CSP change). Accounts live as meta entries of a reserved, update-less document name in the existing LevelDB, so `getAllDocNames()` never lists them and existing backups include them. A stateless HMAC account cookie carries `accountId` + `sessionGeneration`; the store is the authority for logout-everywhere and deletion.

**Tech Stack:** Node 24 (`node:crypto`, global `fetch`), y-leveldb 0.2.0, React 18 + Vite, `node:test`, global Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-11-06-room-password-e2e-google-auth-design.md` (§1, §4). Phases 2–3 (room password, E2E) get their own plan after this ships.

## Global Constraints

- AGENTS.md hard rules apply to every task: Sonar-clean, cognitive complexity ≤15, named constants with units, imports at top, no new suppressions, colocated tests that fail when the code is reverted.
- `yjs-server.mjs` ceiling is 1836 lines and `RetroBoard.jsx` 3993 (`src/rule-ratchets.test.js:8-9`); ceilings may only be lowered. New relay logic lives in `src/server/*.js` with `*.test.mjs`; `yjs-server.mjs` only constructs and wires.
- Every new relay module is added to the explicit `COPY` lists in `Dockerfile.yjs` (contract test enforces transitive imports).
- Every user-visible string goes through `t()` with keys in both `th` and `en` of `src/client/ui/i18n.js` (other locales fall back to `en`).
- UI uses `src/client/ui/theme.js` tokens and `UiPrimitives.jsx`; no colour literals.
- Account identity key is Google `sub`, never email. Scopes exactly `openid email profile`.
- Logs carry error codes only — never tokens, codes, cookies, email or names.
- Do not read `.env`, credentials, `yjs-db/`, `uploads/` or production volumes. Compose and `.env` changes are prepared for owner approval, never applied (Task 10).
- Entitlement table starts with `free` = `pro` = `{ canCreateLockedRoom: true }` (owner decision 2026-11-06).

### Deviations from the spec (decided while reading code; Task 9 updates the spec text)

1. `id_token` signature is not checked against JWKS: the token comes straight from Google's token endpoint over TLS, which OIDC Core §3.1.3.7 allows in place of signature validation. Claims (`iss`, `aud`, `exp`, `iat`, `nonce`, `email_verified`) are still checked. Egress narrows to `oauth2.googleapis.com`.
2. Account key env/file follow the existing room-key pattern: `YJS_ACCOUNT_SESSION_SECRET` or persisted `<DB_DIR>/.account-session-key` (spec said `ACCOUNT_SESSION_KEY`).
3. Dev redirect URI is the relay's own origin `http://localhost:1234/api/auth/google/callback` (dev relay is unprefixed on port 1234; cookies are host-scoped so the Vite page on :5173 sees them).

## Review Focus

1. **Callback replay / double-click** — the same `state` used twice must fail the second time with `state_mismatch` and must not create a second session (Task 5 test `callback rejects a reused flow cookie`).
2. **User cancels at Google** (`?error=access_denied`) — return to the page with `auth_error=access_denied`, no 500, no session (Task 5 test `callback maps provider error to auth_error`).
3. **Open redirect via `return`** — any origin outside `YJS_ALLOWED_ORIGINS` or a non-`/` path falls back to the first allowed origin `/` (Task 4 test `returnUrl rejects foreign origins and protocol-relative paths`).
4. **Account deleted or logged-out-everywhere while a cookie is still alive** — `GET /api/account` answers 401 and clears the cookie (Task 3 test `authenticateAccount rejects a stale generation` and `... a deleted account`).
5. **Email changed at Google for an existing `sub`** — same account id, email index moves, old email no longer finds it (Task 2 test `upsert moves the email index when Google email changes`).

---

### Task 1: Free router lines in `yjs-server.mjs`

Moving existing logic out is welcome (AGENTS.md); later tasks need wiring lines and the file is at its ceiling.

**Files:**
- Create: `src/server/relay-room-routes.js`, `src/server/relay-room-routes.test.mjs`
- Modify: `yjs-server.mjs:1387-1438` (the `uploadMatch`/`roomImageMatch` regexes, the room OPTIONS preflight, room upload POST, room image GET and legacy image GET), `Dockerfile.yjs` server COPY list

**Interfaces:**
- Produces: `handleRoomRoute(req, res, routePath, ctx) → boolean` where `ctx = { hasQueryOrFragment, allowedOrigins, allowInsecureHttp, unavailable, rooms /* Map handle→docName */, authenticate /* (req, handle) → {docName}|null */, uploads, clientIp }`. Returns `true` when it answered. Also exports `CORS_ROOM_METHODS = 'POST, OPTIONS'` reused by Task 5's preflight.

- [ ] **Step 1: Write failing tests** in `relay-room-routes.test.mjs` with a fake `res` and stub `uploads`:
  - `preflight for a registered room upload answers 204 with POST, OPTIONS`
  - `preflight for an unknown room handle answers 404`
  - `upload without a room session answers 401 and never calls uploads.handleUpload`
  - `room image with a foreign Origin answers 403`
  - `unrelated path returns false and writes nothing`
- [ ] **Step 2:** `npm test -- src/server/relay-room-routes.test.mjs` → FAIL (module missing)
- [ ] **Step 3:** Move the blocks verbatim into `handleRoomRoute`; `yjs-server.mjs` calls it once after the `/readyz` branch. Keep the `/api/rooms` and `/api/room-session` OPTIONS handling where it is.
- [ ] **Step 4:** `npm test -- --test-concurrency=1` → all PASS; `wc -l yjs-server.mjs` ≤ 1800
- [ ] **Step 5:** Commit `refactor(relay): move room upload and image routes out of the coordinator`

### Task 2: Plan entitlements + account store

**Files:**
- Create: `src/domain/plan-entitlements.js` (+ `.test.js`), `src/server/account-store.js` (+ `.test.mjs`)
- Modify: `src/server/relay-storage.js` (add `delMeta`), `src/server/relay-storage.test.mjs`, `Dockerfile.yjs` (domain + server lists)

**Interfaces:**
- Produces (domain): `PLAN = Object.freeze({ FREE: 'free', PRO: 'pro' })`; `entitlementsFor(plan: string) → { canCreateLockedRoom: boolean }` (unknown plan → all `false`); `isKnownPlan(plan) → boolean`.
- Produces (server): `ACCOUNTS_DOC_NAME = '\u0000accounts'`; `class AccountStore { constructor(storage /* checkedStorage */, { now = Date.now, randomId }) ; upsertFromGoogle({ sub, email, name }) → Promise<Account>; get(id) → Promise<Account|null>; findByEmail(email) → Promise<Account|null>; setPlan(id, plan) → Promise<Account|null>; bumpSessionGeneration(id) → Promise<Account|null>; delete(id) → Promise<boolean> }`.
- `Account = { id, googleSub, email, name, plan, planGrantedAt /* ms|null */, sessionGeneration /* int ≥0 */, createdAt }`. Meta keys: `acct:<id>`, `sub:<googleSub>` → id, `email:<lower-cased email>` → id. `id` = 16 random bytes base64url. New accounts start `plan: 'free'`.
- Writes are serialized through one in-process promise chain (two callbacks for one `sub` must not create two accounts). Plan changes are durable records: each `setMeta` is awaited before resolving.

- [ ] **Step 1: Failing tests.** Domain: `free and pro both allow locked rooms`, `unknown plan has no entitlements`. Store (real `LeveldbPersistence` in a test temp dir, wrapped by `checkedStorage`):
  - `upsert creates one free account per sub and is idempotent`
  - `concurrent upserts for one sub return the same id`
  - `upsert moves the email index when Google email changes`
  - `findByEmail is case-insensitive`
  - `setPlan rejects unknown plans and stamps planGrantedAt`
  - `delete removes record, sub and email indexes`
  - `accounts never appear in getAllDocNames` (after writes, `getAllDocNames()` excludes `ACCOUNTS_DOC_NAME`)
  - relay-storage: `delMeta null result raises STORAGE_FAILURE`
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement. `delMeta` follows the `setMeta` null-check contract in `checkedStorage`.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `feat(accounts): plan entitlements and LevelDB account store`

### Task 3: Account session cookie

**Files:**
- Create: `src/server/auth-session.js` (+ `.test.mjs`)
- Modify: `src/server/relay-local-files.js` (generalize key loader), its test, `Dockerfile.yjs`

**Interfaces:**
- Produces: `loadSigningKey(dbDir, { envName, fileName }) → Buffer` (32+ bytes; existing `loadSessionSigningKey(dbDir)` becomes `loadSigningKey(dbDir, { envName: 'YJS_SESSION_SECRET', fileName: '.room-session-key' })`). Account key: `{ envName: 'YJS_ACCOUNT_SESSION_SECRET', fileName: '.account-session-key' }`.
- Produces: `ACCOUNT_SESSION_TTL_MS = 30 * MILLISECONDS_PER_DAY`; `class AccountSessions { constructor({ signingKey, allowInsecureHttp, maxCookieHeaderBytes }); createCookie(accountId, generation, path) → string; clearCookie(path) → string; read(req) → { accountId, generation, expiresAt } | null }`; `authenticateAccount(req, sessions, store) → Promise<Account|null>` (null when cookie invalid, account missing, or `generation !== account.sessionGeneration`).
- Cookie `rb_account=v1.<accountId>.<generation>.<expiresAt>.<hmac>`; `HttpOnly; SameSite=Lax; Path=<path>; Max-Age`; `Secure` unless insecure dev. HMAC domain string `account-session-v1\0`. Duplicate cookie names → null (same rule as `relay-session.js`). Path is `/yjs/api` when the request was prefixed, `/api` otherwise.

- [ ] **Step 1: Failing tests:** `round-trips a valid cookie`, `rejects tampered signature`, `rejects expired and over-TTL expiry`, `rejects duplicate rb_account cookies`, `authenticateAccount rejects a stale generation`, `authenticateAccount rejects a deleted account`, `room and account keys load from different files`.
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement, reusing `fixedDigestEqual` from `relay-room-registry.js`.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `feat(accounts): signed account session cookie`

### Task 4: Google OIDC core

**Files:**
- Create: `src/server/auth-google.js` (+ `.test.mjs`)
- Modify: `Dockerfile.yjs`

**Interfaces:**
- Produces: `googleOAuthConfig(env, { allowInsecureHttp }) → OAuthConfig | null` — null unless `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` are all set. Endpoints default to `https://accounts.google.com/o/oauth2/v2/auth` and `https://oauth2.googleapis.com/token`; `GOOGLE_OAUTH_ENDPOINT_BASE` overrides both (and the expected `iss`) **only** when `allowInsecureHttp` is true, otherwise config throws.
- `returnUrl(raw, allowedOrigins, allowInsecureHttp) → string` — `raw` must be an absolute URL whose origin passes `isExactAllowedOrigin` and whose path starts with `/` but not `//`; otherwise `${allowedOrigins[0]}/` (dev: `http://localhost:5173/`).
- `startAuthorization(config, returnTo, signingKey) → { location: string, flowCookie: string }` — 32-byte `state`, 32-byte `nonce`, 32-byte PKCE verifier, `code_challenge_method=S256`, `prompt=select_account`. Flow cookie `rb_oauth_flow` = HMAC-signed (domain `oauth-flow-v1\0`) JSON of `{ state, nonce, verifier, returnTo, expiresAt }`, `HttpOnly; SameSite=Lax; Path=<prefix>/api/auth; Max-Age=600`.
- `completeAuthorization(config, { query, flowCookieValue, signingKey, fetchImpl = fetch, now = Date.now() }) → Promise<{ profile: { sub, email, name }, returnTo }>`; throws `AuthError` with `code` ∈ `state_mismatch | access_denied | provider_error | token_exchange_failed | invalid_id_token | email_unverified`. Token request is `application/x-www-form-urlencoded`, `AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS = 10_000)`, response capped at `MAX_TOKEN_RESPONSE_BYTES = 16_384`. Claims: `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`} (or override issuer), `aud === clientId`, `exp > now`, `iat ≤ now + CLOCK_SKEW_MS (60_000)`, `nonce` matches, `email_verified === true`.

- [ ] **Step 1: Failing tests** (stub `fetchImpl` returns crafted token responses; never call the network):
  - `config is null without all three env vars`
  - `endpoint override throws outside insecure dev`
  - `returnUrl rejects foreign origins and protocol-relative paths`
  - `start builds an S256 challenge that matches the stored verifier`
  - `complete rejects mismatched state` / `expired flow cookie` / `tampered flow cookie`
  - `complete maps ?error=access_denied to access_denied`
  - `complete rejects wrong aud, wrong iss, expired exp, future iat, wrong nonce`
  - `complete rejects email_verified false`
  - `complete maps non-200 and oversized token responses to token_exchange_failed`
  - `complete returns sub, email, name and returnTo on success`
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement with `node:crypto` only (`randomBytes`, `createHash('sha256')`, `createHmac`); decode the JWT payload segment with base64url → JSON.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `feat(auth): Google OIDC authorization code flow with PKCE`

### Task 5: Auth and account HTTP routes, wired into the relay

**Files:**
- Create: `src/server/auth-routes.js` (+ `.test.mjs`)
- Modify: `yjs-server.mjs` (construct store/sessions/config/routes; one dispatch call before `handleRoomRoute`), `Dockerfile.yjs`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `createAuthRoutes({ oauth /* OAuthConfig|null */, accountKey, sessions, store, allowedOrigins, allowInsecureHttp, maxBodyBytes, now }) → { handle(req, res, routePath, { prefixed, clientIp, hasQueryOrFragment, unavailable }) → boolean }`.
- Routes (bare and `/yjs`-prefixed, like existing ones):

| Method + path | Result |
|---|---|
| `GET /api/auth/google/start?return=` | 302 to Google + flow cookie; 404 when `oauth` null |
| `GET /api/auth/google/callback` | success: upsert, 302 to `returnTo`, set `rb_account`, clear flow cookie; error: 302 to `returnTo?auth_error=<code>`, clear flow cookie; 404 when `oauth` null |
| `GET /api/account` | 200 `{ name, email, plan, entitlements }`; 401 + clear cookie when unauthenticated; 404 when `oauth` null |
| `POST /api/account/logout` | 204 + clear cookie |
| `POST /api/account/logout-all` | bump generation, 204 + clear cookie |
| `POST /api/account/delete` | delete account, 204 + clear cookie |
| `OPTIONS /api/account*` | credential preflight like existing routes |

- `GET /api/account` and every POST pass `acceptCredentialOrigin`. Start/callback are top-level navigations (no Origin check), rate-limited per IP with `trafficBucketFor` at `AUTH_FLOWS_PER_IP_PER_MINUTE = 20` → 429. Callback failures log `[auth] google callback failed { code }` only.

- [ ] **Step 1: Failing tests** (real `AccountStore` on temp LevelDB, stubbed `fetchImpl` via an injected oauth stub):
  - `auth routes answer 404 when Google is not configured`
  - `start sets rb_oauth_flow and redirects to the authorize endpoint`
  - `callback signs in and redirects to returnTo with rb_account set`
  - `callback rejects a reused flow cookie`
  - `callback maps provider error to auth_error`
  - `account answers 401 and clears the cookie after logout-all`
  - `account POSTs reject a foreign Origin with 403`
  - `delete removes the account and later callbacks create a new free account`
  - `start beyond 20 per minute from one IP answers 429`
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement and wire; `wc -l yjs-server.mjs` must stay ≤ 1836.
- [ ] **Step 4:** `npm test -- --test-concurrency=1` → PASS
- [ ] **Step 5:** Commit `feat(auth): sign-in, account and logout routes on the relay`

### Task 6: Maintainer console — Accounts

**Files:**
- Create: `src/server/maintainer-accounts.js` (+ `.test.mjs`), `src/client/maintainer/Accounts.jsx` (+ `.test.js`)
- Modify: `src/server/maintainer-server.js` (accept `accounts` option, delegate before the GET-only check), `yjs-server.mjs` `startMaintainer` call (pass store), `src/client/maintainer/Maintainer.jsx` (mount panel), `Dockerfile.yjs`

**Interfaces:**
- Produces: `handleMaintainerAccounts(req, res, { store, authorized /* boolean */ }) → boolean` for `GET /api/accounts?email=<email>` → 200 `{ id, email, name, plan, planGrantedAt }` | 404, and `POST /api/accounts/<id>/plan` body `{ plan }` → 200 account | 400 unknown plan | 404. Unauthorized → 401. Same Origin rules as the existing join/retire routes.
- UI: email search field, result row with plan badge and one Grant Pro / Revoke Pro button; follow `RoomAccess.jsx` patterns for fetch/error states and strings.

- [ ] **Step 1: Failing tests:** server `requires the owner key or session`, `finds by email case-insensitively`, `grants and revokes pro`, `rejects unknown plan with 400`; UI `shows not-found for an unknown email`, `toggles grant and revoke`.
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** run → PASS
- [ ] **Step 5:** Commit `feat(maintainer): find accounts and grant or revoke pro`

### Task 7: Client account menu

**Files:**
- Create: `src/client/account/account-api.js` (+ `.test.js`), `src/client/account/in-app-browser.js` (+ `.test.js`), `src/client/account/AccountMenu.jsx` (+ `.test.js`), `src/client/account/account.css`
- Modify: `src/client/app/SiteMasthead.jsx` (`CornerToggles` renders `<AccountMenu />` before `LanguagePicker`), `src/client/ui/i18n.js` (th + en)

**Interfaces:**
- Consumes: Task 5 routes via `getRelayHttpBaseUrl()` from `src/client/session/room-session.js`.
- Produces: `fetchAccount() → Promise<{ status: 'disabled'|'signed-out'|'signed-in', account?: { name, email, plan, entitlements } }>` (404 → disabled, 401 → signed-out, network failure → signed-out); `signInHref(returnTo = location.href) → string`; `logout()`, `logoutAll()`, `deleteAccount()` → `Promise<void>`; `isInAppBrowser(userAgent) → boolean` (true for `Line/`, `FBAN`, `FBAV`, `FB_IAB`, `Messenger`, `Instagram`); `readAuthError(search) → string|null` (removes `auth_error` from the URL with `history.replaceState`).
- UI states: disabled → nothing rendered; signed-out → "Sign in with Google" link (or in-app notice with copy-link button); signed-in → name + plan badge, menu: Sign out, Sign out everywhere, Delete account (confirm dialog via existing confirm primitive). `auth_error` → toast with `t('account.error.<code>')`.
- i18n keys (th + en): `account.signIn`, `account.signOut`, `account.signOutAll`, `account.delete`, `account.deleteConfirm`, `account.plan.free`, `account.plan.pro`, `account.inAppBrowser`, `account.copyLink`, `account.error.state_mismatch`, `account.error.access_denied`, `account.error.provider_error`, `account.error.token_exchange_failed`, `account.error.invalid_id_token`, `account.error.email_unverified`.

- [ ] **Step 1: Failing tests:** `fetchAccount maps 404/401/200`, `isInAppBrowser detects LINE and Facebook but not Chrome or Safari`, `readAuthError strips the parameter`, `AccountMenu renders nothing when disabled`, `shows in-app notice instead of the sign-in link inside LINE`, `every account.* key exists in th and en`.
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3:** Implement with theme tokens only.
- [ ] **Step 4:** run → PASS; `npm run build` → success
- [ ] **Step 5:** Commit `feat(account): sign-in menu on the home masthead`

### Task 8: Dev OIDC stub and live check

**Files:**
- Create: `scripts/fake-google-oidc.mjs`, `scripts/account-live-check.mjs`
- Modify: `scripts/README.md` (catalog), `package.json` (`"oidc:dev": "node scripts/fake-google-oidc.mjs"`)

**Interfaces:**
- `fake-google-oidc.mjs` listens on `127.0.0.1:${FAKE_OIDC_PORT:-4455}`: `/o/oauth2/v2/auth` shows a one-button page that redirects back with a code; `/token` checks the PKCE verifier and returns an unsigned-JWT `id_token` with `iss = http://127.0.0.1:4455`, the requested `nonce`, `email_verified: true`. Run relay with `GOOGLE_OAUTH_ENDPOINT_BASE=http://127.0.0.1:4455` plus dummy client id/secret and `GOOGLE_OAUTH_REDIRECT_URI=http://localhost:1234/api/auth/google/callback`.
- `account-live-check.mjs` (two Playwright contexts): A signs in → masthead shows name + Free; B stays a guest and can still create and open a board; maintainer API grants Pro → A sees Pro after reload; A "Sign out everywhere" → A signed-out; cancel at the stub → `auth_error=access_denied` toast; run once with `rb_lang=th` and once `en`.

- [ ] **Step 1:** Write both scripts.
- [ ] **Step 2:** Run `npm run oidc:dev`, relay with the env above, `npm run dev`, then `node scripts/account-live-check.mjs > <session scratchpad>/account-live.log 2>&1`; `tail` → all checks PASS.
- [ ] **Step 3:** Commit `test(account): dev OIDC stub and two-context live check`

### Task 9: Docs and legal

**Files:**
- Modify: `SECURITY.md` (new "Accounts" section: optional Google identity, what is stored, cookie flags, accounts do not change room capability rules yet), `DEPLOYMENT.md` (env names, Google console setup, egress requirement), `src/client/legal/legal-content.js` + i18n keys (privacy: data collected = Google `sub`, email, name, plan; purpose; deletion via Delete account; bump `LEGAL_EFFECTIVE_DATE_ISO`), spec §4 (apply the three deviations above)

- [ ] **Step 1:** Add a legal-content test `privacy policy has an accounts section in th and en`; run → FAIL
- [ ] **Step 2:** Write the docs/legal changes; run → PASS
- [ ] **Step 3:** Commit `docs(accounts): security model, deployment and privacy policy for Google sign-in`

### Task 10: Production preparation (owner approval — prepare, then stop)

**Files:**
- Create: `docs/plans/2026-11-06-google-sign-in-rollout.md` (proposed diff + steps); optionally a `wizard` script for the Google console steps

- [ ] **Step 1:** Draft the `docker-compose.prod.yml` change: a non-internal `relay_egress` network attached to `yjs` only, plus env passthrough of `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI=https://retroroom.party/yjs/api/auth/google/callback`, `YJS_ACCOUNT_SESSION_SECRET` (optional). Do not apply.
- [ ] **Step 2:** Run the full release gate from `DEPLOYMENT.md` on a clean checkout; record pass/fail counts in the rollout doc.
- [ ] **Step 3:** Commit the rollout doc; report to the owner and stop.
