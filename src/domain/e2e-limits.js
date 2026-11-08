// Limits the relay enforces on encrypted rooms that the browser must respect too.
// The relay reads its env overrides on top of these defaults; clients follow the defaults.

/** Default YJS_MAX_WS_MESSAGE_BYTES: the largest WebSocket message, and so the largest APPEND frame. */
export const RELAY_DEFAULT_MAX_WS_MESSAGE_BYTES = 2_000_000;
/** Default YJS_MAX_DOCUMENT_BYTES: one room's stored size (encrypted rooms: snapshot plus log). */
export const RELAY_DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
/** Log entries allowed since the last snapshot; clients snapshot far earlier, so this is a backstop. */
export const E2E_MAX_LOG_ENTRIES = 10_000;
/** One SNAPSHOT per connection per this interval; more are REJECT RATE. */
export const E2E_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
/**
 * Bytes a stored snapshot reserves on top of its ciphertext for any room's docName (LevelDB key, digest,
 * baseSeq). The relay test measures it against y-leveldb's encoding.
 */
export const E2E_SNAPSHOT_RESERVATION_OVERHEAD_BYTES = 300;
/** Largest snapshot ciphertext whose reservation still fits a pending-store cap of `maxRoomBytes`. */
export const e2eMaxSnapshotCiphertextBytes = (maxRoomBytes) => maxRoomBytes - E2E_SNAPSHOT_RESERVATION_OVERHEAD_BYTES;
