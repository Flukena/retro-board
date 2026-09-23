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
