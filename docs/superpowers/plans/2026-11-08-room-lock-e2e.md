# Room password + end-to-end encrypted rooms (phases 2 and 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user can create a board that needs both the link and a password. Its content, presence and images are encrypted in the browser, so the relay and the server owner cannot read them.

**Architecture:**
- **Lock record:** each locked room stores one next to its registry entry: salt, KDF parameters, verifier, wrapped room key, key epoch and owner account.
- **Session exchange:** gains a second step that proves the password with a derived `authKey`.
- **Relay:** an E2E room never gets a `Y.Doc` on the relay. A separate WebSocket path (`/rooms/<handle>/e2e`) carries framed AES-GCM ciphertext. The relay keeps it as an ordered log plus one client-written snapshot, both in the room's LevelDB meta keys.
- **Browser:** an E2E provider holds the real `Y.Doc` and implements the provider contract the board already uses, plus explicit delivery tracking.

**Tech Stack:** WebCrypto (PBKDF2, HKDF, AES-GCM) in the browser, `ws` + y-leveldb 0.2.0 on the relay, Yjs/y-protocols awareness in the client, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-06-room-password-e2e-google-auth-design.md` sections 1, 5, 6, 7, 8 and 10. Phase 1 (sign-in, accounts, entitlements) is shipped; its conventions are in `docs/superpowers/plans/2026-11-06-google-sign-in-accounts.md`.

**Revision 2 (2026-11-08):** this revision folds in the Codex plan review (16 findings). Each change is marked `[R<n>]` where it lands.

**Revision 3:** this revision folds in the Codex re-review. Each change is marked `[S<n>]`.

## Global Constraints

- `RetroBoard.jsx` is capped at **3993** lines and `yjs-server.mjs` at **1814** (`src/rule-ratchets.test.js`). Ceilings only go down: each new line of wiring is paid for by moving existing logic out into a module in the same task.
- Layers: client and server import only their own layer plus `src/domain` (`src/architecture.test.js`). Domain modules use no `node:` imports and no `window`/`document`/`navigator`.
- Every new server or domain module goes in the `Dockerfile.yjs` COPY list (`src/server/relay-image-files.test.js`).
- Every user-visible string goes through `t()`. Keys go in `th` and `en` (`src/client/ui/i18n.js`) and in all 9 locale files under `src/client/ui/locales/` (parity test `i18n-keys.test.js`). This applies to every UI task below. UI uses `theme.js` tokens only.
- Crypto constants (spec §5.1/§6.3):
  - PBKDF2-SHA-256, 600,000 iterations, 16-byte salt, 256-bit master.
  - HKDF-SHA-256 info strings `retroroom/kek/v1` and `retroroom/auth/v1`, empty salt.
  - DEK: 256 random bits. verifier = SHA-256(authKey).
  - AES-GCM-256 with a fresh 96-bit IV per message.
  - AAD = `retroroom/e2e/v1|<roomHandle>|<keyEpoch>|<kind>[|<binding>]`. Kinds: `update`, `ephemeral`; `snapshot` binds its `baseSeq`; `blob` binds its blob id `[R14]`.
- Password: at least **10** characters, a confirmation field, and a required checkbox reading "If you forget the password nobody can recover the data, including the server owner". Rotation also requires the new password to differ from the current one `[R14]`.
- Wrong-password limit is a **strict rolling window** `[R13]`: at most 5 failures in any 15 minutes per (IP, room), and at most 50 per room. A request over the limit gets 429 with `retry-after` = seconds until the oldest counted failure leaves the window. Only failures count.
- Only the lock params (salt, kdf, verifier, wrappedDek, wrapIv, keyEpoch, ownerAccountId) and ciphertext ever leave page memory. The one exception is `authKey`, which is sent over TLS in authentication request bodies only `[S-low]`. Password, master, KEK, authKey and DEK never go to storage, logs or URLs.
- Locked rooms are boards only. Poker (`/p/`) and the Public Wall are unchanged, and normal rooms behave byte-for-byte as before.
- **Locked rooms never send plaintext image bytes** `[R1]`. Every upload path (paste, file, drop, drawing, import) already goes through `storage.uploadImage` (`storage-bridge.js:996`), so encryption happens there. The relay also refuses the plaintext `/upload` route for locked rooms.
- Tests follow AGENTS.md "Tests": never mock the unit under test, each test must fail when its code is reverted, and relay tests use a real LevelDB in a temp dir.
- Live checks write only under `/Volumes/ssd-fluke/BaseData/retro-board/<task>-<date>/`.

## Deviations from the spec (rulings from code facts, 2026-11-08)

1. **E2E socket path is `/rooms/<handle>/e2e`** (prod `/yjs/rooms/<handle>/e2e`), not `/yjs/e2e/<handle>`. The room cookie has `Path=/yjs/rooms/<handle>` (`yjs-server.mjs:1054`), so only a sub-path receives it. Encrypted images use `/rooms/<handle>/e2e-blobs[/<id>]` for the same reason.
2. **Room creation keeps `POST /api/rooms`.** The body is `{}` (normal room, unchanged) or `{ lock }`. The account cookie (`Path=/yjs/api`) arrives with it. `{ lock }` needs a signed-in account with `entitlementsFor(plan).canCreateLockedRoom`: no account → 401, no entitlement → 403.
3. **Session shapes.**
   - `{code, token}` on a locked room → `409 { locked: true, salt, kdf }` with no cookie.
   - `{code, token, authKey}` with the right key → `200 { roomHandle, expiresAt, lock: { wrappedDek, wrapIv, keyEpoch, isOwner } }`.
   - Wrong key → 403, counted against the limit.
   - `authKey` on a normal room → 400.
   - Renewal re-sends `authKey`. The 409 tells a capability holder the room is locked, which is acceptable.
4. **The room cookie is bound to the key epoch for locked rooms.** The signed payload stays `docName` for normal rooms and becomes `docName|e<keyEpoch>` for locked ones. A rotation therefore invalidates every old cookie at once.
5. **Rotation is a two-step barrier with a binary commit** `[R2][R3]`. Every lock mutation (password change, rotate begin/commit/abort) runs in the room's single op chain `[S4]`. Inside that chain the relay re-verifies `oldAuthKey` against the **current** record and checks `expectedRevision`, the `lockRevision` counter stored in the record and bumped by every mutation. A request authorized against an older lock therefore fails with 409. A password change is refused with 409 while a rotation freeze is active.
   - `rotate/begin` freezes appends for at most 120 s and returns `{ head, rotationId, lockRevision }`. When the freeze ends without a commit (abort or TTL), the relay sends `RESUMED` to every socket. Clients then re-send pending appends that were rejected as FROZEN `[S1]`.
   - `rotate/commit` sends a binary body, because the JSON cap (16 KiB, `relay-config.js:51`) cannot carry a snapshot: `[u32 BE header length][UTF-8 JSON header][snapshot ciphertext]`. Header ≤ 1 MiB; snapshot ≤ `MAX_DOCUMENT_BYTES`.
   - The commit writes snapshot, log prune, blob inventory and the new lock record in **one** durable LevelDB batch, and only then publishes them in memory.
6. **The relay never validated geometry/schema** (`relay-protocol.js:48-61`), so spec §6.2/§6.7 moves nothing. The client's existing decoders guard rendering. An update that fails decryption or `Y.applyUpdate` is skipped with a warning, and a skipped seq blocks this client from writing snapshots (see 11).
7. **Timed-vote expiry in E2E rooms runs on clients** `[R15]`. No client path exists today: only the admin's Stop button finalizes (`RetroBoard.jsx:3050-3055`).
   - `finalizeRelayVotes` depends only on domain modules plus an injected `Y`. It moves to `src/domain/vote-expiry.js` with awareness as a parameter.
   - In an E2E room, only a client that is fully synced (contiguous applied seq == head) acts.
   - A client advertises `e2eSynced: true` in its awareness state only while its contiguous applied seq equals the last known head `[S-15]`. The **elected finalizer** is the client with the lowest awareness clientID among those advertising it. It finalizes at the deadline. Others wait a 10 s grace, then finalize only if the same timer generation (`voteTimer.endsAt` + `startedAt`) is still live.
   - Application rechecks that generation inside the transaction. Two clients with different partial views can still both finalize; the CRDT keeps the last writer per key. This residual is documented in SECURITY.md/CONTEXT.md.
8. **Images in E2E rooms** `[R1][R10][S3][S5]`.
   - The client generates the blob id (a UUID) and sends it in the header `x-blob-id`; `roomFetch` paths carry no query. The relay publishes the file with `fs.link(temp, final)`, so a duplicate id fails with 409 instead of overwriting, then unlinks the temp.
   - The inventory entry is `{ id, bytes, epoch, stagedFor }`. `stagedFor` is a rotationId for copies uploaded during a rotation. An abort or freeze expiry deletes that rotation's staged blobs and their entries.
   - Rotation does **not** delete old-epoch blobs at once. They stay as old-key ciphertext for a 24 h grace, readable only with a current-epoch cookie. After re-unlock, a client that still holds the previous DEK runs **image repair**: any image item whose src points to an old-epoch blob is fetched, decrypted with the old key, re-encrypted with the new key under a new id, uploaded, and its src rewritten in a local transaction. The relay deletes old-epoch blobs after the grace. An image nobody repaired by then becomes a broken-image placeholder (documented).
   - After re-unlock following a rotation, the page clears its undo/redo stacks so they cannot resurrect old references.
   - The stored `src` is `/rooms/<handle>/e2e-blobs/<uuid>`. `classifyImportedImageSource` gains kind `e2e`, checked before the data-URL branch.
   - A new room-aware resolver, `resolveRoomImageSource(src, session)`, accepts `e2e` only for the active locked room. `normalizeRuntimeImageSource` keeps rejecting it everywhere else.
   - `ImageCard` resolves `e2e` sources by fetch → decrypt → `blob:` URL; CSP `img-src blob:` already allows it.
   - Files are named `<handle>.<uuid>.e2e`. The shared matchers `isStoredImageFilename`/`roomHandleOfImageFile` (`relay-uploads.js:28,43`) learn `.e2e`, so retirement and usage scans keep working.
9. **E2E log storage.**
   - The log is meta keys of the room doc: `e2e-head`, `e2e-snapshot` = `{ baseSeq, bytes }`, `e2e-u-<seq padded to 16 digits>`, `e2e-blobs` = inventory `[{ id, bytes }]`, plus the lock record `retro-room-lock-v1`. Retirement's `clearDocument` erases them all.
   - The registry keeps the plaintext seed update. It holds only `__roomRegistered` and is needed for discovery (`y-leveldb.js:242-245`).
   - Appends are one unsynced batch, like `storeUpdate`. Snapshot+prune is one atomic batch. Rotate commit is one durable batch.
10. **Owner routes need the account session.** The `AccountSessions` instance becomes a named value in `yjs-server.mjs`, shared by the auth routes and the new room routes. The lines are paid for by moving `handleCreateRoom`/`handleRoomSession` (`yjs-server.mjs:993-1058`) into `src/server/room-session-routes.js`.
11. **Snapshot policy** `[R6][S2]`.
    - The provider applies incoming frames strictly in seq order through one queue, and tracks `appliedSeq` = the highest seq with every seq ≤ it applied.
    - An ACK{seq} for this client's own append marks that seq as covered, because its content is already in the local doc. ACKs and UPDATEs feed the same ordered coverage tracker, and a duplicate resend's ACK covers its new seq too.
    - Once any seq fails to decrypt or apply, this client never snapshots again in this session.
    - A snapshot is `{ baseSeq: appliedSeq, state }`, captured synchronously in the same task.
    - It is sent after 500 updates or 1 MiB of log since the last snapshot, after a uniform 0-5 s jitter and a re-check.
    - The room total (snapshot + log) is capped at `MAX_DOCUMENT_BYTES`. An append over the cap gets `REJECT QUOTA` and makes an eligible client snapshot first.
12. **Password change does not revoke sessions** (spec §5.4); only rotation does. Every page renewing with an old authKey gets 403, which opens the in-page re-unlock dialog without losing pending edits `[R11]`. Re-unlock first re-runs the exchange without `authKey` to get the **current** salt/kdf from the 409, then derives `[S-11]`. After its own password change, the initiating page replaces both `authKey` and its cached `lock`.
13. **PBKDF2 runs via async WebCrypto in the page** (CSP `worker-src 'none'`). The dialog shows a busy state while it derives.
14. **Creating a locked room navigates with a full page load** (`router.js:98`) `[R12]`. In-memory secrets cannot survive that, so the creator types the password once more on the board's password screen. Secrets are never persisted to avoid this.
15. **Threat-model limits, disclosed rather than solved** `[R14]`:
    - A malicious relay can drop, delay or reorder frames.
    - It can replay ciphertext within an epoch, and serve an older snapshot or blob of the same epoch.
    - An authorized member can write a snapshot that prunes the log.
    - Revoked members keep whatever plaintext and keys they already had.
    - The security of the whole scheme depends on the JavaScript delivered by the operator.

## Review Focus

1. **No plaintext leaves the browser in a locked room.** Card text, presence and image bytes, including paste, drawing and import, never appear in requests or in LevelDB/uploads. Tests scan sent bodies (Task 12) and the relay's files (Tasks 6, 16).
2. **Acknowledged edits survive everything.** That covers concurrent edits during rotation `[R3]`, reconnects and lost ACKs `[R7]`, relay restart, snapshot pruning `[R6]`, and a failed rotation `[R4]`. The board is never left with sources it cannot open.
3. **Wrong or tampered ciphertext cannot break the board.** A frame from another room, an older epoch, a different kind or binding, or with a flipped bit fails AES-GCM, is skipped, and the board stays usable.
4. **Rotation evicts everyone and is atomic.** Open sockets close with 4001, old cookies get 401, and a crash at any point of the commit leaves either the old state or the new one `[R2]`.
5. **Reload asks for the password again, and nothing secret is persisted.** Password change and rotation re-unlock in the page without losing pending edits.

## File structure

```text
src/domain/
  e2e-envelope.js            frame types, encode/decode, size limits (no crypto)
  room-lock-contract.js      lock params + base64url lengths, KDF constants, AAD builder, password rules
  vote-expiry.js             finalizeExpiredVotes(ydoc, Y, awareness, atTime, onInvalid) — moved
src/server/
  room-lock.js               lock record codec, verifier check, rolling-window failure limits
  room-session-routes.js     POST /api/rooms (+lock), POST /api/room-session (two-step) — moved out of yjs-server
  room-lock-routes.js        POST /api/rooms/<h>/lock/password | rotate/begin | rotate/commit
  e2e-room-log.js            append / snapshot / replay / freeze / rotate-commit on room meta keys
  e2e-relay.js               WS server for /rooms/<h>/e2e (shared gates, accounting, drain)
  e2e-blobs.js               upload/read/inventory of opaque blobs
  relay-room-target.js       roomTargetFromRequest — moved out of yjs-server
src/client/room-lock/
  e2e-crypto.js              WebCrypto derive / wrap / rewrap / encrypt / decrypt
  lock-session.js            in-memory key state + re-unlock for the active locked room
  RoomPasswordScreen.jsx     bootstrap password prompt (+ lock-out countdown)
  ReunlockDialog.jsx         in-board prompt after rotation / password change
  CreateLockedRoom.jsx       landing option
  RoomLockMenu.jsx           owner section in MorePopover
  rotate-room.js             rotation flow on a detached document
  e2e-images.js              encrypt/decrypt blobs, blob URL cache
src/client/session/
  e2e-provider.js            provider over the e2e socket with delivery tracking
  e2e-vote-expiry.js         elected finalizer at deadlines in e2e rooms
```

---

### Task 1: Domain contracts — envelope, lock params, vote expiry move

**Files:**
- Create: `src/domain/e2e-envelope.js` (+ `.test.js`), `src/domain/room-lock-contract.js` (+ `.test.js`), `src/domain/vote-expiry.js` (+ `.test.js`).
- Modify: `src/server/relay-vote-maintenance.js` (call the domain function), `Dockerfile.yjs`.

**Interfaces (produces):**
- `E2E_FRAME` = `{ APPEND: 1, SNAPSHOT: 2, EPHEMERAL: 3, UPDATE: 11, SNAPSHOT_OUT: 12, SYNCED: 13, ACK: 14, EPHEMERAL_OUT: 15, REJECT: 16 }`.
- `E2E_REJECT` = `{ QUOTA: 1, STALE_SNAPSHOT: 2, RATE: 3, MALFORMED: 4, FROZEN: 5 }`.
- `encodeFrame(type, { seq, ciphertext, code, clientRef })` → `Uint8Array`. Layout:
  - `[u8 type]`
  - `APPEND`: `[u32 BE clientRef][ciphertext]`. clientRef is the client's own counter, echoed in ACK `[R7]`.
  - `SNAPSHOT`, `UPDATE`, `SNAPSHOT_OUT`, `SYNCED`: `[8-byte BE seq ≤ 2^53-1]` + ciphertext (none for SYNCED).
  - `ACK`: `[8-byte seq][u32 clientRef]`.
  - `REJECT`: `[u8 code][u32 clientRef]`.
  - `EPHEMERAL`/`EPHEMERAL_OUT`: ciphertext only.
- `decodeClientFrame(bytes, { maxBytes, maxEphemeralBytes })` accepts types 1-3; `decodeServerFrame(bytes, { maxBytes })` accepts 11-16. Both return `null` on: unknown type, short frame, seq above `Number.MAX_SAFE_INTEGER`, empty ciphertext where one is required, or more than `maxBytes` (`maxEphemeralBytes` = 64 KiB).
- `E2E_CIPHERTEXT_OVERHEAD_BYTES = 28`.
- Lock constants:
  - `LOCK_KDF = Object.freeze({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 })`
  - `LOCK_BYTES = { salt: 16, verifier: 32, wrappedDek: 48, wrapIv: 12, authKey: 32 }`
  - `ROOM_PASSWORD_MIN_LENGTH = 10`
- `parseLockParams(value)` → frozen `{ salt, kdf, verifier, wrappedDek, wrapIv }` or `null`. Exact keys, KDF deep-equal to `LOCK_KDF`, exact decoded lengths, base64url only. `parseAuthKey(value)` works the same way.
- `e2eAad(roomHandle, keyEpoch, kind, binding)` → `Uint8Array`. `binding` is required for `snapshot` (baseSeq) and `blob` (id) and forbidden otherwise; it throws on misuse.
- `finalizeExpiredVotes(ydoc, Y, awareness, atTime, onInvalidGeometry, { timerGeneration } = {})`. This is today's `finalizeRelayVotes`, with two changes: awareness is a parameter, and the optional generation check skips a zone whose live `voteTimer` no longer matches.

- [ ] **Step 1: failing tests.**
  - Envelope: round-trip every type; reject types 0/4/99, a frame at `maxBytes + 1`, EPHEMERAL above 64 KiB, an empty ciphertext and seq `2^53`.
  - Contract: valid lock passes; extra/missing key, wrong KDF, 15-byte salt, non-base64url and non-object fail.
  - AAD: exact bytes for `('A'.repeat(32), 3, 'snapshot', 7)`; a missing or extra binding throws.
  - Vote expiry: port the `relay-vote-maintenance` tests and add a stale-generation case.
- [ ] **Step 2: confirm they fail.** `node --test src/domain/e2e-envelope.test.js src/domain/room-lock-contract.test.js src/domain/vote-expiry.test.js`
- [ ] **Step 3: implement.** Domain base64url uses no `Buffer`.
- [ ] **Step 4: full `npm test` is green.**
- [ ] **Step 5: commit** `feat(domain): e2e frames, room lock contract, portable vote expiry`.

### Task 2: Browser crypto

**Files:** Create `src/client/room-lock/e2e-crypto.js` (+ test).

**Interfaces** (async, `globalThis.crypto.subtle` only; operational DEKs are non-extractable) `[R5]`:
- `createRoomLock(password)` → `{ lock, dek, authKey }`.
- `deriveRoomSecrets(password, saltB64, kdf)` → `{ kek, authKey }`.
- `unwrapRoomKey(kek, wrappedDek, wrapIv)` → non-extractable `dek`. Rejects `RoomKeyError('wrong-password')`.
- `rewrapRoomLock({ currentPassword, lock, newPassword })` → `{ lock: newLock, authKey: newAuthKey, oldAuthKey }`. It derives the old KEK, unwraps the DEK as **extractable inside this function only**, wraps it under the new KEK with a new salt, and drops the extractable copy. The DEK value does not change.
- `createNextRoomKey(newPassword)` → `{ lock, dek, authKey }` (rotation).
- `encryptFrame(dek, aad, plaintext)` → `iv||ct`. `decryptFrame(dek, aad, bytes)` → plaintext, or rejects `RoomKeyError('tampered')`.
- DEK wrap uses AES-GCM under the KEK with AAD `retroroom/kek-wrap/v1`.

- [ ] **Step 1: failing tests.**
  - Round-trip.
  - Wrong password fails with `wrong-password`.
  - Tampering with room, epoch, kind, binding or a single bit fails with `tampered`.
  - IVs are fresh.
  - The verifier equals SHA-256(authKey).
  - Rewrap keeps the DEK: old ciphertext decrypts after unwrap with the new password.
  - The operational DEK cannot be exported (`exportKey` rejects).
  - Uses the real 600,000 iterations, with ≤ 8 derivations in the file.
- [ ] **Steps 2-5.** Commit `feat(room-lock): browser key derivation and frame encryption`.

### Task 3: Lock record, registry and wrong-password limits (relay)

**Files:** Create `src/server/room-lock.js` (+ `.test.mjs`). Modify `src/server/relay-room-registry.js` + `relay-room-registry.test.mjs`, and `Dockerfile.yjs`.

**Interfaces:**
- `ROOM_LOCK_META = 'retro-room-lock-v1'`, record `{ v: 1, salt, kdf, verifier, wrappedDek, wrapIv, keyEpoch, ownerAccountId, createdAt }`. `encodeLockRecord`/`decodeLockRecord` (strict).
- `RoomRegistry.createRoom({ unavailable, initialUpdate, lock = null })`. With a lock, `persistRoom` writes the record through `durableMetaBatch` **before** the registration marker; rollback removes it.
- `registry.lockFor(docName)` → record | null. It reads an in-memory map that `hydrate` loads and create/rotate/retire keep current. `registry.isLocked(docName)`. `registry.publishLock(docName, record)` updates memory only; the durable write belongs to the caller's batch (Task 8).
- `RoomLockVerifier`:
  - `constructor({ now, maxKeys })`.
  - `check(ip, docName, record, authKeyB64)` → `'ok' | 'wrong' | { limited: retryAfterSeconds }`.
  - Strict rolling window `[R13]`: a timestamp array per `(ip, docName)` (≤ 5 kept) and per docName (≤ 50 kept), pruned to the last 15 min. The limit is checked before comparing.
  - Comparison: constant-time `fixedDigestEqual(sha256(authKey), verifier)`.
  - Bounded maps `[S-13]`: the sweep removes keys whose timestamps have all expired. When a map is full of live keys, a **new** key is answered `limited` (fail closed) and never evicts a live one. Default `maxKeys` = 10,000.

- [ ] **Step 1: failing tests.**
  - A locked room survives reopen.
  - A failing marker write after the lock write leaves no reachable room and no lock key.
  - Normal rooms have no lock key.
  - Verifier: ok/wrong; the 6th failure at t+14:59 is limited and the right key is refused too; at t+15:00 after the first failure one attempt is allowed again; `retry-after` is exact.
  - Another IP is still allowed until the room-wide 50.
  - A full map refuses new keys and keeps the existing live ones (no reset of a tracked allowance); the sweep frees expired keys.
- [ ] **Steps 2-5.** Commit `feat(relay): durable room lock records and wrong-password limits`.

### Task 4: Create and session routes with locks (relay)

**Files:**
- Create `src/server/room-session-routes.js` (+ `.test.mjs`).
- Modify:
  - `yjs-server.mjs`: move the two handlers out and hoist `AccountSessions`; net ≤ 0 lines.
  - `src/server/relay-session.js` (+ test).
  - `src/server/relay-room-routes.js`: preflight/CORS for every new API path, credentialed, allowed origins only `[R16]`.
  - `Dockerfile.yjs`.

**Interfaces:**
- `RoomSessions.issue(docName, handle, { keyEpoch = null })`. The epoch is signed for locked rooms. `authenticate(req, { expectedEpoch })`.
- `createRoomSessionRoutes(ctx)` → `{ handleCreateRoom, handleRoomSession }`. `ctx` carries `registry`, `sessions`, `verifier`, `accountSessions`, `accountStore`, `buckets`, `config` and the `unavailable` getter.
- Create:
  - `{}` behaves as today.
  - `{ lock }`: bad params → 400; no account → 401; no entitlement → 403; otherwise 201 `{ code, token }` (epoch 0).
- Session: per Deviation 3. A cookie is bound to the current epoch; `limited` → 429 with `retry-after`.

- [ ] **Step 1: failing tests** (real temp DB, in-process server).
  - Every rule above.
  - The 409 body has no wrappedDek.
  - An epoch-0 cookie is refused after the epoch becomes 1.
  - A normal-room cookie is byte-identical to before.
  - Free and Pro can create; an unknown plan → 403.
  - The 6th failure → 429.
  - A browser-style `OPTIONS` from an allowed origin → 204 with credentials; a foreign origin → 403.
- [ ] **Steps 2-5.** `wc -l yjs-server.mjs` ≤ 1814. Commit `feat(relay): locked room creation and two-step session exchange`.

### Task 5: Encrypted room log (relay storage)

**Files:** Create `src/server/e2e-room-log.js` (+ `.test.mjs`); `Dockerfile.yjs`.

**Interfaces:** `E2ERoomLog`, `constructor({ ldb, getMetas, maxRoomBytes, reserveStore, now })`. Every operation per docName runs through one promise chain.
- `open(docName)` → `{ head, snapshot, updates, blobs }`, in seq order.
- `subscribeAfterReplay(docName, onEntry)` `[R6]`: reads the state and registers the live listener inside the same chain step, so a joiner can't miss an append that lands between replay and subscribe.
- `append(docName, ciphertext)` → `{ seq }`. Throws `E2E_QUOTA` when the room total would exceed `maxRoomBytes`, or `E2E_FROZEN` during a rotation freeze. Takes a `reserveStore` reservation for the write `[R8]`.
- Bounded admission `[S-8]`: at most 256 queued ops per room (above that → `E2E_BUSY`, sent to the socket as REJECT RATE). Snapshot, rotation commit and blob inventory writes also take `reserveStore` reservations and respect `hasCapacity()`.
- The snapshot meta value is `{ baseSeq, bytes, sha256 }`. `open` and backup verify recompute the digest, so a truncated snapshot is detected `[S-9]`.
- `snapshot(docName, baseSeq, ciphertext)` → requires `currentBase < baseSeq ≤ head`, else `E2E_STALE_SNAPSHOT`. One atomic batch.
- `freeze(docName, ttlMs, { expectedRevision })` → `{ head, rotationId, lockRevision }`. The freeze is released by commit, by `release(rotationId)`, or when the TTL expires. Release calls an `onResume(docName)` hook (the relay sends RESUMED) and deletes the blobs staged for that rotation.
- `mutateLock(docName, { verify, next })`: the serialized password-change path. It re-verifies inside the chain and bumps `lockRevision` `[S4]`.
- `commitRotation(docName, { rotationId, expectedHead, snapshot, lockRecord, blobInventory })` `[R2][R3]`:
  - Requires an active matching freeze and `head === expectedHead`; otherwise `E2E_ROTATION_STALE`.
  - Writes in **one durable batch**: delete all updates, put the snapshot (`baseSeq = head`), put the lock record and the inventory. Releases the freeze.
- `addBlob(docName, { id, bytes, epoch, stagedFor })` / `blobs(docName)` / `expireOldEpochBlobs(docName, now)`: inventory updates for Task 7. Old-epoch entries are removed after the 24 h grace.
- Startup reconciliation `[S-9]`: an `.e2e` file with no inventory entry that is older than 1 h (left by a crash between file write and inventory write, or after a delete) is removed and counted in a log line. File-first, inventory-second ordering means an inventory entry never lacks its file.
- `sizeOf(docName)`.

- [ ] **Step 1: failing tests** on a real temp LevelDB.
  - seq 1, 2, 3; reopen keeps the order (9 before 10).
  - Snapshot prunes; a stale snapshot fails; quota failure leaves storage untouched.
  - Concurrent appends get contiguous seqs.
  - A subscriber that joins while appends run sees every seq exactly once.
  - Appends during a freeze → `E2E_FROZEN`; the freeze expires on its TTL.
  - A commit with the wrong head or rotationId → stale.
  - Inject a batch failure into the commit: reopen shows the old lock and log intact.
  - After commit, exactly one snapshot plus the new lock record are stored.
  - A password change queued behind a commit fails its re-verification (409) and leaves the new lock intact.
  - The 257th queued op → BUSY.
  - Release sends RESUMED through the hook and deletes the staged blobs.
  - A truncated snapshot fails `open`.
- [ ] **Steps 2-5.** Commit `feat(relay): encrypted room log with atomic snapshots and rotation`.

### Task 6: E2E socket relay

**Files:**
- Create `src/server/e2e-relay.js` (+ `.test.mjs`, which spawns the real relay) and `src/server/relay-room-target.js` (+ test).
- Modify `yjs-server.mjs` (route `/e2e` upgrades; share counters; net ≤ 0) and `Dockerfile.yjs`.

**Interfaces:**
- `roomTargetFromRequest(req, { publicWall, allowLegacy })` → `{ handle, awarenessClientId, supportsQuota, e2e }`. The `/rooms/<h>/e2e` form has no query and is never valid on the Public Wall relay.
- `createE2ERelay(ctx)` → `{ handleUpgrade, closeRoom(docName, code, reason), connectionsFor(docName), activeRooms(), drain() }`.

Shared admission and accounting `[R8]`:
- Same gates as the main path: origin, cookie+epoch, the shutdown/storage-failure gate, `takeWsUpgradeToken`, `reserveWsConnection`.
- The active-room limit counts `docs.size + e2eRelay.activeRooms()`.
- Per-connection ingress/egress buckets and slow-consumer close as on the main path.
- A storage failure goes through the existing fatal storage path.
- On SIGTERM, `drain()` closes E2E sockets and awaits the log chains before exit.
- Activity is touched on connect and on append.

Protocol:
- Join via `subscribeAfterReplay`: SNAPSHOT_OUT?, UPDATEs, SYNCED{head}.
- `APPEND` → ACK{seq, clientRef} to the sender, UPDATE to the others. Quota/frozen/busy → `REJECT` with the clientRef.
- Freeze release (abort/TTL) → RESUMED to every socket of the room `[S1]`.
- `SNAPSHOT` → stored + SNAPSHOT_OUT to the others.
- `EPHEMERAL` → forwarded only.
- Malformed → REJECT + close 1003.
- Session expiry closes 1008 `'session expired'`.

- [ ] **Step 1: failing tests** (real relay, temp DB).
  - Fan-out and ACK correlation.
  - A late joiner gets snapshot + tail.
  - A joiner during a stream of appends misses none.
  - Ephemeral messages are not stored.
  - Malformed → close.
  - No cookie → 401; a normal room on `/e2e` → 404; a locked room on the y-websocket path → 404.
  - Normal + E2E rooms share the active-room cap.
  - SIGTERM under writes exits after flushing; a reopen has every ACKed seq.
  - **LevelDB contains no plaintext** (a known marker, encrypted by a test client, shows 0 hits in a scan of all DB files).
  - Restart replays.
  - The existing security and resilience suites stay green.
- [ ] **Steps 2-5.** Commit `feat(relay): end-to-end encrypted room socket`.

### Task 7: Encrypted blobs, plaintext upload refusal, and maintenance that skips E2E rooms

**Files:**
- Create `src/server/e2e-blobs.js` (+ `.test.mjs`).
- Modify:
  - `src/server/relay-room-routes.js`: routes + CORS/preflight for octet-stream POST and credentialed GET `[R16]`; `/upload` → 403 for locked rooms `[R1]`.
  - `src/server/relay-uploads.js`: `isStoredImageFilename`/`roomHandleOfImageFile` accept `.e2e`; no magic-byte check for `.e2e`.
  - Image migration and `scripts/decode-scan.mjs`: skip docs that have `ROOM_LOCK_META`.
  - Maintainer snapshot/room access: E2E rooms listed with `encrypted: true`; content endpoints return 404.
  - `src/client/maintainer/*`: "Encrypted" badge, all locales.
  - `Dockerfile.yjs`.

**Interfaces:**
- `POST /rooms/<h>/e2e-blobs` with headers `x-blob-id: <uuid v4>` and optional `x-blob-stage: <rotationId>` (accepted only while that rotation is active) `[S5]`.
  - Room cookie with the current epoch; locked rooms only; body ≤ `IMAGE_MAX_BYTES + 256 + E2E_CIPHERTEXT_OVERHEAD_BYTES`; same quotas and buckets.
  - Writes a temp file (0600), then `fs.link` to `<handle>.<uuid>.e2e`: an existing id → 409, no overwrite. Unlinks the temp, **then** `log.addBlob` `[R9]` → 201 `{ id }`.
  - CORS preflight allows these two headers.
- `GET /rooms/<h>/e2e-blobs/<uuid>`: room cookie → octet-stream, `cache-control: private, no-store`.
- `deleteE2EBlobsExcept(handle, keepIds)`: used by the rotation commit after the durable batch.

- [ ] **Step 1: failing tests.**
  - Round-trip; normal room → 404; no cookie or old epoch → 401; too large → 413.
  - A duplicate id → 409 and the original bytes are unchanged; two concurrent uploads with the same id → exactly one 201.
  - Upload through the real client `roomFetch` path in the relay test helper (header-carried id).
  - `/upload` on a locked room → 403.
  - The inventory lists the blob; usage counts it; the restart scan reconciles it; retirement deletes it.
  - Fetch-style CORS preflight from an allowed origin succeeds; a foreign origin → 403.
  - Decode-scan and migration skip locked docs.
  - The maintainer listing shows `encrypted`; content endpoints → 404.
- [ ] **Steps 2-5.** Commit `feat(relay): encrypted image blobs; plaintext uploads refused for locked rooms`.

### Task 8: Owner actions — change password and rotate

**Files:** Create `src/server/room-lock-routes.js` (+ `.test.mjs`). Modify `yjs-server.mjs` (wire; net ≤ 0), preflight paths, `Dockerfile.yjs`.

Every route requires an account cookie whose account id equals `ownerAccountId` (else 403), a locked room (else 404), and an `oldAuthKey` that passes the verifier with the same limits.
- `POST /api/rooms/<h>/lock/password`, JSON `{ oldAuthKey, expectedRevision, lock }` (≤ 1 KiB). Runs through `log.mutateLock` with re-verification and a revision check inside the chain, and is refused with 409 during a freeze. One durable write of the new record with the **same** epoch and `lockRevision + 1` → 204 `{ lockRevision }`. Open sessions continue.
- `POST /api/rooms/<h>/lock/rotate/begin`, JSON `{ oldAuthKey, expectedRevision }` → 200 `{ head, rotationId, lockRevision, expiresInMs: 120000 }`. A second begin while one is active → 409.
- `POST /api/rooms/<h>/lock/rotate/commit`, binary per Deviation 5.
  - Header `{ oldAuthKey, rotationId, expectedHead, keyEpoch, lock, keepBlobs: [uuid…] }`. `keyEpoch` must be the current epoch + 1; `keepBlobs` holds ≤ 10,000 unique ids, each in the inventory.
  - The commit runs `log.commitRotation` (one durable batch, re-verifying the key and the revision inside the chain; old-epoch inventory entries keep their epoch for the grace), then `registry.publishLock` and `e2eRelay.closeRoom(4001, 'key rotated')` → 204. Old-epoch blobs are deleted by `expireOldEpochBlobs` after 24 h, not at commit `[S3]`.
  - Stale → 409 (the client retries from begin). Storage failure → 503 with the old state intact.
- `POST /api/rooms/<h>/lock/rotate/abort`, `{ oldAuthKey, rotationId }` → 204 and the freeze is released.

- [ ] **Step 1: failing tests.**
  - Non-owner → 403; wrong key → 403; limited → 429.
  - Password change: the new key works, the old one is refused, open cookies still work.
  - Rotate:
    - begin freezes appends; an append during the freeze is rejected with FROZEN.
    - commit with a wrong head or rotationId → 409.
    - a successful commit closes sockets with 4001; an old cookie → 401; the old authKey → 403; the new one → 200 with epoch+1.
    - the log equals the new snapshot.
    - old-epoch blobs are still readable with a new-epoch cookie, then deleted after the grace (fake clock);
    - abort or TTL deletes the staged blobs and sends RESUMED;
    - a password change racing a rotation commit: whichever runs second gets 409, and the stored lock always matches the stored ciphertext's epoch.
  - Crash injection between batch and publish: a reopen shows the new state consistently.
  - A freeze expires after 120 s.
  - Oversized header/body → 413.
- [ ] **Steps 2-5.** Commit `feat(relay): owner password change and barrier-based key rotation`.

### Task 9: Backup verification for E2E rooms

**Files:** Create `scripts/verify-backup-e2e.mjs` (+ test). Modify `scripts/verify-production-backup.sh` to call it with the restored data and uploads dirs.

`verifyBackupE2ERooms(persistence, uploadsDir)` → `{ rooms }`. For each doc with `ROOM_LOCK_META` it checks `[R9]`:
- the lock record decodes;
- `head ≥ snapshot.baseSeq`;
- update seqs are contiguous from `baseSeq + 1` to `head`;
- a snapshot is present whenever `baseSeq > 0`, and its `sha256` matches its bytes `[S-9]`;
- every inventory id has a file `<handle>.<id>.e2e` of exactly `bytes` length;
- there are no `.e2e` files outside the inventory, except staged orphans, which are reported as a count rather than an error.

Messages are fixed strings and never print keys.

- [ ] Tests:
  - A valid room passes; a pre-E2E backup passes with 0.
  - A seq gap, a missing snapshot, a snapshot with a wrong digest, a deleted blob file, a truncated blob and a bad lock record each fail.
  - Commit `feat(backup): verify encrypted room logs and blob inventory`.

### Task 10: Client session — locked exchange, password screen, re-unlock

**Files:**
- Modify `src/client/session/room-session.js` (+ test) and `src/client/app/main.jsx` (`BoardBootstrap`: on LOCKED render the password screen, then continue).
- Create `src/client/room-lock/lock-session.js` (+ test), `RoomPasswordScreen.jsx` (+ test) and `ReunlockDialog.jsx` (+ test).
- i18n in all locales.

**Interfaces:**
- `ROOM_SESSION_ERROR.LOCKED`, `.WRONG_PASSWORD`, `.LOCKED_OUT` (with `retryAfterSeconds`). `RoomSessionError.lock = { salt, kdf }`.
- `establishRoomSession(code, token, { authKey })` keeps `authKey` in module memory for renewals. `replaceRoomAuthKey(authKey)` swaps it after a password change on this page `[R11]`.
- A renewal 403 on a locked room sets session health `REAUTH_REQUIRED` and does not count as LOST. Pending edits are kept.
- `lock-session.js`:
  - `unlockRoom({ code, token, password, lockHint })` → stores `{ roomHandle, keyEpoch, dek, isOwner, lock }` in memory.
  - `getRoomKey()`, `clearRoomKey()`.
  - `reunlock(password)` posts `{code, token}` first to read the current salt/kdf from the 409, derives, posts with the authKey, then updates key, epoch and cached lock. It keeps the **previous** DEK in memory as `previousKey` until image repair finishes (Task 12), and dispatches `retroroom:room-key-changed`.
  - `updateLockAfterPasswordChange({ lock, authKey, lockRevision })` `[S-11]`.
- `ReunlockDialog` opens on `REAUTH_REQUIRED` or `retroroom:key-rotated`, over the board, without reloading.

- [ ] **Step 1: failing tests.**
  - The 409 parse.
  - authKey is sent on exchange and on renewal; after `replaceRoomAuthKey` renewals send the new key.
  - 403 → WRONG_PASSWORD; 429 → LOCKED_OUT; a renewal 403 → REAUTH_REQUIRED (not LOST).
  - **No storage writes of secrets** (wrapped `localStorage`/`sessionStorage`/IndexedDB open spy).
  - The screens render th/en with no raw keys.
- [ ] **Steps 2-5.** Commit `feat(room-lock): password prompt, locked session exchange and in-page re-unlock`.

### Task 11: E2E provider, delivery tracking, client vote expiry

**Files:**
- Create `src/client/session/e2e-provider.js` (+ test) and `src/client/session/e2e-vote-expiry.js` (+ test).
- Modify:
  - `src/client/session/storage-bridge.js`: one provider factory, `E2EProvider` when `getRoomKey()` matches the room; a storage-owned `rotationSource()` for Task 14 `[R4]`.
  - `src/client/session/client-sync.js` + `sync-status.js` (+ tests): explicit delivery state `[R7]`.

**Interfaces:**
- `new E2EProvider(wsBaseUrl, roomHandle, ydoc, { key, WebSocketImpl = WebSocket })`. It implements:
  - `on`/`off` for `'sync'`, `'status'`, `'connection-close'`, `'connection-error'`, plus `'delivery'`
  - `wsconnected`, `synced`, `connect()`, `disconnect()`, `destroy()`
  - `awareness`, `_awarenessUpdateHandler`
  - `setKey(key)` (after re-unlock; re-encrypts pending)
  - `pendingDelivery` (count)
- Delivery `[R7]`:
  - Each local update (origin ≠ provider) becomes a pending entry `{ clientRef, update }`, encrypted when sent.
  - The entry is removed only on the ACK with the same `clientRef`.
  - On every (re)connect after SYNCED, all pending entries are re-sent in order. Yjs updates are idempotent, so duplicates are harmless.
  - REJECT FROZEN keeps the entry and re-sends it on `RESUMED` or reconnect. REJECT QUOTA keeps it and re-sends after this client's snapshot is accepted. REJECT RATE re-sends with a capped backoff (≤ 2500 ms) `[S1][S-7]`.
  - ACK{seq} marks `seq` as covered in the coverage tracker `[S2]`.
  - `'delivery'` emits the pending count.
- `client-sync`: with a provider that has `pendingDelivery`, unload is guarded while it is > 0, even while connected, and the sync status shows "saving".
- Receive `[R6]`:
  - One serial queue: decrypt → `Y.applyUpdate(ydoc, bytes, provider)`.
  - `appliedSeq` tracks contiguous applied seqs.
  - A failure records `skippedSeq`, disables snapshots for this session and dispatches `retroroom:e2e-skipped`.
- Snapshot per Deviation 11. The state is captured right after `appliedSeq` advances, and AAD binds the `baseSeq`.
- Awareness: local changes only → EPHEMERAL; incoming → `applyAwarenessUpdate(…, provider)`.
- Close 4001 → keep the doc and pending entries, emit `retroroom:key-rotated`. After re-unlock: `setKey`, reconnect, re-send pending under the new epoch, and clear the undo/redo stacks through a storage-bridge hook `[S3]`.
- Awareness carries `e2eSynced` per Deviation 7.
- `e2e-vote-expiry.js` `[R15]`: arms a timer for the earliest `voteTimer.endsAt`. It acts only when synced with contiguous applied seq == head:
  - the elected finalizer (lowest present awareness clientID) at the deadline;
  - others after a 10 s grace, only if the generation is still live.
  - It calls `finalizeExpiredVotes(..., { timerGeneration })`.

- [ ] **Step 1: failing tests.** Use a fake socket pair and an in-test relay built from `e2e-envelope` and the real `E2ERoomLog` over a temp LevelDB; no mock of the provider.
  - Two docs converge, including concurrent typing in one `Y.Text`.
  - Undo with `trackedOrigins: ['local']` does not undo the other client's change; remote applies are non-local.
  - A tampered frame is skipped, the doc stays intact and snapshots are disabled.
  - Delayed decryption keeps the apply order.
  - A dropped ACK triggers a resend on reconnect, and the doc is correct with no duplicate effects.
  - Disconnect right after an edit: the unload guard is on, and after reconnect the edit arrives.
  - A snapshot never has `baseSeq` above `appliedSeq`.
  - A 4001 then `setKey` delivers the pending edits under the new epoch, and the undo stack is empty afterwards.
  - The author's own ACKed edits advance `appliedSeq`: a single client that only types can snapshot.
  - FROZEN → RESUMED → resend delivers.
  - Vote expiry: delayed replay does not finalize; the elected client finalizes once; a replaced timer is not finalized; the second client's grace path is idempotent.
- [ ] **Steps 2-5.** Commit `feat(session): encrypted room provider with acknowledged delivery`.

### Task 12: Images in E2E rooms, import and export

**Files:**
- Create `src/client/room-lock/e2e-images.js` (+ test).
- Modify:
  - `src/domain/security-boundaries.js`: kind `e2e`, checked before the data branch; `resolveRoomImageSource`.
  - `src/client/session/storage-bridge.js`: `uploadImage` encrypts and posts to `e2e-blobs` when locked `[R1]`.
  - `src/client/transfer/image-upload.js`: `readBackupImage` decrypts; `sanitizeImportedImages` uses the room-aware resolver `[R10]`.
  - `src/client/transfer/backup-images.js` (resolver injection).
  - `src/client/board/ImageCard.jsx`: the `useE2EImageUrl` hook.
  - Tests for each.

**Interfaces:**
- `encryptImageForUpload(blob)` → `{ bytes, id }`. The plaintext is `[u8 typeLen][type][bytes]`. AAD binds the id, a client-generated UUID sent in the header `x-blob-id` `[S5]`.
- `repairOldEpochImages({ doc, previousKey, currentKey, inventory })` `[S3]`: after a rotation re-unlock, re-encrypts and re-uploads each image whose blob has an older epoch, rewrites its src in a local transaction, then drops `previousKey`.
- `resolveE2EImage(src)` → a `blob:` URL, cached and revoked on the last unmount.
- `readE2EImageBytes(src)` → `Blob`.

- [ ] **Step 1: failing tests.**
  - The body `uploadImage` sends never contains the original bytes (paste/file path); `drawing-save` and import both pass through the same boundary, with tests calling them through their public functions.
  - Resolve gives the right type.
  - Export (`readBackupImage`) gives the decrypted bytes.
  - JSON and ZIP export → import into another locked room round-trips the images.
  - A normal room never fetches e2e paths.
  - A blob whose id was swapped fails decryption.
  - Image repair moves an old-epoch image to a new id under the new key, and the item's src is rewritten.
- [ ] **Steps 2-5.** Commit `feat(room-lock): encrypted images, import and export`.

### Task 13: Create a locked room (landing)

**Files:**
- Create `src/client/room-lock/CreateLockedRoom.jsx` (+ test).
- Modify `src/client/session/room-session.js` (`createRoom({ lock })`), `src/client/app/use-create-board.js` `[R12]`, `Landing.jsx` (one child, no logic), i18n.

**Behaviour:**
- Visible only when `fetchAccount()` is SIGNED_IN with `entitlements.canCreateLockedRoom`.
- Fields: password (≥ 10), confirmation, required checkbox, and the capability notice: votes finish only while someone has the board open; the maintainer cannot see content; a forgotten password cannot be recovered.
- On submit: `createRoomLock` → `createRoom({ lock })` → navigate. The board's password screen asks for the password once (Deviation 14).
- 401/403 show sign-in or plan messages.

- [ ] Tests: hidden for guests and without entitlement; validation; the request body is exactly `{ lock }`; no secret is passed through the URL or storage; th/en. Commit `feat(landing): create a password-protected encrypted board`.

### Task 14: Owner menu — change password and remove everyone

**Files:** Create `src/client/room-lock/RoomLockMenu.jsx` (+ test) and `src/client/room-lock/rotate-room.js` (+ test). Modify `src/client/chrome/TopBarPopovers.jsx` (`MorePopover` renders `<RoomLockMenu />`; `RetroBoard.jsx` is untouched) and i18n.

**Behaviour:**
- Shown only when `getRoomKey()?.isOwner`.
- **Change password:** current password + new password + confirmation → `rewrapRoomLock` → POST password → `replaceRoomAuthKey(newAuthKey)` → toast.
- **Remove everyone** `[R3][R4]`. A confirmation dialog explains that everyone must enter the new password and that a new password is required. Then `rotate-room.js`:
  1. **Drain first, then freeze** `[S1]`:
     - The rotation dialog is modal and blocks local edits.
     - Wait until this page's `pendingDelivery` is 0. Then `rotate/begin` with the cached `lockRevision`.
     - Wait until `appliedSeq` reaches the returned `head` (other clients' appends accepted before the freeze). Time out at 60 s → abort.
  2. Build a **detached** `Y.Doc` from `storage.rotationSource().encodeState()`. The live doc is not touched.
  3. For each image item with an e2e src: decrypt with the old DEK, encrypt with the new DEK under a fresh id, and upload with `x-blob-stage: <rotationId>` (counted in the room quota; deleted by the relay on abort or expiry). Rewrite `src` **in the detached doc only**.
     - If the room quota cannot hold the staged copies, abort with the message "Not enough room storage to re-encrypt images", leaving the old state intact.
  4. Encrypt the detached doc's state with the new DEK (AAD baseSeq = head, epoch + 1).
  5. `rotate/commit` with `keepBlobs` = the new ids.
  6. On 204: `clearRoomKey()`, then this page goes through the re-unlock flow with the new password like everyone else.
  7. On any failure: `rotate/abort`. The live board was never changed, and the relay deletes the staged blobs `[S-orphans]`.

- [ ] Tests:
  - Menu hidden for non-owners.
  - The password-change request has no plaintext password, and this page's renewal uses the new authKey afterwards.
  - Rotate:
    - the live doc is unchanged after a simulated commit failure;
    - the detached doc's image srcs point to the new ids;
    - the body parses back into header + snapshot;
    - begin → stale commit → retry path;
    - quota-exceeded abort.
  - Commit `feat(room-lock): owner password change and safe key rotation`.

### Task 15: Docs and rollout preparation

**Files:**
- `SECURITY.md`: locked rooms; what the server sees; offline guessing (spec §5.5); the Deviation 15 limits; the vote-expiry residual.
- `CONTEXT.md`: invariant changes per spec §6.7 as corrected by Deviation 6.
- `DEPLOYMENT.md`: backup checks, `.e2e` files, staged orphans.
- Privacy policy, all locales: encrypted rooms are unreadable by the operator. Update `LEGAL_EFFECTIVE_DATE_ISO`.
- `Dockerfile.yjs` audit.
- `docs/plans/2026-11-08-room-lock-e2e-rollout.md` (prepare-only):
  - release gate, backup, and deploy per `docs/plans/2026-11-06-google-sign-in-rollout.md` §7 (yjs + web, `--no-deps`, never `--remove-orphans`), smoke steps;
  - rollback: older relay code treats locked rooms as normal rooms with only the seed. Encrypted data is not exposed but is unreachable until a re-deploy.

- [ ] Doc-pinning tests stay green. Commit `docs: encrypted rooms security model, invariants and rollout`.

### Task 16: Two-context live check

**Files:** Create `scripts/room-lock-live-check.mjs` (reuse `board-live-helpers.mjs` and `fake-google-oidc.mjs`); add it to the catalog in `scripts/README.md`.

**Scenario** (A = en, signed in; B = th, guest; local relay + fake Google):
1. A creates a locked board and types the password on the board screen.
2. B: wrong password shows an error, the right one opens the board.
3. Edits sync both ways; concurrent typing in one card converges; undo/redo on A syncs.
4. A pastes an image, B sees it, and a drawing saves.
5. Export to ZIP, then import into a second locked board: images are shown.
6. B reloads and is asked again.
7. A changes the password: B's next renewal opens the re-unlock dialog, and B's pending edit survives.
8. While B types, A removes everyone: B's typed text is still on the board after B re-unlocks with the new password.
9. Scan the relay's DB dir and uploads for the plaintext card text and image bytes: 0 hits.
10. Screenshots th/en.

- [ ] Run it, view the screenshots, record the results in `report.json`. Commit `test(live): encrypted room two-browser check`.
