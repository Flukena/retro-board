# Domain context

## Board item geometry

The canonical position and size fields stored for a board item. Every item has
finite, bounded `x` and `y` coordinates. Zones additionally have positive,
bounded `w` and `h` dimensions. Geometry in the Yjs room is canonical state,
not a rendering fallback.

## Backup manifest

The versioned JSON representation of a board, votes, comments, and shared
templates. An exported backup manifest must pass the same decoder used by
import without repair or information loss.

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
