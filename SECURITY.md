# Security model

## Supported deployment model

Retro Board supports a **publicly reachable host with private, trusted-link
rooms**. A room link is a bearer capability: anyone who receives the complete
link is a fully trusted collaborator for that room. Do not post room links in
public channels unless everyone who can obtain the link is intended to have
full board access.

This is not a multi-tenant identity or authorization system. There are no user
accounts, per-user ACLs, revocation, or server-enforced admin roles. An open
room shared with mutually untrusted participants is therefore unsupported; it
would require authenticated identities and server-side authorization.

## Room capability and session flow

New rooms are created by `POST /yjs/api/rooms`. The relay rate-limits creation,
registers the room in persistent LevelDB metadata, and returns a random room
code and capability token. Unknown WebSocket paths never create documents.

The share URL keeps the capability in its fragment (`/b/<code>#<token>`), so it
is not sent in the initial HTTP request or Referer. Before loading any board
state, the client sends the code and token in the body of
`POST /yjs/api/room-session`. A valid capability is exchanged for:

- a short-lived, room-scoped, signed `HttpOnly; Secure; SameSite=Strict` cookie;
- a stable opaque room handle used in WebSocket and upload paths.

The raw capability and canonical LevelDB document name are consequently absent
from WebSocket URLs and BroadcastChannel names. The client refreshes the
session before expiry; the server also expires already-open WebSockets.

The capability is still present in the browser's URL fragment while a board is
open. This browser also keeps capabilities for boards it created (and their
recent-list entries) in local storage so those links continue to work after a
refresh. Browser extensions, malware, or another person using the same browser
profile may therefore recover them. Use a separate trusted profile for
sensitive boards and remove recent entries before handing a shared device to
someone else.

Existing tokenized LevelDB rooms are registered on startup without renaming
their document keys. Direct token-bearing WebSocket URLs and tokenless legacy
rooms are disabled by default. `YJS_ALLOW_LEGACY_URL_TOKENS` and
`YJS_ALLOW_LEGACY_ROOMS` are migration switches, not production defaults.

## What a link holder can do

Every valid room session has raw read/write access to that room's Yjs document.
A custom client can inspect and submit arbitrary CRDT updates. The following
features are workflow controls for cooperating participants, not security
boundaries:

- admin status and the shared admin PIN;
- vote limits;
- board and zone editing locks;
- card hide/reveal state.

Presence is also untrusted. Display names, cursor/view data, and Yjs awareness
IDs are supplied by each participant. The non-secret `awarenessId` WebSocket
parameter only binds one claimed ID to one socket so relayed snapshots cannot
inflate memory or overwrite an active peer; it does not authenticate a person.
A malicious link holder can spoof presence fields or temporarily squat an
offline participant's ID.

When `showNonVoters` is enabled, vote results persist presence names in the
room document. Late joiners can see these historical names, and LevelDB backups
retain them. JSON/ZIP board exports omit these runtime result snapshots.

Hidden card text is omitted from the normal DOM and redacted from exports made
by non-owners. It is nevertheless synchronized in plaintext to every room
peer, so a malicious link holder can read it with a custom client. Do not put
secrets, credentials, personal data, or notes that other room participants
must not see into a hidden card.

## Server safeguards

The relay applies defense-in-depth controls for a publicly reachable service:

- exact Origin checks on room creation, session exchange, uploads, and
  WebSocket upgrades;
- signed room cookies and authenticated, room-bound WebSocket/upload/image
  paths;
- global, per-IP, per-room, and per-connection traffic, WebSocket-admission,
  cold-room hydration, and concurrency limits;
- request, header, upload, document, update, backlog, database, and storage
  quotas;
- bounded awareness identities/state, preflighted sync responses, and
  WebSocket egress budgets;
- a cross-room active-document memory budget, throttled update-log compaction
  and exact measurement, and hard byte/count caps on uncompacted persistence
  churn;
- streamed, atomic image uploads with size, MIME, and magic-byte validation;
- per-IP, per-room, and global image-read request/byte budgets;
- LevelDB failure detection, readiness failure, and peer shutdown instead of
  acknowledging state that cannot be persisted;
- keyed, truncated room identifiers in logs instead of raw capability tokens.

These controls protect isolation and availability. They cannot make an
authorized-but-malicious link holder safe within that holder's own room.

Room creation is intentionally anonymous. The in-process global, per-IP, room,
disk, and file-count limits bound one relay instance, but they do not prevent a
distributed attacker from consuming the finite room or upload capacity. Public
deployments must add edge rate limits or a managed challenge for room creation,
plus edge rate limits for uploads and authenticated image reads, and alert
before either persistent volume is full.

New image URLs are authenticated and room-bound. Historical `/images/<id>`
URLs remain unauthenticated compatibility capabilities: anyone who has one can
read that image. Retiring a room makes its new room-bound image URLs
unreachable, but does not erase image files or revoke historical legacy image
URLs. Treat legacy images as already disclosed and remove retained files only
as a deliberate, backed-up maintenance operation.

## Production requirements

- Serve the site only over HTTPS. Never enable `YJS_ALLOW_INSECURE_HTTP` in
  production.
- Direct `npm run yjs` starts on `127.0.0.1`; set `YJS_HOST=0.0.0.0` only
  inside an isolated container network or another deliberately protected
  network namespace.
- Set `YJS_ALLOWED_ORIGINS` to the exact public origin. Do not use a wildcard.
- Enable `YJS_TRUST_PROXY` only when direct access to the relay is impossible.
  The production Compose stack satisfies this by publishing no application
  ports and using Cloudflare Tunnel as the sole ingress.
- Keep both legacy switches off after any controlled migration window.
- Persist and back up the LevelDB volume, including `.room-session-key`, and
  the uploads volume together. Alternatively provide a stable secret of at
  least 32 bytes through `YJS_SESSION_SECRET`.
- Protect tunnel credentials outside the repository, restrict their file
  permissions, and rotate them if they have ever appeared in logs, commits, or
  shared artifacts.
- Keep the edge WAF and rate limiting enabled. Process-local limits reduce
  abuse but are not a substitute for distributed edge controls. Cover at least
  `/yjs/api/rooms`, `/yjs/api/room-session`, `/yjs/rooms/*/upload`, and
  `/yjs/rooms/*/images/*`, plus WebSocket upgrade bursts on `/yjs/rooms/*`;
  challenge responses must not be injected into the application's
  authenticated session, upload, image, or WebSocket requests.
- Keep `YJS_MAX_ACTIVE_DOCUMENT_BYTES` comfortably below the Yjs container
  memory limit. The production defaults allow 32 MiB per document but only
  96 MiB of conservative encoded state across all resident rooms, leaving
  headroom for decoded CRDT structures, persistence work, and sync buffers.
- Build and run the JavaScript services with the pinned Node.js 24 LTS image;
  do not release with an end-of-life runtime.
- Build the tunnel from the pinned upstream Cloudflare source commit in
  `Dockerfile.cloudflared`. Its dependency overrides close advisories that are
  still present in the vendor's `2026.8.3` container; remove the overrides only
  after a newer reviewed upstream release contains equivalent or newer fixes.
- Monitor `/yjs/readyz`, capacity responses (`429`, `503`, `507`), storage
  usage, restarts, and WebSocket policy closes.
- Run `npm test`, `npm run build`, the locked dependency audit, and the
  container smoke tests before each release. CI and Dependabot configuration
  are included in `.github/`.

The production CSP currently names `https://retro.sagonzis.space`. If the
public hostname changes, update both `nginx.conf` and `YJS_ALLOWED_ORIGINS`
before deploying.

## Incident handling

A leaked room link grants room access until the room is operationally retired;
there is no self-service rotation or revocation UI. Treat a suspected leak as a
board compromise: export only known-safe content, create a new room, share its
link through a trusted channel, and retire the old room with the one-shot
`YJS_WIPE_DOCS` maintenance setting after stopping writes and taking a backup.
The setting contains the canonical document name, which includes the secret,
so supply it through a protected deployment secret rather than shared shell
history or logs. Remove the setting immediately after the successful one-shot
restart. Separately review retained uploads as described above.

Do not include live room links, fragment tokens, cookies, board exports,
browser traces, or tunnel credentials in bug reports. Redact them before
sharing diagnostics.
