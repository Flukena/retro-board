# Domain context

## Board item geometry

The canonical position and size fields stored for a board item. Every item has
finite, bounded `x` and `y` coordinates. Zones additionally have positive,
bounded `w` and `h` dimensions. Geometry in the Yjs room is canonical state,
not a rendering fallback.

## Backup manifest

The versioned JSON representation of a board, votes, comments, mood answers
and shared templates. An exported backup manifest must pass the same decoder
used by import without repair or information loss. The board's mood round
(`board.moodCheck`) is restored closed; presenter and meeting phase are live
session state and reset on import.

## Facilitation state

Room meta fields written silently (never undone by Ctrl+Z), private boards only:
`presenterUserId` (everyone follows this viewer), `phase` (`{ id, startedAt,
zoneId }`, one of write/reveal/group/vote/discuss/actions; `zoneId` is the
top-level zone the meeting runs on, picked at start, or null for the whole
board, and scopes the Reveal/Vote shortcuts) and `moodCheck`
(`{ id, startedAt, open }`). A mood answer is the kv key
`s||mood:<roundId>:<userId>` with an integer 1-5; it is the answerer's own
undoable write, and one round lives in the room at a time (starting a round
clears the old answers). Decoding is `src/domain/presenter.js`,
`retro-phase.js` and `mood-check.js`.

## Geometry repair

A deterministic migration for legacy canonical state. It changes only invalid
geometry fields, preserves every valid position, and emits the exact Yjs
patches needed to make the repair durable. Untrusted imports use stricter rules:
omitted legacy fields may be repaired, while explicit invalid values are
rejected.

## Room session

A signed, expiring HttpOnly cookie scoped to one registered room handle and
document. It does not expose the private room capability. Public and private
entry exchange credentials differently but share the same cookie validation.

## Encrypted room

A locked board (`/b/` with a lock record). Its state lives in the browser as a
Yjs document; the relay holds only an ordered ciphertext log plus one
client-written snapshot as room meta keys `e2e-head`, `e2e-snapshot`
(`{ baseSeq, bytes }`), `e2e-u-<seq>` and `e2e-blobs`, and the lock record
`retro-room-lock-v1`; the registry keeps only the plaintext seed. Invariants:

- Geometry and schema validation stay client-side: the relay cannot see
  content, so an update that fails decryption or apply is skipped and blocks
  that client from writing snapshots.
- Every seq is applied in order; a snapshot is `{ baseSeq, state }` and carries
  `knownSnapshotBase`, which the relay checks against the stored snapshot
  (snapshot fencing), so a stale writer is rejected instead of pruning newer log.
- The log holds at most 10,000 entries and snapshot plus log is capped at the
  document byte limit; clients snapshot before either is reached.
- `keyEpoch` and `lockRevision` change only through the owner routes; a
  rotation raises the epoch and invalidates all room cookies.
- Timed-vote expiry runs on an elected client (`src/domain/vote-expiry.js`),
  not on the relay; see SECURITY.md for the residual.
- Image `src` is `/rooms/<handle>/e2e-blobs/<uuid>`; blobs are opaque and
  belong to one epoch.

## Poker room

A registered relay room opened at `/p/<code>#<token>` instead of `/b/`. The
relay does not know room kinds: the doc's `poker` map marks it with
`kind: 'poker'`, set by the first client after the initial sync, and a room
whose `items` map holds board items is never claimed. `stories` holds one map
per story (title, order, `revealedAt`, `finalEstimate`); `votes` maps
`<storyId>:<userId>` to a card id of the room deck. Decoding is
`decodePokerRoom` in `src/domain/poker-schema.js`.

A round is the votes of one story. Reveal sets `revealedAt` and freezes votes
until the round is reset. Hiding cards before reveal is a workflow rule, not a
secret: any link holder can read the raw doc (see SECURITY.md). Story edits
are undoable; votes, reveal and final estimates are not.

## Protocol envelope

A complete binary WebSocket sync or awareness frame. Framing, byte/count
limits, UTF-8 and identity uniqueness are validated before upstream code
mutates a document or its awareness state. Awareness ownership is checked
separately after framing.

## Board reconciliation

Combining a canonical remote snapshot with pending local UI state. Active
and recent local geometry may survive stale echoes, and recent local creates
may survive missing snapshots; explicit peer deletion and undo/redo remain
authoritative. Reconciliation returns a new board and active move records.
