# Security model

## Supported deployment model

Retro Board supports a **publicly reachable host with private, trusted-link
rooms**. A room link is a bearer capability: anyone who receives the complete
link is a fully trusted collaborator for that room. Do not post room links in
public channels unless everyone who can obtain the link is intended to have
full board access.

This is not a multi-tenant identity or authorization system. There are no user
accounts, per-user ACLs, revocation, or server-enforced admin roles. Private
rooms shared with mutually untrusted participants are unsupported;
they would require authenticated identities and server-side authorization.
The separate Public Wall below deliberately accepts anonymous shared editing.

## Room capability and session flow

The optional [private maintainer console](docs/maintainer.md) has a separate
listener and owner key, disabled by default. Its status API exposes operational
metadata only. An authenticated owner can explicitly request a registered room
link through a same-origin POST and enter as a read/write collaborator. The
owner key therefore grants access to every registered room on that relay.
Room links are returned only for the selected room, never in status snapshots;
Public Wall entry never reveals its internal capability. Production
activation requires owner approval and loopback-only host publication, with
Tailscale Serve and owner-only tailnet policy for remote access.

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
- Persist and back up the LevelDB volume, including `.room-session-key` and
  `.account-session-key` (losing the latter only signs everyone out), and
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

The production CSP currently names `https://retroroom.party`. If the
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

## Accounts (optional Google sign-in)

Sign-in is optional. When it is off, every `/api/auth/*` and `/api/account*`
route answers 404 and nothing else changes. It is enabled only when the
Google client id, secret and redirect URI are all set, `YJS_ALLOWED_ORIGINS`
is non-empty and the relay is not the Public Wall relay.

- **Identity.** The account key is the Google `sub`, never the email. Scopes
  are exactly `openid email profile`; no other Google data is requested.
- **Stored fields.** Per account: id, Google `sub`, email, name (may be empty),
  plan, `planGrantedAt`, `sessionGeneration`, `createdAt`. They live as meta
  keys of one reserved document in the relay LevelDB (`acct:<id>`,
  `sub:<sub>`, `email:<lower-cased>`), written as one fsynced batch per change.
  Two Google identities may share an email, so `email:` lists every account
  id that holds it and maintainer lookup shows them all.
  A storage failure takes the relay down through the same path as rooms.
- **Single-use flows.** `start` sets a signed `rb_oauth_flow` cookie
  (`HttpOnly; SameSite=Lax; Max-Age=600`, `Path` limited to the auth routes,
  host-only) holding `state`, `nonce`, the PKCE verifier and the validated
  return URL. The callback checks the signature, query `state` and expiry,
  then claims `state` in an in-memory ledger exactly once; a replay fails. The
  return URL is re-validated against `YJS_ALLOWED_ORIGINS` before any redirect.
- **Token trust boundary.** The `id_token` is trusted because it comes from
  Google's fixed HTTPS token endpoint, with normal certificate validation, no
  redirects and a size cap. It is never accepted from the browser, so its
  signature is not checked against JWKS. Issuer, audience, expiry (with an
  upper bound), issued-at, nonce and `email_verified` are still checked. The
  endpoint can be overridden only when `YJS_ALLOW_INSECURE_HTTP` is on (dev).
- **Account cookie.** `rb_account`: `HttpOnly; SameSite=Lax; Max-Age=2592000`
  (30 days), `Secure` unless insecure dev, `Path=/yjs/api` in production. It is
  HMAC-signed with a key separate from the room-session key and carries the
  account id and `sessionGeneration`; the generation is checked against the
  store on every request, so "sign out everywhere" bumps it.
- **Request checks.** `POST /api/account/logout`, `logout-all` and `delete`
  require an allowed `Origin`. `GET /api/account` refuses a foreign `Origin`.
  Every auth and account response sets `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`. Start and callback share a per-IP limit and
  the flow ledger is bounded.
- **Logs.** Callback failures are counted by error code in the periodic
  rejection summary. Tokens, codes, cookies, query strings, emails and names
  are never logged.
- **Accounts and room access.** Room access is still the link and its session
  cookie, with one exception: signing in grants access to the rooms the account
  owns. "My boards" (`GET /api/account/rooms`) hands out working links, so
  anyone who takes over the Google account or its `rb_account` cookie can open
  every normal room that account owns. Locked rooms still need their password.
  The plan only gates account features (today: both plans may create locked
  rooms).
- **Ownership is not revealed.** Rename (`POST /api/account/rooms/<code>/title`)
  and delete (`.../delete`, body must repeat the code as `confirmCode`) answer
  404 for a room the account does not own, a room that does not exist and the
  Public Wall alike. Codes are never accepted without the account cookie. Both
  actions are rate limited per account (30 per minute) and re-check the cookie
  generation when admitted.
- **Owner delete is final for the live system.** The room is closed (socket
  close code 4004), its rows and uploads are removed, and a durable tombstone
  in the `retro-relay-deletions` document makes a crash finish the job on
  restart instead of resurrecting the room. Backups keep the room until they
  rotate out.
- **Guest-room expiry.** A room created without signing in, from this release
  on, is deleted 24 h after its last use. Legacy rooms, owned rooms, orphaned
  rooms (their account was deleted) and the Public Wall are never swept
  automatically; their 60-day retirement stays operator-triggered.
- **Account deletion.** Deleting an account removes its record and indexes. Its
  rooms are marked orphaned: they keep the 60-day rule, are never treated as
  guest rooms, and have no manager afterwards.

## Password-protected (encrypted) boards

A signed-in account may create a locked board that needs the link and a
password. Its content, presence and images are encrypted in the browser with
AES-GCM; the relay and the operator cannot read them. Normal boards, Poker and
the Public Wall are unchanged.

- **Keys.** The password is stretched in the page (PBKDF2-SHA-256, 600,000
  iterations, 16-byte salt) and split with HKDF into a key-encryption key and
  an `authKey`. A random 256-bit room key encrypts the board and is stored only
  wrapped by the key-encryption key. The password, derived keys and room key
  never reach storage, logs or URLs. `authKey` is sent over TLS in the body of
  session requests only. Reload asks for the password again.
- **What the relay stores and sees.** The lock record `retro-room-lock-v1`
  (salt, KDF parameters, verifier = SHA-256 of `authKey`, wrapped room key and
  IV, `keyEpoch`, `lockRevision`, owner account id, `createdAt`), an ordered
  log of ciphertext frames plus one client-written snapshot, encrypted image
  blobs (`<handle>.<uuid>.e2e` under uploads), and the plaintext registration
  seed that makes the room discoverable. It also sees ciphertext sizes,
  timing, blob sizes and connection metadata. It never sees the password, any
  key or any content. The relay never builds a `Y.Doc` for a locked room.
- **Online guessing.** A wrong `authKey` returns 403 and is counted: at most 5
  failures per 15 minutes per IP and room, and 50 per 15 minutes per room
  (rolling window; over the limit gives 429 with `retry-after`). A renewal
  that carries a room cookie still valid at the current key epoch gets 403
  but is not counted, so pages left open across a password change do not
  lock out their network. The counters are kept in relay memory only, so a
  relay restart or deploy resets them.
- **Offline guessing.** Anyone holding a backup or database copy plus the room
  link has the salt and verifier and can guess passwords offline, limited only
  by PBKDF2 cost. This is why the minimum is 10 characters. Treat backups of
  locked rooms as sensitive. Forgotten passwords cannot be recovered by anyone,
  including the operator.
- **Session binding.** The room cookie of a locked room is signed over
  `docName|e<keyEpoch>`. "Remove everyone" (key rotation) raises the epoch, so
  every old cookie gets 401 and open sockets close with 4001. A password change
  does not revoke sessions; only rotation does. Pages renewing with the old
  `authKey` get 403 and show the in-page unlock dialog without losing edits.
  Lock changes are serialised per room and carry `expectedRevision`, so a
  request authorised against an older lock fails with 409.
- **Rotation.** `rotate/begin` freezes appends for at most 120 s. `rotate/commit`
  writes snapshot, log prune, blob inventory and the new lock in one durable
  batch. A cancelled or expired freeze resumes all sockets; if the owner
  cancels while begin is still in flight, the room can stay frozen up to 120 s.
- **Limits of the scheme.**
  - A malicious or compromised relay can drop, delay or reorder frames.
  - It can replay ciphertext within an epoch, and serve an older snapshot or
    blob of the same epoch.
  - An authorized member can write a bad snapshot that prunes the log.
  - Revoked members keep the plaintext and keys they already had.
  - Security depends on the JavaScript the operator delivers; a malicious
    deployment could steal passwords.
- **Known residuals.**
  - Timed-vote expiry runs on clients: an elected finalizer acts at the
    deadline and others after a 10 s grace. Votes finish only while someone has
    the board open, and two clients with different partial views can both
    finalize.
  - After rotation, old images stay readable with the old key for a 24 h
    grace; an image nobody repaired by then becomes a broken-image placeholder,
    and undo after that shows it too.
  - Previous room keys stay in page memory until reload.
  - Encrypted presence can linger up to about 30 s for peers after an unclean
    close.
  - A locked room whose lock record is corrupt is kept but refuses sessions
    (503) until fixed by hand.

## Public wall

Public Wall is one intentionally public room for anonymous, mutually untrusted
writers. `/public` exchanges no capability: `POST /yjs-public/api/public-session`
uses the same exact Origin checks, session-exchange rate buckets and signed,
room-scoped HMAC cookies as private rooms. The internal room capability never
leaves the relay. `/` polls a geometry-validated read-only JSON preview every
10 seconds; it needs no room session or WebSocket. The JSON is publicly
cacheable for 10 seconds. Private sticky text is omitted from this preview;
this remains a display control, not confidentiality against room writers.

Run it as a separate relay process (`YJS_PUBLIC_WALL=true`), with a dedicated,
marked LevelDB directory/volume, memory limit and independent traffic/storage
budgets. Startup refuses an unmarked nonempty directory, provisions through
the existing RoomRegistry marker-last commit/quarantine path, and allows
exactly one registered room. Room creation, private capability exchange and
legacy image routes are disabled. Room-bound uploads require an exact Origin
and signed Public session; PNG/JPEG/WebP/GIF files retain the 5 MiB limit,
magic-byte checks, streamed atomic publication, rate limits and reservation
accounting used by private rooms. Public files additionally pass the shared
dimension/pixel/frame inspection before publication; animated PNG/WebP are
rejected and GIF animation stays within its frame and pixel budgets.
Public image reads need no session so the
landing preview can render them, and retain image-read byte/request budgets.
Only the active Public room handle is served. Legacy URL-token admission is
also disabled. The per-room admission mechanism caps connections at500; the
session endpoint returns 429 when full. Signed existing writers renew through
`POST /yjs-public/rooms/<handle>/public-session`, within the normal cookie
path, so a full wall does not prevent session renewal. Admission is checked again at the
WebSocket upgrade to close session/admission races.

The Public relay admits at most ten item creations per IP in any rolling
60-second window, including at most one new image. Image creation also counts
toward the ten-item limit; edits, existing-image updates, and deletions do not.
Bulk transactions count each created item. The relay validates updates before
applying them, including updates from custom clients. These in-memory budgets
are shared by everyone behind the same trusted IP and reset on relay restart;
they are not an identity system or protection against distributed abuse.
Supported clients negotiate a quota message on their Public WebSocket; the relay
sends the current per-IP budget and acknowledges accepted local creations so
the client can reject excess creations before changing its Y.Doc. Legacy
clients remain compatible and do not receive these messages. Concurrent
creation on the same IP can still race the budget update; if an update is
rejected, the client stops reconnecting and warns that its local changes have
not been shared. Users can copy needed content before reloading to rejoin with
the canonical board. The policy maintains an in-memory
shadow Y.Doc for preflight, increasing relay memory and update-processing cost.


Maintenance prunes excess items to 1,500 in one `public-prune` transaction.
Oldest means ascending client-supplied `createdAt` milliseconds, then item ID;
Missing, invalid, and more than 60 seconds in the future timestamps sort first.
Writers can still forge plausible dates within that bounded clock skew. The cap bounds
live items after maintenance, not the entire CRDT history or arbitrary metadata;
the relay's existing byte, persistence and traffic quotas remain essential.

Changed encoded document states are atomically snapshotted hourly, retaining
at most 48 files and 256 MiB in the public data directory. Oldest files are
removed before/after writes to enforce the separate history byte budget.
`scripts/public-wall-restore.sh` accepts
only a marked public directory and a snapshot within it. LevelDB's exclusive
lock refuses restoration while that relay is running. Restore publishes the
complete snapshot as a new document and room handle through RoomRegistry's
marker-last creation path, then quarantines/removes the previous room. Stale
handles/cookies are rejected; the public client re-establishes its session and
reloads a fresh Y.Doc rather than reconnecting its old replica to the new handle.
Stop the public relay before restoration. If interrupted between publication
and retirement, startup fails closed on the two-room invariant for operator
recovery.
Hourly snapshots are recovery points, not an off-volume backup. Their bytes
have a separate 256 MiB history budget; the public database quota excludes
only the root snapshots directory. Retention may therefore be fewer than 48
large states. Production Public uploads are isolated on the operator SSD at
`/Volumes/ssd-fluke/BaseData/retro-board/public-wall-uploads`; a missing host
directory prevents Compose startup. Each room has 5 GiB / 10,000 retained
image files, within an 8 GiB / 50,000 file relay budget. Encoded CRDT limits
remain separate. Removing a card does not reclaim its retained upload.
Off-volume backups include private data/uploads and public data/uploads;
verification checks referenced public image files as well as both databases.

Residual risk: anyone can edit or delete others' cards, including clearing
all items with a custom client. All Public writers can use the shared board
tools, including import/export, locks, reveal, voting/timers and confirmed
clearing/resetting. These actions have no owner/PIN gate in Public; private
room owner/PIN behavior is unchanged. Admin claiming and transfer remain
private-room concepts. UI locks are workflow controls, not a server ACL. Snapshots
support owner recovery but cannot prevent deliberate vandalism or content
abuse. Public content must not contain secrets or personal data.
