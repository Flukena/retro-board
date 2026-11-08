# Room password + end-to-end encrypted rooms (phases 2 and 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user can create a board that needs both the link and a password. Its content, presence and images are encrypted in the browser, so the relay and the server owner cannot read them.

**Architecture:** Each locked room stores a lock record next to its registry entry. It holds the salt, KDF parameters, verifier, wrapped room key, key epoch and owner account. The session exchange gains a second step that proves the password with a derived `authKey`. An E2E room never gets a `Y.Doc` on the relay. A separate WebSocket path (`/rooms/<handle>/e2e`) carries framed AES-GCM ciphertext. The relay stores it as an ordered log plus one client-written snapshot in the room's LevelDB meta keys. In the browser an E2E provider holds the real `Y.Doc` and implements the same contract the board already uses with y-websocket.

**Tech Stack:** WebCrypto (PBKDF2, HKDF, AES-GCM) in the browser, `ws` + y-leveldb 0.2.0 on the relay, Yjs/y-protocols awareness in the client, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-06-room-password-e2e-google-auth-design.md` sections 1, 5, 6, 7, 8 and 10. Phase 1 (sign-in, accounts, entitlements) is shipped. Its plan, `docs/superpowers/plans/2026-11-06-google-sign-in-accounts.md`, gives the conventions.

## Global Constraints

- `RetroBoard.jsx` is capped at **3993** lines and `yjs-server.mjs` at **1814** (`src/rule-ratchets.test.js`). Ceilings only go down. Each new line of wiring is paid for by moving existing logic out to a module in the same task.
- Layers: client and server import only their own layer plus `src/domain` (`src/architecture.test.js`). Domain modules use no `node:` imports and no `window`/`document`/`navigator`.
- Every new server or domain module goes into the `Dockerfile.yjs` COPY list (`src/server/relay-image-files.test.js`).
- Every user-visible string goes through `t()`, with keys in `th` and `en` (`src/client/ui/i18n.js`) and in all 9 locale files (`src/client/ui/locales/*.js`; parity test `i18n-keys.test.js`). UI uses `theme.js` tokens only.
- Crypto constants, copied from spec §5.1/§6.3:
  - PBKDF2-SHA-256, 600,000 iterations, 16-byte salt, 256-bit master.
  - HKDF-SHA-256 info strings `retroroom/kek/v1` and `retroroom/auth/v1`, empty salt.
  - DEK is 256 random bits.
  - verifier = SHA-256(authKey).
  - AES-GCM-256 with a fresh 96-bit IV per message.
  - AAD = `retroroom/e2e/v1|<roomHandle>|<keyEpoch>|<kind>`, with kind ∈ `update`, `snapshot`, `ephemeral`, `blob`.
- The password needs at least **10** characters, a confirmation field, and a required checkbox: "If you forget the password nobody can recover the data, including the server owner."
- Wrong-password limit is 5 per 15 minutes per (IP, room), plus 50 per 15 minutes per room. Exceeding it returns 429 with `retry-after`. Only failures count.
- Only these values may live outside page memory: the lock params (salt, kdf, verifier, wrappedDek, wrapIv, keyEpoch, ownerAccountId) and the ciphertext. password, master, KEK, authKey and DEK stay in page memory only, never in storage, logs or URLs.
- Locked rooms are boards only. Poker (`/p/`) and the Public Wall are unchanged, and normal rooms behave byte-for-byte as before.
- Tests follow AGENTS.md "Tests": no mocking the unit under test, each test must fail when its code is reverted, and relay tests use a real LevelDB in a temp dir.
- Live checks write only under `/Volumes/ssd-fluke/BaseData/retro-board/<task>-<date>/`.

## Deviations from the spec (rulings from code facts, 2026-11-08)

These come from the code scout's findings (file:line in the spec's §2 references are stale; current ranges below).

1. **E2E socket path is `/rooms/<handle>/e2e`** (prod `/yjs/rooms/<handle>/e2e`), not `/yjs/e2e/<handle>`. The room cookie has `Path=/yjs/rooms/<handle>` (`yjs-server.mjs:1054`), so only a sub-path receives it. Encrypted images use `/rooms/<handle>/e2e-blobs[/<id>]` for the same reason.
2. **Room creation keeps `POST /api/rooms`.** The body is `{}` for a normal room (unchanged) or `{ lock }` for a locked one, and the account cookie (`Path=/yjs/api`) arrives with it. `{ lock }` needs a signed-in account whose `entitlementsFor(plan).canCreateLockedRoom` is true: no account → 401, no entitlement → 403.
3. **Session response shapes.**
   - `{code, token}` on a locked room returns `409 { locked: true, salt, kdf }` with no cookie.
   - `{code, token, authKey}` with the right key returns `200 { roomHandle, expiresAt, lock: { wrappedDek, wrapIv, keyEpoch, isOwner } }`. `isOwner` compares the account cookie with `ownerAccountId`.
   - A wrong key returns 403 and counts toward the limit.
   - `authKey` on a normal room returns 400.
   - Renewal re-sends `authKey`. The 409 reveals that a room is locked only to holders of a valid capability, which is acceptable.
4. **The room cookie is bound to the key epoch for locked rooms.** The signed payload is `docName` for normal rooms (unchanged) and `docName|e<keyEpoch>` for locked rooms. A rotation invalidates every old cookie immediately (spec §6.5 says everyone must re-enter), and normal-room cookies stay valid.
5. **Rotation sends a binary body** to `POST /api/rooms/<handle>/lock/rotate`. The JSON body cap (16 KiB max, `relay-config.js:51`) cannot carry a snapshot. Body = `[u32 BE header length][UTF-8 JSON header][snapshot ciphertext]`. Header ≤ 1 MiB; snapshot ≤ `MAX_DOCUMENT_BYTES`.
6. **The relay never validated geometry/schema** (`relay-protocol.js:48-61`). Spec §6.2/§6.7 moves nothing. The client's existing decoders (`storage-bridge.js:299,466-479`) already guard rendering. An update that fails decryption or `Y.applyUpdate` is skipped with a warning.
7. **Timed-vote expiry in E2E rooms runs on the client.** No client path existed: only the admin's Stop button finalizes (`RetroBoard.jsx:3050-3055`). `finalizeRelayVotes` (`src/server/relay-vote-maintenance.js`) already depends only on domain modules plus an injected `Y`. It moves to `src/domain/vote-expiry.js`, with awareness passed in. The relay imports it from there, and in an E2E room each connected client runs it at the deadline. It is idempotent: plan entries are plain sets, rechecked against the live timer inside the transaction.
8. **Images in E2E rooms.**
   - The stored `src` is `/rooms/<handle>/e2e-blobs/<uuid>`. `classifyImportedImageSource` gains kind `e2e`. `normalizeRuntimeImageSource` keeps rejecting it, so a normal room or the Public Wall never renders it.
   - `ImageCard` resolves `e2e` sources with fetch → decrypt → `blob:` URL; `img-src blob:` is already allowed by CSP.
   - Files are named `<handle>.<uuid>.e2e`, so retirement's `<handle>.` prefix delete and the usage scan keep working.
9. **E2E log storage.** The log lives as meta keys of the room doc (`e2e-head`, `e2e-snapshot`, `e2e-u-<seq padded to 16 digits>`), so retirement's `clearDocument` erases it.
   - The registry keeps the plaintext seed update. It holds only `__roomRegistered` and is needed for discovery (`y-leveldb.js:242-245`).
   - The lock record `retro-room-lock-v1` is written with `durableMetaBatch` before the commit marker.
   - Appends use one unsynced batch, like `storeUpdate`. Snapshot+prune and rotate replace-all are each one atomic batch.
10. **Owner routes need the account session.** The `AccountSessions` instance becomes a named value in `yjs-server.mjs`, shared by the auth routes and the new room routes. The lines are paid for by moving `handleCreateRoom`/`handleRoomSession` (`yjs-server.mjs:993-1058`) into `src/server/room-session-routes.js`.
11. **Snapshot policy:** a synced client sends a snapshot after 500 updates or 1 MiB of log since the last snapshot, with a uniform 0-5 s jitter. The room total (snapshot + log) is capped at `MAX_DOCUMENT_BYTES`; an append over it gets `REJECT quota` and makes the client snapshot first.
12. **The password-change UI does not revoke sessions** (spec §5.4). Only rotation does.
13. **PBKDF2 runs on the main thread** because CSP has `worker-src 'none'`. The dialog shows a busy state during derivation.

## Review Focus

1. **Wrong or tampered ciphertext must not break the board.** A frame from another room, an older epoch, a different kind or a flipped bit fails AES-GCM, and the client skips it with a warning. The board stays usable (Task 2 and Task 11 tests).
2. **Concurrent typing in one card on two clients converges.** Undo/redo touch only local edits, and remote applies are never origin `'local'` (Task 11 provider test plus live check).
3. **A page reload asks for the password again.** Nothing secret is in `localStorage`, `sessionStorage`, IndexedDB, the URL or the `rb_local_*` keys (Task 10 test scans storage writes; live check).
4. **Rotation evicts everyone.** Open sockets close with 4001, the next renewal or upgrade with an old cookie returns 401, and an old-epoch frame is rejected by AAD (Tasks 4, 8, 14).
5. **Relay restart mid-session:** the log replays in seq order and a snapshot plus updates after `baseSeq` reproduce the doc exactly (Task 5 restart test, Task 6 relay test).

## File structure

```text
src/domain/
  e2e-envelope.js            frame types, encode/decode, size limits (no crypto)
  room-lock-contract.js      lock params shape + base64url lengths, KDF constants, AAD builder, password min length
  vote-expiry.js             finalizeExpiredVotes(ydoc, Y, awareness, atTime, onInvalid) — moved from relay-vote-maintenance
src/server/
  room-lock.js               lock record read/write (durable), verifier check, wrong-password buckets
  room-session-routes.js     POST /api/rooms (+lock), POST /api/room-session (two-step) — moved out of yjs-server
  room-lock-routes.js        POST /api/rooms/<h>/lock/password, POST /api/rooms/<h>/lock/rotate
  e2e-room-log.js            append / snapshot / replay / replaceAll on room meta keys
  e2e-relay.js               WS server for /rooms/<h>/e2e: gates, fan-out, ephemeral, close-on-rotate
  e2e-blobs.js               upload/read/delete of opaque blobs
src/client/room-lock/
  e2e-crypto.js              WebCrypto derive / wrap / unwrap / encrypt / decrypt
  lock-session.js            in-memory key state for the active locked room
  RoomPasswordScreen.jsx     bootstrap password prompt (+ lock-out countdown)
  CreateLockedRoom.jsx       landing option: password, confirm, checkbox, capability notice
  RoomLockMenu.jsx           owner section in MorePopover: change password, remove everyone
  rotate-room.js             rotation flow (images re-encrypt, snapshot, POST)
  e2e-images.js              encrypt-upload, fetch-decrypt, blob URL cache
src/client/session/
  e2e-provider.js            drop-in provider over the e2e socket
  e2e-vote-expiry.js         runs domain vote-expiry at deadlines in e2e rooms
```

---

### Task 1: Domain contracts — envelope, lock params, vote expiry move

**Files:**
- Create: `src/domain/e2e-envelope.js`, `src/domain/e2e-envelope.test.js`, `src/domain/room-lock-contract.js`, `src/domain/room-lock-contract.test.js`, `src/domain/vote-expiry.js`, `src/domain/vote-expiry.test.js`
- Modify: `src/server/relay-vote-maintenance.js` (re-export or call the domain function), `Dockerfile.yjs`

**Interfaces (produces):**
- `E2E_FRAME` = `{ APPEND: 1, SNAPSHOT: 2, EPHEMERAL: 3, UPDATE: 11, SNAPSHOT_OUT: 12, SYNCED: 13, ACK: 14, EPHEMERAL_OUT: 15, REJECT: 16 }`. `E2E_REJECT` = `{ QUOTA: 1, STALE_SNAPSHOT: 2, RATE: 3, MALFORMED: 4 }`.
- `encodeFrame(type, { seq, ciphertext, code })` → `Uint8Array`. Layout: `[u8 type]`; types with a seq (`SNAPSHOT`, `UPDATE`, `SNAPSHOT_OUT`, `SYNCED`, `ACK`) carry an 8-byte BE unsigned seq (≤ 2^53-1) next; `REJECT` carries `[u8 code]`; the rest of the frame is the ciphertext.
- `decodeClientFrame(bytes, { maxBytes, maxEphemeralBytes })` → `{ type, seq?, ciphertext } | null`. It accepts only types 1-3 and returns null on unknown type, short frame, a seq above `Number.MAX_SAFE_INTEGER`, an empty ciphertext, or more than `maxBytes` (`maxEphemeralBytes` = 64 KiB for EPHEMERAL). `decodeServerFrame` accepts types 11-16 with the same rules.
- `E2E_CIPHERTEXT_OVERHEAD_BYTES = 28` (12 IV + 16 tag).
- `LOCK_KDF = Object.freeze({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 })`, `LOCK_BYTES = { salt: 16, verifier: 32, wrappedDek: 48, wrapIv: 12, authKey: 32 }`, `ROOM_PASSWORD_MIN_LENGTH = 10`.
- `parseLockParams(value)` → frozen `{ salt, kdf, verifier, wrappedDek, wrapIv }` (base64url strings) or `null`. Exact keys only; the KDF must deep-equal `LOCK_KDF`; each field decodes to exactly its `LOCK_BYTES` length.
- `parseAuthKey(value)` → base64url string of 32 bytes or null.
- `e2eAad(roomHandle, keyEpoch, kind)` → `Uint8Array` UTF-8 of `retroroom/e2e/v1|<handle>|<epoch>|<kind>`. It throws on an unknown kind.
- `finalizeExpiredVotes(ydoc, Y, awareness, atTime, onInvalidGeometry)`: same behaviour as `finalizeRelayVotes` today, but awareness is a parameter instead of `ydoc.awareness`.

- [ ] **Step 1: failing tests.**
  - Envelope: round-trip for each type; reject unknown type 0/4/99, a frame at `maxBytes + 1`, EPHEMERAL above 64 KiB, an empty ciphertext, and seq `2^53`.
  - Contract: accept a valid lock; reject an extra key, a missing key, a wrong KDF (iterations 1000), a 15-byte salt, non-base64url characters, and a non-object.
  - AAD: exact bytes for `('A'.repeat(32), 3, 'update')`.
  - Vote expiry: port the existing `relay-vote-maintenance` tests to call the domain function with an explicit awareness.
- [ ] **Step 2: run them and confirm they fail** (module not found). `node --test src/domain/e2e-envelope.test.js src/domain/room-lock-contract.test.js src/domain/vote-expiry.test.js`
- [ ] **Step 3: implement.** Base64url decoding in domain uses `atob`-free pure code (no `Buffer`): a small decoder in `room-lock-contract.js`. Move the vote-expiry body; `relay-vote-maintenance.js` calls `finalizeExpiredVotes(ydoc, Y, ydoc.awareness, …)`.
- [ ] **Step 4: tests pass.** `relay-vote-maintenance` tests and the full `npm test` stay green.
- [ ] **Step 5: commit** `feat(domain): e2e frames, room lock contract, portable vote expiry`.

### Task 2: Browser crypto

**Files:** Create `src/client/room-lock/e2e-crypto.js`, `src/client/room-lock/e2e-crypto.test.js`.

**Interfaces (produces), all async, WebCrypto `globalThis.crypto.subtle` only:**
- `createRoomLock(password, { kdf = LOCK_KDF } = {})` → `{ lock: {salt,kdf,verifier,wrappedDek,wrapIv}, dek: CryptoKey, authKey: string }`. The DEK is non-extractable outside wrap.
- `deriveRoomSecrets(password, lockSaltB64, kdf)` → `{ kek: CryptoKey, authKey: string }`. authKey is the HKDF output as base64url.
- `unwrapRoomKey(kek, wrappedDek, wrapIv)` → `CryptoKey`. It rejects with `RoomKeyError('wrong-password')` on a GCM failure.
- `rewrapRoomKey(dek, newPassword)` → `{ lock, authKey }` (password change; same DEK).
- `createNextRoomKey(newPassword)` → `{ lock, dek, authKey }` (rotation).
- `encryptFrame(dek, aad, plaintext)` → `Uint8Array` `iv||ct`. `decryptFrame(dek, aad, bytes)` → `Uint8Array`; it rejects `RoomKeyError('tampered')` on failure.
- Wrapping the DEK uses AES-GCM under the KEK with AAD `retroroom/kek-wrap/v1`.

- [ ] **Step 1: failing tests.**
  - Round-trip create → derive → unwrap → encrypt/decrypt.
  - A wrong password makes unwrap fail with `wrong-password`.
  - A flipped ciphertext bit, a different room handle, a different epoch or a different kind each fail with `tampered`.
  - Two encryptions of the same plaintext differ (fresh IV).
  - `verifier` equals SHA-256 of the authKey bytes.
  - Rewrap keeps the same DEK: old ciphertext decrypts with the unwrapped new DEK.
  - Lock params pass `parseLockParams`.
  - The tests use the real 600,000 iterations (about 0.3 s each in Node 24); keep derivations to ≤ 6 in the file.
- [ ] **Step 2: run, confirm they fail.** **Step 3: implement.** **Step 4: pass.** **Step 5: commit** `feat(room-lock): browser key derivation and frame encryption`.

### Task 3: Lock record, registry and wrong-password limits (relay)

**Files:** Create `src/server/room-lock.js`, `src/server/room-lock.test.mjs`. Modify `src/server/relay-room-registry.js` and its root test `relay-room-registry.test.mjs`, plus `Dockerfile.yjs`.

**Interfaces:**
- `ROOM_LOCK_META = 'retro-room-lock-v1'`. Record: `{ v: 1, salt, kdf, verifier, wrappedDek, wrapIv, keyEpoch, ownerAccountId, createdAt }`.
- `RoomRegistry.createRoom({ unavailable, initialUpdate, lock = null })`. With `lock` (`{ params, ownerAccountId }`), `persistRoom` writes the lock record via `durableMetaBatch` **before** the registration marker. Rollback removes it.
- `registry.lockFor(docName)` → record | null (in-memory map loaded in `hydrate` and kept by create/update/retire). `registry.isLocked(docName)`.
- `registry.replaceLock(docName, record)` → durable write, then update the map.
- `RoomLockVerifier` (in `room-lock.js`):
  - `constructor({ now, maxBuckets })`
  - `check(ip, docName, record, authKeyB64)` → `'ok' | 'wrong' | { limited: retryAfterSeconds }`
  - Constant-time compare of SHA-256(authKey) with the verifier via `fixedDigestEqual`.
  - Buckets: per `(ip, docName)` burst 5 refilled at 5 per 15 min; per docName burst 50 refilled at 50 per 15 min. Only `'wrong'` consumes a token. It is checked before comparing, so a limited caller cannot test passwords.
  - Exposes `buckets` maps for the existing maintenance sweep.

- [ ] **Step 1: failing tests.**
  - A locked room survives a reopen with an identical record.
  - A crash between lock write and marker leaves no reachable room. Inject a failing marker write; after reopen `registry.has` is false and the lock key is gone.
  - Normal rooms have no lock key.
  - Verifier: right key gives ok; wrong gives wrong; a 6th wrong within 15 min from the same IP gives limited, and the right key is also refused while limited. Another IP is still allowed until the room-wide 50.
  - Time advance refills the buckets.
- [ ] **Steps 2-5:** confirm fail, implement, pass, commit `feat(relay): durable room lock records and wrong-password limits`.

### Task 4: Create and session routes with locks (relay)

**Files:**
- Create `src/server/room-session-routes.js` and `src/server/room-session-routes.test.mjs`.
- Modify `yjs-server.mjs`: move `handleCreateRoom`/`handleRoomSession` out, hoist the `AccountSessions` instance, and wire the new module; the net line count must not grow.
- Modify `src/server/relay-session.js`, `src/server/relay-session.test.js` and `Dockerfile.yjs`.

**Interfaces:**
- `RoomSessions.issue(docName, handle, { keyEpoch = null })`. A non-null `keyEpoch` signs `docName|e<keyEpoch>`. `authenticate(req, { expectedEpoch })` takes the current epoch from the registry for locked rooms.
- `createRoomSessionRoutes(ctx)` → `{ handleCreateRoom(req,res), handleRoomSession(req,res) }`. `ctx` carries the registry, sessions, verifier, `accountSessions`, `accountStore`, buckets, config and `unavailable` getter (same shape as the existing inline handlers use today).
- Create: body `{}` → today's behaviour exactly. Body `{ lock }`:
  - `parseLockParams` fails → 400.
  - No authenticated account → 401.
  - Plan has no `canCreateLockedRoom` → 403.
  - Otherwise `registry.createRoom({ lock: { params, ownerAccountId } })` with `keyEpoch: 0` → 201 `{ code, token }`.
  - Max body 1 KiB (existing default).
- Session exchange:
  - Allowed keys: `{code, token}` or `{code, token, authKey}`; anything else → 400, counted like today.
  - Normal room + authKey → 400.
  - Locked room without authKey → 409 `{ locked: true, salt, kdf }`.
  - With authKey → verifier: `limited` → 429 + `retry-after`; `wrong` → 403; ok → 200 `{ roomHandle, expiresAt, lock: { wrappedDek, wrapIv, keyEpoch, isOwner } }` + cookie bound to the epoch.
- Preflight paths: unchanged plus `/api/rooms/<h>/lock/password` and `/api/rooms/<h>/lock/rotate` (Task 7).

- [ ] **Step 1: failing tests** (spawn or in-process server on a temp DB as in `auth-routes.test.mjs`).
  - Every rule above.
  - The 409 body has no wrappedDek.
  - A cookie from epoch 0 is refused after `replaceLock` sets epoch 1.
  - A normal-room cookie still works (byte-identical issue path).
  - A locked create with a Pro account and with a Free account both succeed; revoked entitlement (patched table in test via an unknown plan) gets 403.
  - A wrong-password 6th try returns 429 with a `retry-after` header.
- [ ] **Step 2: confirm fail.** **Step 3: implement.** `wc -l yjs-server.mjs` ≤ 1814.
- [ ] **Step 4: full `npm test`.** **Step 5: commit** `feat(relay): locked room creation and two-step session exchange`.

### Task 5: Encrypted room log (relay storage)

**Files:** Create `src/server/e2e-room-log.js`, `src/server/e2e-room-log.test.mjs`; modify `Dockerfile.yjs`.

**Interfaces:**
- `E2ERoomLog`
  - `constructor({ ldb, getMetas, maxRoomBytes, now })`
  - `open(docName)` → `{ head, snapshot: {baseSeq, bytes}|null, updates: [{seq, bytes}] }`, read in seq order from the meta keys `e2e-head`, `e2e-snapshot` and `e2e-u-<16-digit seq>`.
- `append(docName, ciphertext)` → `{ seq }`, or throws `{ code: 'E2E_QUOTA' }` when `snapshotBytes + logBytes + new > maxRoomBytes`. One batch writes the update key and the head.
- `snapshot(docName, baseSeq, ciphertext)` → `true`, or throws `{ code: 'E2E_STALE_SNAPSHOT' }` unless `currentBase < baseSeq ≤ head`. One atomic batch puts the snapshot and deletes updates `≤ baseSeq`.
- `replaceAll(docName, ciphertext)` (rotation) → one atomic durable batch: delete every update and the old snapshot, put the snapshot with `baseSeq = head` and keep `head`.
- `sizeOf(docName)` → bytes. Per-doc operations are serialized through one promise chain per docName.

- [ ] **Step 1: failing tests** on a real temp LevelDB:
  - seq is 1, 2, 3.
  - Reopen replays in order (seq 9 before seq 10, which padding guarantees).
  - A snapshot at 2 deletes updates 1-2 and keeps 3.
  - Snapshot 1 after 2 → stale; snapshot above head → stale.
  - Quota reject leaves storage unchanged.
  - Concurrent appends keep unique, contiguous seqs.
  - `replaceAll` leaves exactly one snapshot.
  - Raw LevelDB scan for a known plaintext marker written as ciphertext input finds it only inside the stored ciphertext blob (sanity of opaque storage).
- [ ] **Steps 2-5**, commit `feat(relay): encrypted room log with atomic snapshots`.

### Task 6: E2E socket relay

**Files:** Create `src/server/e2e-relay.js`, `src/server/e2e-relay.test.mjs` (spawns the real relay). Modify `yjs-server.mjs` (route upgrades whose path ends in `/e2e` to the E2E relay; net ≤ 0 lines, paid for by moving `roomTargetFromRequest` into `src/server/relay-room-target.js` with its test) and `Dockerfile.yjs`.

**Interfaces:**
- `roomTargetFromRequest(req, { publicWall, allowLegacy })` → `{ handle, awarenessClientId, supportsQuota, e2e: boolean }`. `/rooms/<h>/e2e` takes no query and is never matched on the Public Wall relay.
- `createE2ERelay(ctx)` → `{ handleUpgrade(req, socket, head, target), closeRoom(docName, code, reason), connectionsFor(docName) }`.
- Upgrade: the same origin check, cookie check (with epoch), shutdown/storage gate, active-room limit, `takeWsUpgradeToken` and `reserveWsConnection` as the y-websocket path. The room must be locked; otherwise 404. It never calls `getYDoc`.
- On connect: send `SNAPSHOT_OUT` if any, then each `UPDATE`, then `SYNCED{head}`.
- Messages:
  - `APPEND` → log append → `ACK{seq}` to the sender and `UPDATE{seq}` to everyone else.
  - `SNAPSHOT` → log snapshot, broadcast `SNAPSHOT_OUT` to others.
  - `EPHEMERAL` → `EPHEMERAL_OUT` to others, not stored.
  - A bad frame → `REJECT MALFORMED` and close 1003.
  - Quota → `REJECT QUOTA`. Stale → `REJECT STALE_SNAPSHOT`.
- Reuse the per-connection ingress and egress traffic buckets and the slow-consumer close from the main path. Activity is touched on connect and on append. Connections count in the same per-room/per-IP maps, so retirement sees them. Session expiry closes with 1008 `'session expired'` as today.
- `closeRoom(docName, 4001, 'key rotated')`.

- [ ] **Step 1: failing tests** against the real relay with a temp DB.
  - Two sockets in a locked room: an append from A reaches B with seq; A gets ACK.
  - A late joiner gets snapshot + tail + SYNCED.
  - EPHEMERAL is forwarded and not stored.
  - An oversized/unknown frame gives REJECT + close.
  - No cookie → 401; a normal room on `/e2e` → 404; a locked room on the y-websocket path → 404.
  - **LevelDB contains no plaintext:** a client encrypts a marker string, and a scan of all DB files for the marker bytes finds 0 hits.
  - Restart the relay: the state replays.
  - The normal-room security and resilience suites stay green.
- [ ] **Steps 2-5**, commit `feat(relay): end-to-end encrypted room socket`.

### Task 7: Encrypted blobs and relay features that skip E2E rooms

**Files:**
- Create `src/server/e2e-blobs.js` and `src/server/e2e-blobs.test.mjs`.
- Modify `src/server/relay-room-routes.js` (routes), `src/server/relay-uploads.js` (accept `.e2e` in stored-name and usage scan; no magic-byte check for e2e), the image migration and decode-scan loops (`yjs-server.mjs` migration loop and `scripts/decode-scan.mjs`: skip docs with `ROOM_LOCK_META`), maintainer snapshot/room access (`src/server/maintainer-snapshot.js`, `maintainer-room-access.js`: e2e rooms listed as `encrypted: true`, content endpoints 404), `src/client/maintainer/*` (show an "Encrypted" badge; i18n keys) and `Dockerfile.yjs`.

**Interfaces:**
- `POST /rooms/<h>/e2e-blobs`: room cookie required; locked rooms only; body ≤ `IMAGE_MAX_BYTES + E2E_CIPHERTEXT_OVERHEAD_BYTES`; same room/global quotas and upload buckets. Writes `<handle>.<uuid>.e2e` with mode 0600 (temp + rename) → 201 `{ id }`.
- `GET /rooms/<h>/e2e-blobs/<uuid>`: room cookie → `application/octet-stream`, `cache-control: private, no-store`.
- `deleteE2EBlobsExcept(handle, keepIds)`.

- [ ] **Step 1: failing tests.**
  - Upload/read round-trip of opaque bytes.
  - A normal room → 404; no cookie → 401; over the size limit → 413.
  - Room usage counts the blob, and the restart scan reconciles it.
  - Retirement deletes the blobs.
  - Decode-scan and image migration skip a locked doc, which has no Y.Doc content.
  - Maintainer listing shows `encrypted: true` and the content endpoints return 404 for it.
- [ ] **Steps 2-5**, commit `feat(relay): encrypted image blobs; maintenance skips encrypted rooms`.

### Task 8: Owner actions — change password and rotate

**Files:** Create `src/server/room-lock-routes.js`, `src/server/room-lock-routes.test.mjs`. Modify `yjs-server.mjs` (wire; net ≤ 0), `src/server/relay-room-routes.js` (preflight paths) and `Dockerfile.yjs`.

**Interfaces:**
- `POST /api/rooms/<handle>/lock/password`, JSON `{ oldAuthKey, lock }`, cap 1 KiB.
  - Requirements: an account cookie whose account id equals `ownerAccountId` (else 403), a locked room (else 404), and `oldAuthKey` passing the verifier with the same limits (wrong → 403, limited → 429).
  - Then `replaceLock` with the new params and the **same** `keyEpoch` → 204.
- `POST /api/rooms/<handle>/lock/rotate`, `content-type: application/octet-stream`, binary body per Deviation 5.
  - Header JSON `{ oldAuthKey, lock, keyEpoch, keepBlobs: [uuid…] }`. `keyEpoch` must equal current + 1; `keepBlobs` holds ≤ 10,000 unique UUIDs.
  - Same owner and verifier checks.
  - Then in order: `log.replaceAll(snapshot)`, `replaceLock` with the new epoch, `e2eRelay.closeRoom(4001)`, and delete blob files not in `keepBlobs` (Task 7 API) → 204.
  - If storage fails before `replaceLock`, nothing is visible to clients and the response is 503.

- [ ] **Step 1: failing tests.**
  - A non-owner gets 403; a wrong oldAuthKey gets 403; a stale epoch gets 409.
  - Password change: the new key opens the session and the old key is refused; existing cookies still work.
  - Rotate: sockets close with 4001; an old cookie → 401 on upgrade and on session renewal with the old authKey → 403; the new authKey → 200 with epoch+1.
  - The log holds exactly the new snapshot.
  - Unkept blobs are deleted and kept blobs stay.
  - An oversized header or body → 413.
- [ ] **Steps 2-5**, commit `feat(relay): owner password change and key rotation`.

### Task 9: Backup verification for E2E rooms

**Files:** Create `scripts/verify-backup-e2e.mjs` and its test. Modify `scripts/verify-production-backup.sh` (call it for the private data dir and uploads dir).

**Interfaces:** `verifyBackupE2ERooms(persistence, uploadsDir)` → `{ rooms }`. For each doc with `ROOM_LOCK_META` it checks:
- the record passes `parseLockParams` (plus `keyEpoch` and `ownerAccountId` shape);
- head ≥ snapshot base;
- update seqs are contiguous from base+1 to head;
- every `<handle>.*.e2e` file is non-empty.

Messages are fixed strings and never print keys.

- [ ] Tests: a valid room verifies; a gap in seqs fails; a bad lock fails; a pre-E2E backup verifies with 0. Commit `feat(backup): verify encrypted room logs`.

### Task 10: Client session — locked exchange and password screen

**Files:**
- Modify `src/client/session/room-session.js` and its test.
- Create `src/client/room-lock/lock-session.js` (+ test) and `src/client/room-lock/RoomPasswordScreen.jsx` (+ test).
- Modify `src/client/app/main.jsx` (`BoardBootstrap`: on `ROOM_SESSION_ERROR.LOCKED` render the password screen, then continue the bootstrap) and i18n (all locales).

**Interfaces:**
- `ROOM_SESSION_ERROR.LOCKED`, `.WRONG_PASSWORD`, `.LOCKED_OUT` (with `retryAfterSeconds`). `RoomSessionError.lock` = `{ salt, kdf }` on LOCKED.
- `establishRoomSession(code, token, { authKey } = {})`. With `authKey` it posts the three keys, stores the authKey in module memory for renewals, and returns the session with `lock`.
- `lock-session.js`: `unlockRoom({ code, token, password, lockHint })` derives the secrets and calls `establishRoomSession` with the authKey. On 200 it unwraps the DEK and stores `{ roomHandle, keyEpoch, dek, isOwner }` in memory. Other exports: `getRoomKey()` → that or null; `clearRoomKey()`.
- Password screen: password field, submit, busy state while deriving. Wrong password shows an inline error; 429 shows a countdown. The text says forgotten passwords cannot be recovered. th/en.

- [ ] **Step 1: failing tests.**
  - The 409 body is parsed into LOCKED with salt/kdf.
  - authKey is sent on exchange and on renewal (fake fetch at the HTTP boundary).
  - 403 maps to WRONG_PASSWORD and 429 to LOCKED_OUT with retry-after.
  - **No storage writes:** wrap `localStorage`/`sessionStorage` setItem in the test and assert nothing containing the password, authKey or a key-derived byte string is written.
  - The screen renders th/en with no raw keys.
- [ ] **Steps 2-5**, commit `feat(room-lock): password prompt and locked session exchange`.

### Task 11: E2E provider and storage-bridge seam

**Files:**
- Create `src/client/session/e2e-provider.js` (+ test) and `src/client/session/e2e-vote-expiry.js` (+ test).
- Modify `src/client/session/storage-bridge.js`: one provider factory picks `E2EProvider` when `getRoomKey()` is set for this room; the rest of the file is unchanged.
- Modify `src/client/session/awareness-transport.js` if needed.

**Interfaces:** `new E2EProvider(wsBaseUrl, roomHandle, ydoc, { key, WebSocketImpl = WebSocket })`, implementing exactly the contract used today:
- `on`/`off` for `'sync'`, `'status'`, `'connection-close'` (`{code, reason}`), `'connection-error'`
- `wsconnected`, `synced`, `connect()`, `disconnect()`, `destroy()`
- `awareness` (y-protocols `Awareness` on `ydoc`), `_awarenessUpdateHandler`
- Reconnect with backoff up to 2500 ms, like y-websocket.

Behaviour:
- A local `ydoc` update (`origin !== provider`) → encrypt(kind `update`) → APPEND, tracked as pending until ACK.
- `synced` becomes true after SYNCED with no pending appends.
- A remote UPDATE/SNAPSHOT → decrypt → `Y.applyUpdate(ydoc, bytes, provider)`. A decrypt or apply failure is skipped, counted, and dispatches `window` event `retroroom:e2e-skipped`.
- Awareness changes for the local client → encode → encrypt(kind `ephemeral`) → EPHEMERAL. Incoming EPHEMERAL_OUT → decrypt → `applyAwarenessUpdate(…, provider)`.
- After SYNCED, when there are ≥ 500 updates or ≥ 1 MiB since the last snapshot, wait a random 0-5 s, re-check, then send SNAPSHOT with `baseSeq = head` seen, ciphertext of `Y.encodeStateAsUpdate(ydoc)`. REJECT QUOTA triggers an immediate snapshot. STALE_SNAPSHOT is ignored.
- Close 4001 → `clearRoomKey()` and `window` event `retroroom:key-rotated`. The board shows "The owner changed the room key; enter the new password" and reloads into the password screen.
- `e2e-vote-expiry.js`: in E2E rooms, set a timer for the earliest zone `voteTimer.endsAt`; at expiry call `finalizeExpiredVotes(ydoc, Y, provider.awareness, now, warn)`. Re-arm on `items` changes.

- [ ] **Step 1: failing tests** with an in-memory fake socket pair and a tiny in-test relay built from `e2e-envelope` (no mock of the provider itself):
  - Two docs converge both ways, including concurrent inserts into one `Y.Text`.
  - Undo on doc A (`Y.UndoManager` with `trackedOrigins: ['local']`) does not undo B's change.
  - Remote applies have `transaction.local === false`.
  - A tampered frame is skipped and the doc stays intact.
  - A snapshot then a tail reproduce the state.
  - The pending→synced transition matches the ACKs.
  - Awareness round-trip.
  - The vote-expiry test finalizes once at the deadline; two clients produce the same doc state.
- [ ] **Steps 2-5**, commit `feat(session): encrypted room provider`.

### Task 12: Images in E2E rooms

**Files:**
- Create `src/client/room-lock/e2e-images.js` (+ test).
- Modify `src/domain/security-boundaries.js` (kind `e2e` in `classifyImportedImageSource` for `/rooms/<32>/e2e-blobs/<uuid>`; `normalizeRuntimeImageSource` still returns null for it), `src/client/transfer/image-upload.js` (`uploadWithRetry` encrypts and posts to e2e-blobs in an E2E room; `readBackupImage` decrypts e2e sources), `src/client/board/ImageCard.jsx` (an `useE2EImageUrl(src)` hook from `e2e-images.js` resolves e2e sources to `blob:` URLs and revokes them on unmount) and their tests.

**Interfaces:**
- `uploadE2EImage(blob)` → `src`.
- `resolveE2EImage(src)` → `Promise<string>` (`blob:` URL, cached per src, revoked when the last user unmounts).
- `readE2EImageBytes(src)` → `Blob` with the original type. The type is stored inside the plaintext as `[u8 typeLen][type][bytes]`.
- Client checks before encrypting: the existing `prepareImageBlob` checks for type, size and dimensions.

- [ ] **Step 1: failing tests.**
  - Classify/normalize rules for e2e paths.
  - An upload encrypts (the bytes sent ≠ the plaintext, and they decrypt back).
  - Resolve gives a `blob:` URL of the right type.
  - Export (`readBackupImage`) yields the decrypted bytes.
  - A normal room never fetches e2e paths.
- [ ] **Steps 2-5**, commit `feat(room-lock): encrypted images`.

### Task 13: Create a locked room (landing)

**Files:**
- Create `src/client/room-lock/CreateLockedRoom.jsx` (+ test).
- Modify `src/client/session/room-session.js` (`createRoom({ lock })`), `src/client/landing/use-create-board.js`, the landing create card (`Landing.jsx`: one prop or child, no logic) and i18n.

**Behaviour:**
- Visible only when `fetchAccount()` is SIGNED_IN with `entitlements.canCreateLockedRoom`. Guests see nothing new.
- Fields: password (≥ 10), confirmation, required checkbox, and the list of what an encrypted room cannot do (spec §6.6, shortened for users):
  - timed votes finish only while someone has the board open;
  - the maintainer console cannot show its content;
  - a forgotten password cannot be recovered.
- On submit: `createRoomLock` → `createRoom({ lock })` → `unlockRoom` with the same password (no second prompt) → navigate to the board.
- 401/403 show a sign-in or plan message.

- [ ] Tests: hidden for guests and for no entitlement; validation messages; the request body has exactly `{ lock }`; th/en render. Commit `feat(landing): create a password-protected encrypted board`.

### Task 14: Owner menu — change password and remove everyone

**Files:** Create `src/client/room-lock/RoomLockMenu.jsx` (+ test) and `src/client/room-lock/rotate-room.js` (+ test). Modify `src/client/chrome/TopBarPopovers.jsx` (`MorePopover` renders `<RoomLockMenu />`, which reads `getRoomKey()` itself, so `RetroBoard.jsx` is untouched) and i18n.

**Behaviour:**
- Shown only when `getRoomKey()?.isOwner`.
- Change password: current password, then new password + confirmation → `rewrapRoomKey` → POST password → success toast.
- Remove everyone:
  - Confirmation dialog: everyone must enter the new password, including you on other devices.
  - Ask for the current and new password.
  - `rotate-room.js`:
    1. For every image item with an e2e src: fetch and decrypt with the old DEK, encrypt with the new DEK, upload, and rewrite `src` in one local transaction.
    2. Encrypt `Y.encodeStateAsUpdate(ydoc)` with the new DEK and epoch+1.
    3. POST rotate with `keepBlobs` = the new ids.
    4. On 204, `clearRoomKey()` and reload into the password screen.
  - On failure the old key stays valid; the newly uploaded blobs are orphans until the next rotation and are counted in usage.

- [ ] Tests:
  - The menu is hidden for non-owners.
  - The change-password request carries no plaintext password.
  - The rotate body parses back into header + snapshot.
  - Image srcs are rewritten to the new ids before the snapshot is taken.
  - Commit `feat(room-lock): owner password change and key rotation`.

### Task 15: Docs and image wiring

**Files:**
- `SECURITY.md`: locked rooms, threat model, the offline-guessing limit (spec §5.5), what the server sees.
- `CONTEXT.md`: the invariant changes from spec §6.7, as corrected by Deviation 6.
- `DEPLOYMENT.md`: backup checks and the `.e2e` files.
- Privacy policy (all locales): encrypted rooms are unreadable by the operator. Update `LEGAL_EFFECTIVE_DATE_ISO`.
- `Dockerfile.yjs` audit.
- `docs/plans/2026-11-08-room-lock-e2e-rollout.md`: prepare-only. Contents: release gate, backup, deploy command per the recorded deploy flow (`docs/plans/2026-11-06-google-sign-in-rollout.md` §7), smoke steps, rollback. Rollback note: older relay code does not know about locked rooms. It serves them as normal rooms whose only content is the seed, so encrypted data is not exposed but is unreachable until re-deploy.

- [ ] Tests that pin doc claims where tests already exist (privacy claim test) stay green. Commit `docs: encrypted rooms security model, invariants and rollout`.

### Task 16: Two-context live check

**Files:** Create `scripts/room-lock-live-check.mjs` (reuse `board-live-helpers.mjs`, `fake-google-oidc.mjs`); add it to the scripts catalog in `scripts/README.md`.

**Scenario** (A = en, signed in; B = th, guest; local relay + fake Google, as in `account-live-check.mjs`):
1. A creates a locked board.
2. B opens the link: password screen; wrong password shows an error; right password opens the board.
3. Edits sync both ways, both type in the same card concurrently and converge, and undo/redo on A syncs.
4. Images: A uploads an image and B sees it.
5. Reload B: asked again.
6. A changes the password; B's session continues.
7. A removes everyone: B sees the key-rotated message and needs the new password.
8. Scan the relay's DB directory and uploads for the plaintext card text and image bytes: 0 hits.
9. Screenshots th/en.

- [ ] Run it, view the screenshots, record the results in `report.json`. Commit `test(live): encrypted room two-browser check`.
