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
10. **Rollback target** is the image `miro-release-yjs:e2e-c23f18c` / `miro-release-web:e2e-c23f18c`.

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
- `decodeOwnerRecord(value) → { kind, accountId, createdAt, orphanedAt? } | null` (exact keys)
- `orphanOwnerRecord(record, now)`
- `retentionClass(ownerRecord|null) → 'guest'|'kept'`
- `MAX_OWNED_ROOMS_PER_ACCOUNT = 500`
- `idleRoomCandidates(rooms, now)`: rows gain `retention`; guest rows use `GUEST_ROOM_RETENTION_MS`, kept rows use the existing 60 days.
- `guestRoomCandidates(rooms, now)`: guest only.

- [ ] Tests:
  - decode rejects extra or missing keys, a bad kind, a non-string accountId;
  - `retentionClass(null) === 'kept'`; `{accountId:null}` → `'guest'`; `{accountId:null, orphanedAt}` → `'kept'`; `{accountId:'a…'}` → `'kept'`;
  - a guest row idle 24 h + 1 ms is a candidate, one idle exactly 24 h is not, a kept row idle 25 h is not;
  - a guest row never opened is a candidate at createdAt + 24 h + 1 ms;
  - connected or resident rows are never candidates.
- [ ] Red, then implement, then green. Commit `feat(domain): room ownership records and guest retention`.

### Task 2: Relay — record owner and kind at creation; owner index

**Files:**
- Modify: `src/server/room-session-routes.js` (create body, optional account), `src/server/relay-room-registry.js` (`createRoom({ owner })`, persist, hydrate, index), `Dockerfile.yjs`
- Modify (client): `src/client/session/room-session.js` `createRoom({ lock, kind })`, `src/client/app/create-board-flow.js` passes kind
- Tests: `room-session-routes.test.mjs`, `relay-room-registry.test.mjs`, `relay-room-registry-lock.test.mjs`, client `room-session.test.js`

**Interfaces (produces):**
- `registry.createRoom({ unavailable, lock, owner })`, where `owner` is `{ kind, accountId|null }` or undefined (Public Wall → no record).
- `registry.ownerOf(docName) → { accountId|null, kind, createdAt, locked } | null`
- `registry.roomsOwnedBy(accountId) → docName[]`
- `registry.ownedCount(accountId)`
- `registry.setOwnerRecord(docName, record)`: durable; used by Task 4 for orphaning.

- [ ] Tests:
  - create with no cookie writes a guest record (`accountId:null`); with a valid cookie writes that account; `{kind:'poker'}` is stored; a bad kind or extra key → 400;
  - the exact-1 KiB locked test still passes;
  - the owner record is durable before the marker (crash-injection pattern of `relay-room-registry-lock.test.mjs`);
  - the Public Wall gets no record;
  - hydrate rebuilds the index, and a locked room with no owner record is indexed under `lock.ownerAccountId`;
  - the 501st owned room → 409 `owned-room-limit` with nothing persisted;
  - a guest create never reads the account store when no cookie is sent.
- [ ] `relay-image-files.test.js` stays green.
- [ ] Commit `feat(relay): record room owner and kind at creation`.

### Task 3: Relay — one crash-safe `deleteRoom`

**Files:**
- Create: `src/server/room-deletion.js` + `.test.mjs`
- Modify: `src/server/room-retirement.js` (uses it per room, with a per-room try), `relay-room-registry.js` (tombstone + hydrate cleanup), `e2e-relay.js` (`closeRoom` also closes members mid-handshake; delete close code), `yjs-server.mjs` (wiring; net ≤ 0 lines)

**Interfaces (produces):** `createRoomDeleter(ports).delete(docName, { reason }) → { files }`. The ports are registry, plain docs/conns, blockedRooms, e2eRelay, uploads io, reconcileUploadUsage and the store queue.

Order (one deletion per room at a time, tracked in a `deleting` set):
1. Durable batch: put `retro-room-deleted-v1` and delete the registration marker. The room is now unpublished on disk.
2. Unpublish in memory; block new sessions and upgrades.
3. Close plain sockets (`4004`) and e2e sockets, including mid-handshake members (`4004`).
4. Wait for the plain doc to unload and its store queue to drain (bounded, named timeout).
5. `clearDocument`.
6. Remove images and `.e2e` blobs, then reconcile usage.

At hydrate, any document with a tombstone is cleared and its files removed, never re-registered.

- [ ] Tests (real relay where practical):
  - delete with a connected plain peer and an e2e peer → both get 4004, then session and upgrade 404;
  - an upgrade in flight during delete is refused;
  - a late Yjs update after close writes nothing;
  - a crash after step 1 (injected) → restart does not serve the room and clears it;
  - retirement still passes its tests, and one failing room does not abort the sweep;
  - delete during a rotation freeze ends with nothing left.
- [ ] Revert-check the tombstone and the mid-handshake close.
- [ ] Commit `feat(relay): crash-safe room deletion shared with retirement`.

### Task 4: Relay — account room routes, rename, account-deletion orphaning

**Files:**
- Create: `src/server/account-room-routes.js` + `.test.mjs`; `src/server/room-title-writer.js` + test
- Modify: `auth-routes.js` (delete hook: orphan rooms), dispatch wiring (net ≤ 0 lines in `yjs-server.mjs`), `maintainer-room-access.js` (share the link builder)

**Routes:**
- `GET /api/account/rooms` → `{ rooms }`, newest first.
- `POST /api/account/rooms/<code>/title` `{ title }` → 200 `{ title }`. A locked room → 409 `locked-room`.
- `POST /api/account/rooms/<code>/delete` `{ confirmCode }` → 204, or 400 if the code does not match.
- Every route: account cookie (else 401), credential Origin, `no-store`, unavailable → 503.
- Not owner, missing room or Public Wall → 404.
- Per-account bucket: 30 per minute → 429 with `retry-after`.

Room entry: `{ code, kind, locked, title|null, link, createdAt, lastActiveAt }`.
- `title` is read from the live doc when resident; otherwise from storage through one bounded loader, and null for locked rooms.
- `link` is built by the shared builder, for locked rooms too.

Title writer:
- **Resident room:** transact on the live doc with origin `'relay-title'`.
- **Cold room:** load from persistence, apply, and `storeUpdate` the diff durably before replying.
- Either way, validate with `isBoardTitle`.

Account delete: after the account batch, call `registry.setOwnerRecord(doc, orphanOwnerRecord(...))` for every owned room. This is best effort; a stale accountId is harmless, because the room keeps the 60-day rule and is unlisted.

- [ ] Tests:
  - authorization matrix: owner, other account, signed out, foreign Origin, wrong confirm code, Public Wall, locked rename;
  - the 404 for a non-owner looks identical to the 404 for a missing room (body and headers);
  - rename of a resident room: a connected peer receives the title and the peer's undo stack is unchanged;
  - rename of a cold room persists across a relay restart;
  - list shows a resident room's live title; a locked room has title null and a link;
  - after account delete, the rooms are orphaned (kept class) and the new account sees none;
  - the bucket returns 429.
- [ ] Commit `feat(relay): owner list, rename and delete for account rooms`.

### Task 5: Relay — automatic guest sweep

**Files:**
- Create: `src/server/guest-room-sweep.js` + test
- Modify: the maintenance tick wiring (net ≤ 0 lines in `yjs-server.mjs`); `src/client/maintainer/IdleRooms.jsx` label: guest 24 h, others 60 days

Every `GUEST_SWEEP_INTERVAL_MS`, retire `guestRoomCandidates` through `deleteRoom`. It is skipped on the Public Wall relay and is single-flight. It logs one summary line: `{ retired, files }`.

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

### Task 7: Client — deleted-room screen and locked-room rename

**Files:**
- Modify: `client-sync.js` and `e2e-provider.js` (a 4004 stops reconnecting and dispatches `ROOM_DELETED_EVENT`), `room-session.js` (if needed); create `src/client/session/RoomDeletedScreen.jsx` mounted where `ReunlockDialog` mounts (`main.jsx`, not `RetroBoard.jsx`); `RoomLockMenu.jsx` gains **Rename board** (owner), which writes `meta.title` through the normal patch path; i18n

- [ ] Tests:
  - a 4004 on each provider → no reconnect timer, the event fires, the recent room is forgotten;
  - the screen renders in th and en;
  - the owner menu shows Rename only for the owner, and the rename dialog validates bounds.
- [ ] Revert-check the no-reconnect behaviour.
- [ ] Commit `feat(board): deleted-room screen and owner rename for locked boards`.

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
