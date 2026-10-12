# Production deployment

This stack is intended for a publicly reachable HTTPS host with trusted-link
rooms. Read `SECURITY.md` before deploying; an open room containing mutually
untrusted participants is outside the supported security model.

## One-time setup

1. Copy `.env.example` to `.env` and point
   `CLOUDFLARED_CREDENTIALS_FILE` at the tunnel credential JSON. Keep that JSON
   outside version control and restrict it to the deployment account.
2. Copy `cloudflared.prod.example.yml` to the ignored
   `cloudflared.prod.yml`. Set its tunnel ID and hostname.
3. Set the same exact HTTPS origin in `YJS_ALLOWED_ORIGINS` in
   `docker-compose.prod.yml`. If the hostname is not
   `retro.sagonzis.space`, also replace the explicit WebSocket origin in
   `nginx.conf`'s Content Security Policy. Before retaining HSTS
   `includeSubDomains`, verify that every child of the chosen public hostname
   is HTTPS-capable.
4. Configure Cloudflare edge rate limiting or a managed challenge for
   `/yjs/api/rooms`, and rate-limit `/yjs/api/room-session`,
   `/yjs/rooms/*/upload`, `/yjs/rooms/*/images/*`, plus WebSocket upgrade
   bursts on `/yjs/rooms/*`. Do not configure an interactive challenge on
   authenticated session, upload, image, or WebSocket routes: the app expects
   the relay's response, not an HTML challenge page. Local limits bound one
   process, but anonymous room creation and authenticated traffic still need
   distributed abuse protection at the public edge.
5. Arrange encrypted, access-controlled backups of both `yjs_data` and
   `yjs_uploads`. The LevelDB backup must include `.room-session-key` and be
   restored together with uploads.

The bundled backup command stops only Yjs long enough to capture both named
volumes at one point in time, encrypts the archive with GPG AES-256, checks that
it decrypts, and restarts the original Yjs container even on failure. Create a
random passphrase file with mode `600` outside the repository, then run:

```sh
BACKUP_KEY_FILE=/absolute/path/to/backup.key ./scripts/backup-production.sh /absolute/backup-directory
BACKUP_KEY_FILE=/absolute/path/to/backup.key ./scripts/verify-production-backup.sh /absolute/backup-directory/retro-board-YYYYMMDDTHHMMSSZ.tar.gpg
```

The verification command extracts to a temporary directory, opens the restored
LevelDB, and decodes every document. Keep the passphrase separately from the
encrypted archives and copy archives to a different machine or storage account;
a backup that exists only on the Docker host does not cover host failure. Run
verification periodically and before a risky migration or release.

Never enable `YJS_ALLOW_INSECURE_HTTP`, `YJS_ALLOW_LEGACY_URL_TOKENS`, or
`YJS_ALLOW_LEGACY_ROOMS` in normal production operation. Enable a legacy flag
only for a bounded migration, then remove it.

## Release gate

Run these checks from a clean release checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
npm audit --audit-level=high
docker compose -f docker-compose.prod.yml config --quiet
docker compose -f docker-compose.prod.yml build --pull --no-cache volume-init yjs web cloudflared
./scripts/scan-production-images.sh
```

Scan the exact locally built images that will be deployed; a successful CI
build is not a substitute for this step because Alpine security packages are
refreshed during each image build. For a mature release pipeline, push, sign,
and promote the already-scanned CI image digests instead of rebuilding them on
the production host.

The pinned JavaScript build/runtime image is Node.js 24 LTS. The tunnel image
is built from Cloudflare's immutable `2026.8.3` source commit with a verified
archive checksum and narrowly updated Go security dependencies; CI scans every
runtime image and rejects unfixed High or Critical findings. Re-resolve and
review source, dependency, action, and base-image pins during planned
maintenance; do not downgrade to an end-of-life runtime.

The Compose defaults cap each encoded document at 32 MiB and all resident
documents together at 96 MiB inside the 768 MiB Yjs container. If these values
are changed, budget for decoded CRDT overhead and sync buffers as well as raw
wire bytes. Do not lower the one-minute compaction/measurement intervals for a
public deployment without load-testing adversarial churn.

Review `git status --short` before release. Do not upload browser traces, board
exports, local uploads, `.env` files, or tunnel credentials as build artifacts.

Deploy only after the edge hostname, exact Origin allowlist, tunnel route, and
backups have been verified. The production Compose file publishes no host
ports; Cloudflare Tunnel is deliberately the sole ingress.

```sh
docker compose -f docker-compose.prod.yml up -d --no-build
docker compose -f docker-compose.prod.yml ps
```

On an existing installation, keep the same Compose project name during build,
scan, and deploy so Docker reuses the existing named data volumes. Changing
the project name creates different volumes and can make persisted boards appear
missing.

After recreating the stack, inspect it rather than assuming the Compose policy
was applied: application services must have no published host ports, run as
non-root, use a read-only root filesystem, drop Linux capabilities, and reach
the public network only through the pinned tunnel container.

Verify the application flow through the public hostname: create a room,
exchange its link in a separate browser profile, synchronize an edit, upload
and load an image, then confirm an invalid link cannot open a WebSocket.

## Capacity profile

Production loads `config/room-capacity.env`. The supported test envelope is
32 WebSocket connections per room (one tab uses one connection), with 64
connections per IP for shared office networks. This replaces the previous
untested 64-connection room admission limit. It is not a claim of unlimited
simultaneously busy rooms or browser rendering capacity.

The profile budgets for each client sending 10 combined cursor/view updates
and approximately 17 small geometry edits per second. Broadcasts cost one
send per recipient: 32 clients can generate about 864 inbound messages and
27,648 outbound sends per second. Room budgets are 1,024 inbound and 32,768
outbound messages/second, with bounded bursts. Global budgets are shared by
all rooms. Existing per-sender limits, byte quotas, document/memory limits,
invalid-session limits, sync-response limits, and persistence-backlog limits
remain in force.

The 65,536 uncompacted-update ceiling allows a minute of small concurrent
drags; the 24 MiB uncompacted-byte ceiling and 60-second compaction interval
remain unchanged. Large selections, images, unusually large awareness states,
maximum-size boards, and many simultaneously busy rooms can still reach other
limits. All clients need the deployed own-identity awareness filter and 100ms
combined motion publisher; old tabs must refresh.

The `32 application providers` integration test reads this exact profile,
exchanges separate sessions from one IP, seeds approximately 1 MiB of text,
and runs 32 providers with motion and independent 60ms document writes for
70 seconds. It checks continuous membership, final convergence, repeated
compaction, persisted final values, and restart/session readiness. A separate
flooding-sender test checks that the per-connection safeguard still disconnects
the offender without evicting a healthy peer. Run it against the production
Node image with the same 1.5 CPU / 768 MiB resource limits before increasing
these settings. This validates transport and persistence, not rendering a
large number of board items in 32 browsers.

Changing this env file requires recreating **only Yjs** with the already
verified image (`up -d --no-deps --no-build yjs`). It briefly disconnects all
rooms. Agree an operational pause with active users first, let edits sync,
and preserve the old effective environment as a Compose override for rollback.
A rollback also recreates Yjs; do not restart the tunnel or change named volumes.
Afterwards verify readiness, the effective environment, unchanged web/tunnel
container IDs, and graceful-drain/startup logs.

## Operations

Portable board exports use a ZIP archive up to 1 GiB containing `board.json`
and binary raster files under `images/`. Image bytes are stored once per source
without base64. Import reads the manifest first and uploads one image at a time;
the archive is never decoded as a single JSON string or sent through WebSocket.
Existing JSON (up to 256 MiB) and CSV (25 MiB) imports remain supported.
Each image still has a 5 MiB limit and the normalized board update a 1 MiB limit.
Production upload storage allows 2 GiB / 10,000 files per room and 8 GiB / 50,000
files globally. Retained images from past imports also count toward these quotas.

Monitor `/yjs/readyz`, container restarts, both persistent-volume usage, room
count, and bursts of `429`, `503`, or `507` responses. Alert with enough free
space to intervene before a configured quota or filesystem limit is reached.
A readiness failure means the relay has stopped accepting work to avoid
acknowledging data it cannot persist.

Before any one-shot LevelDB migration or room retirement, stop writes and take
a volume backup. Never put a live room token directly into an issue, shell
history shared with others, or centralized log field. Supply `YJS_WIPE_DOCS`
through a protected deployment secret, remove it after the successful one-shot
restart, and verify the old capability and opaque handle are rejected. A room
wipe does not delete upload files; authenticated room-bound URLs become
unreachable, while historical `/images/<id>` compatibility URLs remain public
until their files are separately removed under an explicit retention process.

The room capability remains in the URL fragment while the board is open, and
creator capabilities are retained in that browser profile for refresh/recent
navigation. Use a trusted profile and clear recent entries before sharing the
device.
