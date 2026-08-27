# Security model

## Trust boundary

Retro Board uses a trusted-link model. The room URL contains the Yjs document name, `board-<code>-<token>`, and the random token is the only access control. `src/storage-bridge.js` builds `ROOM` from that value and connects directly with `WebsocketProvider`. There is no login, per-user authentication, or server-issued capability or session.

Anyone who has the complete room URL is a fully trusted collaborator. They can read the board and submit arbitrary Yjs updates to it. Keep the URL secret and distribute it only to the intended group through a trusted, out-of-band channel.

## Best-effort safeguards

These mechanisms protect availability and data integrity against accidents, bugs, and runaway clients. They do not create an authorization boundary against a malicious holder of the room link.

- `yjs-server.mjs` applies a per-connection token-bucket rate limiter (`RL_MAX_MSGS`, `RL_REFILL_MSGS_PER_SEC`, `RL_MAX_BYTES`, and `RL_REFILL_BYTES_PER_SEC`). It closes an over-budget connection to protect Yjs and LevelDB capacity. A determined client can evade a per-connection limit by opening multiple connections.
- The `WebSocketServer` in `yjs-server.mjs` sets `maxPayload: RL_MAX_BYTES`, so `ws` rejects an oversized frame before the Yjs message parser receives it.
- The LevelDB calls in `yjs-server.mjs` go through `checkedGetYDoc`, `checkedStoreUpdate`, `checkedClearDocument`, and `checkedFlushDocument`. These wrappers detect the failure values that `y-leveldb` otherwise returns silently. `markStorageFailure`, `/readyz`, and the upgrade checks stop the relay from silently accepting new work after persistence degrades. They do not validate or authorize CRDT content from a peer.
- When `YJS_ALLOWED_ORIGINS` is configured, `yjs-server.mjs` checks WebSocket and upload origins. This reduces accidental or browser-based cross-origin use; it is not authentication, and a non-browser client can supply an allowed Origin header.
- The upload route in `yjs-server.mjs` has a separate per-IP token bucket, a 5 MiB limit, an image MIME allowlist, magic-byte checks, and no SVG support. These are input and capacity controls, not room authorization.

## Not security enforcement

The following are intentional UX and policy controls for cooperating users. They reduce mistakes; they are not security controls and are not gaps to fix under this model.

- The admin role and admin PIN in `src/useAdminRole.js` are client-side gates. `hashAdminPin` compares a SHA-256 hash in the client against `adminPinHash`, which is stored in the shared Yjs `meta` map and is readable and writable by any peer with the link. The relay performs no server-side authorization check for admin-gated actions.
- Vote quotas are checked in client UI logic against `timer.voteLimit`. `src/storage-bridge.js` exposes `setVote` as a direct Yjs map update, and the relay does not enforce a per-user count. A custom client can add vote keys without respecting the quota.
- `board.editingLocked` is a UI convenience. It is stored in the shared Yjs `meta` map, and the client uses it to decide whether editing is allowed. The relay has no concept of a locked board and applies valid CRDT updates from any connected client.

A collaborator can bypass all of these controls by modifying local JavaScript state or by constructing Yjs messages directly. That behavior is inside the accepted trusted-link threat model.

## Log redaction

Server log sites in `yjs-server.mjs` use `roomLogId(docName)`: a truncated HMAC-SHA-256 of the document name keyed by a random per-process `ROOM_LOG_KEY`. Logs and observability tooling receive this one-way, per-process identifier instead of the raw room name and capability token.

This limits accidental disclosure of the token through server logs. It does not protect the board from a client that already legitimately holds the room URL.

## Deployment

Deploy Retro Board only to trusted, closed groups that receive room links out of band, such as an internal team retrospective. Treat anyone who receives or discovers a link as fully trusted for that room.

Public or open deployment is not supported and is blocked pending dedicated follow-up work. Supporting untrusted audiences would require real per-user authentication and server-side authorization or capability checks. That work is explicitly not planned as part of this remediation pass.
