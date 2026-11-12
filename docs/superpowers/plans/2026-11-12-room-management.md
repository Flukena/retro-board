# Room Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in creator can list, open, rename and permanently delete their rooms. Guest rooms created from this release on expire 24 h after last use. Existing rooms are untouched.

**Architecture:**
- **Ownership** lives in one room meta record written at creation. The relay builds an in-memory owner index from it at hydrate; no cross-document index.
- **Delete** is one shared relay routine. Idle retirement uses it too, and it is made crash-safe with a durable tombstone.
- **The "My boards" UI** is a dialog opened from the account menu. It needs no new route, so nginx and the sitemap are unchanged.

**Tech Stack:** Node relay (`yjs-server.mjs`, `src/server/*`), y-leveldb 0.2.0, React 18 client, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-11-room-management-design.md` (owner-approved 2026-11-11). Context brief: the plan-context-scout report summarised in Deviations below.

## Deviations from the spec (controller rulings, 2026-11-12)

1. **Index location.** No `account-room:` keys. `y-leveldb` meta batches are single-document and its key encoding does not support prefix scans. Ownership is the room meta `retro-room-owner-v1` alone. `RoomRegistry` derives `accountId → Set<docName>` at hydrate and keeps it current on create and delete. For locked rooms the owner falls back to `lock.ownerAccountId`, so no backfill writes are needed.
2. **Owner meta shape.** `{ v: 1, kind: 'board'|'poker', accountId: string|null, createdAt }`.
   - `accountId: null` marks a guest room.
   - No record at all marks a legacy room: every room before this release, plus the Public Wall.
   - An orphaned room (its account was deleted) is rewritten to `{ ..., accountId: null, orphanedAt }`.
   - Orphaned rooms keep the 60-day rule; only `accountId === null && !orphanedAt` is a guest room.
3. **Kind** is sent by the client in the create body (`{ kind }`, optional, default `'board'`). The create whitelist accepts `{}`, `{kind}` and `{lock}`; locked rooms are boards.
4. **"My boards" is a dialog**, not a `/my-boards` page. It is opened from the account menu wherever that menu mounts. This avoids an nginx location and the sitemap.
5. **Delete uses `POST /api/account/rooms/<code>/delete`**, not `DELETE`, so it stays inside the existing credential preflight (`GET, POST, OPTIONS`).
6. **Non-owner, missing room or Public Wall → 404** on the new routes.
7. **Maintainer listing does not gain the owner id**, because `maintainer-snapshot.js:12` forbids user data. Maintainer idle retirement keeps working and uses the new retention classes.
8. **The automatic sweep retires guest rooms only.** 60-day retirement of owned and legacy rooms stays operator-triggered, as today.
9. **A guest room never opened** expires 24 h after `createdAt`; the clock is `lastRoomUseAt`.
10. **Rollback target** is the image `miro-release-yjs:e2e-c23f18c` / `miro-release-web:e2e-c23f18c`. The old relay rejects `{kind}`; this only matters during the deploy window, because rollback replaces web and yjs together. Documented in the rollout doc.
11. **Account deletion orphaning (Codex plan review #9).**
    - Immediately after the account batch, every room the account owns is rewritten to orphaned.
    - At startup, once both the registry and the AccountStore exist, any owner record whose account no longer exists is orphaned.
    - Together these cover a crash, a partial failure, and a creation racing the deletion. No extra pending key is needed.
12. **Revocation (Codex #8).** Room operations re-check the cookie generation inside the AccountStore queue at their admission point: after the body is read, before any mutation or link disclosure. An operation admitted before a later logout-all may finish. This is accepted, since it was authorized when it was admitted.
13. **Test fixtures** keep the repo's existing small `tmpdir()` LevelDB pattern. These are throwaway temp files that AGENTS allows. Live-check output and logs go to the data volume.

## Global Constraints

- `RetroBoard.jsx` ≤ 3993 and `yjs-server.mjs` ≤ 1477 lines (`src/rule-ratchets.test.js:8-9`). Both are at their ceiling, so any wiring added to `yjs-server.mjs` must be paid for by moving existing code out in the same task.
- Layering as in `src/architecture.test.js`: client → domain, server → domain, domain is pure.
- Every relay-imported module is listed in `Dockerfile.yjs` (`src/server/relay-image-files.test.js`). `src/domain/board-title.js` must be added when the relay imports it.
- `t()` keys go in th, en and all 9 locales (`src/client/ui/i18n-keys.test.js`). Use Warm Studio tokens only.
- The registration marker stays the last write. Its values 1 and 2 are unchanged (rollback contract, `relay-room-registry.js:34-44`). Owner meta is written durably before the marker.
- The lock record shape is unchanged (exact-key decode).
- The Public Wall room is never owned, listed, renamed, deleted or swept.
- New limits: `MAX_OWNED_ROOMS_PER_ACCOUNT = 500` (409 `owned-room-limit`); `GUEST_ROOM_RETENTION_MS = 24 h`; `GUEST_SWEEP_INTERVAL_MS = 1 h`; `ROOM_DELETED_CLOSE_CODE = 4004` (domain); per-account bucket of 30 rename/delete per minute.
- Server title writes pass `isBoardTitle` and use a non-`'local'` origin.
- Coding standards and tests per AGENTS.md: Sonar-clean, named constants, a test that fails first, revert-checked.
- Data location: live-check output goes to `/Volumes/ssd-fluke/BaseData/retro-board/<task>-<date>/`. Servers start in the background with bounded readiness polls and are never waited on.

## Review Focus

1. **Delete racing an open or reconnecting socket** (plain upgrade mid-handshake, e2e member mid-handshake, a rotation in flight). After delete returns, no socket stays open and no write reaches disk for that room. Owner: Task 3.
2. **Crash between "delete started" and "files gone".** A restart must never resurrect the room, and must finish removing its rows and files. Owner: Task 3.
3. **A legacy room must never become a guest room** (expiring in 24 h). This covers rooms from before the release, the Public Wall, and rooms of deleted accounts. Owner: Tasks 1, 2 and 4.
4. **Renaming a room that is not loaded** persists, live peers see it, and nobody's undo stack is affected. Owner: Task 4.
5. **A second account, a stale account cookie, or a guessed code** cannot learn whether a room exists, and cannot list, rename or delete it. Owner: Task 4.

---

### Task 1: Domain — ownership contract and retention classes

**Files:**
- Create: `src/domain/room-ownership.js` + `.test.js`
- Modify: `src/domain/room-retention.js` + test
- Modify: `src/domain/room-lock-contract.js` (or a new close-code home): `ROOM_DELETED_CLOSE_CODE`

**Interfaces (produces):**
- `ROOM_OWNER_META = 'retro-room-owner-v1'`
- `ROOM_KIND = { BOARD: 'board', POKER: 'poker' }`
- `encodeOwnerRecord({ kind, accountId, createdAt }) → object`
- `decodeOwnerRecord(value) → { kind, accountId, createdAt, orphanedAt? } | null` (exact keys; `accountId` is an account-id string **or null**)
- `orphanOwnerRecord(record, now)`
- `retentionClass(ownerRecord|null) → 'guest'|'kept'`
- `MAX_OWNED_ROOMS_PER_ACCOUNT = 500`
- `idleRoomCandidates(rooms, now)`: rows gain `retention`; guest rows use `GUEST_ROOM_RETENTION_MS`, kept rows use the existing 60 days.
- `guestRoomCandidates(rooms, now)`: guest only.

- [ ] Tests:
  - decode rejects extra or missing keys and a bad kind; it accepts `accountId: null` and rejects any other non-string value;
  - `retentionClass(null) === 'kept'`; `{accountId:null}` → `'guest'`; `{accountId:null, orphanedAt}` → `'kept'`; `{accountId:'a…'}` → `'kept'`;
  - a guest row idle 24 h + 1 ms is a candidate, one idle exactly 24 h is not, a kept row idle 25 h is not;
  - a guest row never opened is a candidate at createdAt + 24 h + 1 ms;
  - connected or resident rows are never candidates.
- [ ] Red, then implement, then green. Commit `feat(domain): room ownership records and guest retention`.

### Task 2: Relay — record owner and kind at creation; owner index

**Files:**
- Modify: `src/server/room-session-routes.js` (create body, optional account, `owned-room-limit` mapping), `src/server/relay-room-registry.js` (`createRoom({ owner })`, persist, hydrate, index, reservations), `Dockerfile.yjs`
- Modify (client): `src/client/session/room-session.js` `createRoom({ lock, kind })`, `src/client/app/create-board-flow.js` (passes kind; maps `owned-room-limit` to a translated message), i18n
- Tests: `room-session-routes.test.mjs`, `relay-room-registry.test.mjs`, `relay-room-registry-lock.test.mjs`, client `room-session.test.js`, `create-board-flow.test.js`

**Create body serialization (exact):**
- a normal board sends `{}` (kind omitted means board);
- Poker sends `{ kind: 'poker' }`;
- a locked board sends `{ lock }` only, and never `kind`.

The relay accepts exactly those three shapes; anything else → 400.

**Interfaces (produces):**
- `registry.createRoom({ unavailable, lock, owner })`. `owner` is `{ kind, accountId|null }`, or undefined for the Public Wall, which gets no record.
- `registry.ownershipOf(docName) → { record|null, retention: 'guest'|'kept', ownerAccountId|null, kind, locked }`. This is the canonical reader: `retention` comes from `retentionClass(record)`. A locked room without a record falls back to `lock.ownerAccountId`, `kind: 'board'`, retention `'kept'`.
- `registry.roomsOwnedBy(accountId) → docName[]`.
- `registry.setOwnerRecord(docName, record)`, durable; used for orphaning.
- **Per-account reservation.** The owned count plus pending creations for the account are checked and incremented synchronously, before the first await. They are released on every failure path. 500 or more → error code `OWNED_ROOM_LIMIT`, which the route maps to 409 `{ error: 'owned-room-limit' }`.
- Retirement and maintainer rows (`roomRows`) gain `retention` from `ownershipOf`.

- [ ] Tests:
  - creating with no cookie writes a guest record (`accountId: null`); with a valid cookie it writes that account; `{kind:'poker'}` is stored; a bad kind, `{lock, kind}` or an extra key → 400;
  - the exact-1-KiB locked test still passes;
  - the owner record is durable before the marker (crash-injection pattern);
  - the Public Wall gets no record;
  - after a relay restart, `ownershipOf` gives the right retention for legacy, guest, owned, orphaned, legacy-locked and Public Wall rooms;
  - two concurrent creates at 499 → exactly one succeeds; a failed create releases its reservation;
  - the client shows the translated limit message;
  - a guest create never touches the account store when no cookie is sent.
- [ ] `relay-image-files.test.js` stays green.
- [ ] Commit `feat(relay): record room owner and kind at creation`.

### Task 3: Relay — room fence and one crash-safe `deleteRoom`

**Files:**
- Create: `src/server/room-fence.js` + test, `src/server/room-deletion.js` + `.test.mjs`
- Modify: `room-retirement.js` (uses the deleter per room, with a per-room try); `relay-room-registry.js` (journal recovery at hydrate); `e2e-relay.js` and `e2e-room-log.js` (fence checks; `closeRoom` also closes mid-handshake members); `relay-uploads.js` and `e2e-blobs.js` (fenced admission and publication); `room-lock-routes.js` (fenced, no late `publishLock`); the plain upgrade continuation and session exchange (re-check the fence and registration after every await); `yjs-server.mjs` (wiring, net ≤ 0 lines: move code out to pay for it)

**Room fence** (`RoomFence`, one per relay):
- `enter(docName) → release | null` returns null once the room is fenced. Every operation that can write room state or files holds an entry for its duration:
  - session exchange and WebSocket upgrade (until attach);
  - plain image upload (admission to publication);
  - e2e blob upload;
  - every e2e log op (append, snapshot, rotation begin/commit/abort, password change);
  - title rename.
- `fence(docName)` sets a terminal fenced state; new `enter` calls fail and the route answers 404.
- `drained(docName, timeoutMs)` resolves when all entries are released.

The fenced state persists until the deletion completes, and is restored at hydrate from the journal.

**Deletion journal.** It lives in a separate relay document `retro-relay-deletions`, outside any room document. Meta key `deletion:<docName>` = `{ v: 1, handle, startedAt }`. It is removed only after the database rows and files are gone.

Order:
1. `fence(docName)`.
2. Journal put (durable).
3. Durable batch on the room doc deleting the registration marker, so a crash leaves it unservable.
4. Unpublish in memory.
5. Close plain sockets (`4004`) and e2e sockets, mid-handshake members included (`4004`).
6. Tear down the plain doc, even with no sockets: destroy and remove it from `docs`; cancel vote timers and scheduled compaction; drain hydration, activity and the store queue.
7. Cancel the e2e freeze timer and drain the e2e log queue; refuse late enqueues.
8. `drained(docName, DELETE_DRAIN_TIMEOUT_MS)`. On timeout, keep the journal and the fence and return failure (503). Recovery finishes later.
9. `clearDocument`.
10. Remove images and `.e2e` blobs by the journal's handle, then reconcile usage.
11. Remove the journal entry.

**Recovery.** At hydrate, and on every guest-sweep tick, each journal entry re-runs steps 4–11. A room in the journal is never registered.

- [ ] Tests (real relay where practical):
  - delete with a connected plain peer and an e2e peer → both get 4004; then session, upgrade and upload all → 404;
  - a stalled upgrade (paused before attach) is refused and leaves no doc;
  - an uncooperative close handshake still ends with no doc and no writes;
  - a paused plain image upload and a paused staged e2e upload during delete → no file remains;
  - a paused rotation commit and a paused password change during delete → no lock is re-published and no rows remain;
  - crash injection at each of: after the journal put, during clear, after clear, during file removal, and during recovery → after restart the room is not served, and the rows, files and journal entry are all gone;
  - drain timeout → 503, then the journal completes on the next tick;
  - retirement still passes its tests, and one failing room does not abort the sweep.
- [ ] Revert-check the journal recovery, the mid-handshake close and the upload fence.
- [ ] Commit `feat(relay): room fence and crash-safe deletion shared with retirement`.

### Task 4: Relay — account room routes, rename, orphaning

**Files:**
- Create: `src/server/account-room-routes.js` + `.test.mjs`; `src/server/room-title-writer.js` + test; `src/server/room-links.js` + test, a kind-aware URL builder
- Modify: `maintainer-room-access.js` (uses `room-links.js` but keeps its own locked-room suppression and tests); `auth-routes.js` (account delete → orphan owned rooms); `account-store.js` (`checkGeneration(id, generation)` runs inside the store queue); startup reconciliation; dispatch and OPTIONS wiring (net ≤ 0 lines in `yjs-server.mjs`)

**Routes:**
- `GET /api/account/rooms` → `{ rooms }`, newest first. It uses the optional-Origin policy of `GET /api/account` (`auth-routes.js:186-192`).
- `POST /api/account/rooms/<code>/title` `{ title }` → 200 `{ title }`. A locked room → 409 `locked-room`.
- `POST /api/account/rooms/<code>/delete` `{ confirmCode }` → 204. A code that does not match → 400. A drain timeout → 503.
- Writes need an allowed Origin. `OPTIONS` on these paths answers like the account preflight (`GET, POST, OPTIONS`; exact allowed origins only).

Every route:
- needs the account cookie (else 401) and sends `no-store`; unavailable → 503;
- answers 404 when the account does not own the room, the room is missing, or it is the Public Wall; all three responses look identical;
- uses a per-account bucket of 30 per minute → 429 with `retry-after`;
- after reading the body, calls `checkGeneration` before any mutation or before building links, so a revoked or deleted session → 401.

Room entry:
- `{ code, kind, locked, title|null, link, createdAt, lastActiveAt }`;
- `link` comes from `room-links.js`: `/b/` for boards, `/p/` for Poker, and the link for locked rooms too;
- `title`: read from the live doc if resident, otherwise by a bounded loader that reads persistence without registering a doc; null for locked rooms.

**Title writer.** Rename always runs on the one live document instance, so it cannot race a first connection:
1. Hold a fence entry.
2. Get or create the doc through the same `getYDoc` + `roomReady` path an upgrade uses.
3. Transact with origin `'relay-title'`.
4. Await that update's store write. 200 means the update was written through the relay's normal store path, which is not fsync; this matches every Yjs edit.
5. If no connection is attached, unload the doc via the normal teardown.
6. On a store failure → 503 and no 200.

**Orphaning (Deviation 11).**
- After the account batch commits, the deletion calls `registry.setOwnerRecord(doc, orphanOwnerRecord(...))` for every owned room.
- At startup, once both stores exist, any owner whose account does not exist is orphaned.

- [ ] Tests:
  - authorization matrix: owner; other account; signed out; expired cookie; revoked generation; deleted account; a foreign Origin on writes; a same-origin GET with no Origin → 200; cross-origin preflight; wrong confirm code; Public Wall; locked rename;
  - the non-owner 404 is byte-identical to the missing-room 404;
  - a request paused after body read, racing logout-all → 401 and no mutation;
  - rename of a resident room: the peer receives the title and the peer's undo stack is unchanged;
  - rename of a cold room racing the first connection: the connecting peer gets the title;
  - rename of a cold room survives a restart;
  - rename racing delete → 404 or deleted, never resurrected;
  - a store failure → 503;
  - list: a resident room shows its live title, a locked room has title null and a link, a Poker link opens Poker;
  - account deletion orphans the rooms (kept retention); a crash mid-orphaning is fixed at startup; a creation racing the deletion is orphaned at startup;
  - the maintainer still hides locked-room links;
  - the bucket returns 429.
- [ ] Commit `feat(relay): owner list, rename and delete for account rooms`.

### Task 5: Relay — automatic guest sweep

**Files:**
- Create: `src/server/guest-room-sweep.js` + test
- Modify: the maintenance tick wiring (net ≤ 0 lines in `yjs-server.mjs`); `src/client/maintainer/IdleRooms.jsx` label: guest 24 h, others 60 days

Every `GUEST_SWEEP_INTERVAL_MS`, the sweep first runs deletion-journal recovery, then retires `guestRoomCandidates` (rows carrying `retention` from `ownershipOf`) through the deleter. It is skipped on the Public Wall relay and is single-flight. It logs one summary line: `{ retired, recovered, files }`.

- [ ] Tests (fake clock):
  - a guest room is retired after 24 h idle and not before;
  - a legacy room and an orphaned room survive any age;
  - a connected guest room survives;
  - the sweep never runs twice concurrently;
  - after deploy-like hydrate of a DB with only legacy rooms, the sweep retires 0.
- [ ] Commit `feat(relay): retire idle guest rooms automatically`.

### Task 6: Client — "My boards" dialog, create sends kind, guest note

**Files:**
- Create: `src/client/account/MyBoardsDialog.jsx`, `my-boards-controller.js` + tests; `src/client/ui/TypeToConfirmDialog.jsx` + test
- Modify: `account-api.js` (`listRooms`, `renameRoom`, `deleteRoom`), `AccountMenu.jsx` (item "My boards"), `Landing.jsx` (guest note, signed-out only), i18n (11 locales), `StartPokerButton`/create flow kind

The dialog lists rooms with:
- the title or code;
- a "Password protected" badge, the kind, and created and last-active times (`formatRelativeTime`);
- **Open** (full page load to `link`), **Rename** (normal rooms; inline dialog with title bounds), and **Delete** (TypeToConfirm with the room code; enabled only on an exact match).

States: loading, empty ("Boards you create while signed in appear here."), error.
Error mapping: 401 → sign in, 404 → removed from the list, 409 `locked-room`, 429 → wait.
After a delete: `forgetRecent(code, token)`.

- [ ] Controller tests (no DOM): list/rename/delete flows and error mapping; confirm gating is exact and case-sensitive.
- [ ] Render tests: SSR renders the empty, list and locked badge states.
- [ ] The guest note shows only when signed out; i18n parity.
- [ ] Commit `feat(account): my boards with rename and delete`.

### Task 7: Client — terminal deleted state and locked-room rename

**Files:**
- Create: `src/client/session/room-deleted.js` (a terminal state plus `ROOM_DELETED_EVENT`) + test; `src/client/session/RoomDeletedBoundary.jsx`, which wraps every private room view (board and Poker bootstraps in `main.jsx`) and replaces the view when the room is deleted
- Modify: `client-sync.js` and `e2e-provider.js` (a 4004 enters the terminal state: no reconnect timer, `connect()` becomes a no-op, health-driven reconnects are suppressed); `room-session.js` (a terminal state cancels the refresh timer and ignores refreshes in flight; a session 404 while active also counts as deleted); `RoomLockMenu.jsx` (owner gets **Rename board**, writing `meta.title` through the normal patch path); i18n

- [ ] Tests:
  - after a 4004 on each provider: advance all timers, resolve a delayed refresh, call `connect()` explicitly → no new socket and no request;
  - the boundary replaces the plain board, the locked board and Poker in th and en;
  - the recent room is forgotten;
  - the owner menu shows Rename only for the owner, and the dialog validates bounds.
- [ ] Revert-check the terminal state.
- [ ] Commit `feat(board): terminal deleted-room state and owner rename for locked boards`.

### Task 8: Docs and privacy

- **SECURITY.md:**
  - accounts now grant access to owned rooms through the list's links;
  - 404 non-disclosure;
  - delete is final except in backups;
  - guest-room expiry.
- **CONTEXT.md:**
  - owner record and retention classes;
  - tombstone deletion.
- **DEPLOYMENT.md:**
  - the guest sweep;
  - the room count before and after deploy must match.
- **Privacy text in 11 locales:**
  - guest rooms from now on are deleted 24 h after the last visit;
  - owned rooms are kept while in use (60 days idle);
  - owner delete.
- `LEGAL_EFFECTIVE_DATE_ISO` → the deploy date, with its pin test.
- `docs/plans/2026-11-12-room-management-rollout.md`: prepare-only, owner approval, per the `project-prod-deploy-flow` steps, with rollback to `e2e-c23f18c`.
- Commit `docs: room management security, invariants and rollout`.

### Task 9: Live two-browser check

Create `scripts/room-management-live-check.mjs`. Reuse `board-live-helpers.mjs`, fake OIDC and the account check's stack setup, and add it to the `scripts/README.md` catalog. Output goes to `/Volumes/ssd-fluke/BaseData/retro-board/room-management-live-<date>/`.

Steps:
1. A (en, signed in) creates a board and a Poker room; B (th, guest) creates a board.
2. A opens My boards and sees exactly its two rooms; B's room is absent.
3. A renames its board from My boards while B has it open; B sees the new title live, and B's undo/redo is unaffected.
4. A deletes the board while B is in it; B sees the deleted screen; reopening the link shows "not found"; the room is gone from A's list.
5. A second account C cannot see A's rooms, and a forged delete of A's room code → 404.
6. A locked board: listed with its badge, renamed from the owner menu after unlock.
7. th/en screenshots of the dialog, the confirm step and the deleted screen; read every PNG.
8. Guest expiry: relay started with a test-only env override of the guest retention and the sweep interval. Check there is a test-only knob, or add one named `YJS_GUEST_ROOM_RETENTION_MS` limited to insecure-dev mode. B's room disappears and A's rooms remain.

Run `(npm test && npm run build)` as one bounded command. Commit `test(live): room management two-browser check`.
