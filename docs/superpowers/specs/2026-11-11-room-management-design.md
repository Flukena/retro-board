# Room management: owned rooms, "My boards", rename, delete, guest-room expiry

Status: draft for owner review (2026-11-11). Owner decisions recorded in §1.

## 1. Goal and decisions

A signed-in user can see the rooms they created, open them, rename them and
delete them for good. Rooms created without signing in are temporary: the
server forgets them 24 hours after the last person leaves.

Owner decisions (2026-11-11):

1. **Who manages a room:** only the Google account that created it (option A).
2. **Edit means rename only** (option A).
3. **Delete is permanent and immediate**, after typing the room code to confirm
   (option A). Recovery only from the operator's normal backups.
4. **Guest rooms** created after this release (no owner) are deleted 24 hours
   after the last connection closes (option B). **Rooms that already exist in
   production (about 200) are left alone**: they keep today's 60-day idle rule
   (owner, 2026-11-11: "เก็บไว้ไม่ต้องยุ่ง").
5. **"My boards" links open the room** (default taken; the owner did not object):
   the list hands the owner a working link. See §6 for the trade-off.

Non-goals: transferring ownership, co-owners, claiming old rooms, a trash bin,
changing a room between normal and locked, room settings other than the title.

## 2. Ownership

- A room is **owned** when it was created with a valid account cookie.
  `POST /api/rooms` already reads the account cookie for locked rooms; it now
  records the creator for every room kind (board, Poker; locked rooms already
  carry `ownerAccountId` in the lock record).
- Storage (relay LevelDB, durable batch at creation):
  - room meta `retro-room-owner-v1` = `{ v: 1, accountId, createdAt }`;
  - account index `account-room:<accountId>:<docName>` = `{ createdAt, kind }`,
    so listing an account's rooms is one bounded prefix scan.
- At most `MAX_OWNED_ROOMS_PER_ACCOUNT = 500`. Creating a 501st owned room gets
  409 `owned-room-limit`. The room is not created; the UI says so and suggests
  deleting old boards.
- Locked rooms created before this release already name their owner in the
  lock record. Startup backfills their meta and index entries once
  (idempotent).
- A room created **without** an account cookie is marked as a guest room at
  creation: meta `retro-room-owner-v1` = `{ v: 1, accountId: null, createdAt }`.
  Only rooms carrying this guest marker expire after 24 h (§5).
- Rooms that existed before this release have no owner meta at all. They are
  *legacy* rooms: not listed, not manageable, and kept under the 60-day rule.
- Account deletion removes the account's index entries and owner meta in the
  same batch as the account. Those rooms become ownerless legacy rooms and keep
  the 60-day rule; deleting an account never starts a 24 h countdown.
- The Public Wall is never owned, listed, renamed or deleted through this
  feature.

## 3. API (relay, under `/api/account/rooms`)

All routes need the account cookie (none → 401) and an allowed `Origin`.
Writes also carry `Content-Type: application/json`. Responses are
`Cache-Control: no-store`. A room the account does not own answers 404, the
same as a missing room, so ownership is not probed.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/account/rooms` | — | 200 `{ rooms: [...] }`, newest first |
| POST | `/api/account/rooms/<code>/title` | `{ title }` | 200 `{ title }`; normal rooms only, locked → 409 `locked-room` |
| DELETE | `/api/account/rooms/<code>` | `{ confirmCode }` | 204; `confirmCode` must equal `<code>` exactly, else 400 |

A room entry looks like:
`{ code, kind: 'board'|'poker', locked, title|null, link|null, createdAt, lastActiveAt }`.

- `title` comes from the room state for normal rooms. It is null for locked
  rooms, because the server cannot read it.
- `link` is the full room link for normal rooms. For locked rooms it is the
  link too, and the password screen still guards the content.
- Rename (normal room) runs on the relay: it loads the room's `Y.Doc` and sets
  `meta.title` through the same validator the board uses
  (`src/domain/board-title.js`, bounded and trimmed). Connected clients
  receive it as a normal Yjs update, so everyone sees the new title live. The
  undo stack is not affected, because the update has a remote origin.
- Delete:
  1. Closes every socket of the room with close code `4004` (room deleted).
  2. Blocks new sessions for it.
  3. Removes the room through the same path idle retirement uses:
     `registry.retireRoom`, image and `.e2e` blob removal, upload-usage
     reconcile, and the encrypted relay's `forgetRoom`. It also removes the
     lock record, the owner meta and the index entry.

  These steps run in one serialized room operation, so it cannot race a
  rotation or a reconnect. The shared code becomes one `deleteRoom(docName)`
  used by both idle retirement and owner delete.
- Limits: rename and delete share a per-account token bucket (e.g. 30 per
  minute). GET is capped by the 500-room bound.
- Maintainer tooling keeps working. The maintainer listing shows the owner
  account id for owned rooms.

## 4. Client

- **Account menu → "My boards"** (`/my-boards`, signed-in only; a guest is
  sent to sign in). The page lists rooms with:
  - the title, or the code for locked or untitled rooms;
  - a "Password protected" badge, the kind, created and last-active times;
  - buttons **Open**, **Rename** (normal rooms) and **Delete**.
  - Empty state: "Boards you create while signed in appear here."
- **Rename dialog:** prefilled title, the same bounds as the board title, and
  an inline error.
- **Delete dialog:** explains that the deletion is permanent, that everyone
  in the board is disconnected, and that images are removed. The user must
  type the room code before the button enables.
- **Locked rooms:** rename happens in the board. The owner menu (Task 14 of
  the encrypted-rooms plan) gains **"Rename board"**. It writes the title
  inside the encrypted state, like any edit.
- **Inside a board,** close code `4004` shows a full-page "This board was
  deleted" screen with a link home. The board is not reconnected, and the
  room is removed from this browser's recent rooms.
- **Landing note** for guests: "Boards created without signing in are deleted
  24 hours after everyone leaves. Sign in to keep them." Shown next to the
  Create button. It is visible only to signed-out users.
- Every string goes through `t()` in th, en and all 9 locales, using Warm
  Studio tokens.

## 5. Guest-room expiry

- New retention rule in `src/domain/room-retention.js`:
  - a **guest** room (owner meta with `accountId: null`) is retired when it has
    no connection and its last activity is older than
    `GUEST_ROOM_RETENTION_MS = 24 h`;
  - **owned** rooms and **legacy** rooms (no owner meta) keep the existing
    60-day idle rule, unchanged.
  - Activity is the existing `retro-room-activity-v1` `lastActiveAt`, which
    is updated while connections are open and on close.
- The sweep runs on the existing retirement timer, at a shorter interval
  (e.g. hourly) so expiry lands within about an hour of the 24 h mark.
- Existing production rooms are untouched by this release: none has the guest
  marker, so no existing room is deleted earlier than today.
- Rooms with an unknown age keep today's behaviour: they are counted, not
  deleted.

## 6. Security notes (SECURITY.md changes, owner approval)

- **Signing in now grants access to the rooms you own.** The "My boards" list
  hands out working links. Anyone who takes over the Google account (or its
  `rb_account` cookie) can open every normal room that account owns. Locked
  rooms still need their password. This replaces the current statement that
  accounts grant no room access.
- **Ownership is not revealed.** Delete and rename answer 404 for rooms the
  account does not own. Room codes are never accepted without the account
  cookie.
- **Owner delete is final for the live system.** Backups still hold the room
  until they rotate out.
- **Privacy text:** guest rooms created from now on are deleted 24 h after the
  last visit; owned rooms are kept while used (60 days idle). All locales are updated.

## 7. Testing

- **Relay (`*.test.mjs`):**
  - owner recorded at creation, for both cookie and no cookie;
  - the 500 limit;
  - backfill from lock records;
  - list, rename and delete authorization (owner, other account, signed out,
    bad Origin, wrong `confirmCode`);
  - delete closes sockets with 4004, removes images and `.e2e` blobs, and
    leaves a later session with 404;
  - delete racing a reconnect and a rotation;
  - account deletion makes the account's rooms ownerless;
  - retention: a guest room is retired after 24 h and not before, an owned
    room and a legacy room (no owner meta) only after 60 days, and a connected
    room never.
- **Client:**
  - the My boards controller (list, rename, delete-confirm gating, error
    mapping);
  - the 4004 screen;
  - the guest note shown only when signed out;
  - the owner-menu rename for locked rooms;
  - i18n parity.
- **Live two-browser check:**
  - the owner renames and the peer sees it live;
  - the owner deletes and the peer sees the deleted screen, and the link
    then 404s;
  - a non-owner signed-in account cannot see or delete the room;
  - th and en screenshots.

## 8. Rollout

Prepare-only, owner approval:

1. Backup and verify.
2. Deploy yjs and web.
3. Smoke the steps above, and confirm the room count right after deploy equals
   the count before (no existing room retired).

Rollback to `e2e-c23f18c`:
- owner meta and index entries are ignored by the old relay;
- rooms deleted meanwhile stay deleted (restore only from backup);
- guest rooms created meanwhile fall back to the 60-day rule.
