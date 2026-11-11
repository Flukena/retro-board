# Encrypted rooms rollout

Status: **prepared, awaiting owner approval.** Nothing here has been run
against production. Branch `feat/room-lock-e2e`.

## What ships

- Signed-in users can create a password-protected board. Content, presence and
  images are encrypted in the browser; the relay stores ciphertext only.
- Owner controls: change password, "remove everyone" (key rotation).
- New relay routes and an encrypted socket at `/yjs/rooms/<handle>/e2e`;
  encrypted image files `<handle>.<uuid>.e2e` under uploads.
- Privacy text updated in all 11 locales (effective date 2026-11-08), plus
  SECURITY.md, CONTEXT.md and DEPLOYMENT.md.
- Normal boards, Poker and the Public Wall behave as before. `yjs-public` is
  unchanged.

## Owner-approval items

- The deploy itself (yjs and web recreate).
- No change to `cloudflared*.yml`, `nginx.conf`, `docker-compose.prod.yml` or
  `.github/workflows/` is needed: the tunnel routes `^/yjs(/.*)?$` to
  `yjs:1234` already, and the relay's pending-store default (32 MiB) equals the
  document cap (32 MiB). If either is ever lowered, raise
  `YJS_MAX_PENDING_STORE_BYTES` to at least `YJS_MAX_DOCUMENT_BYTES`.

## Deploy plan

Work dir: `/Volumes/ssd-fluke/BaseData/retro-board/room-lock-e2e-<date>/`.

1. Release gate on a clean `git archive` of the release commit `<sha>`
   (`npm ci --ignore-scripts --no-audit --no-fund`, `npm test`,
   `npm run build`, maintainer build, `npm audit --audit-level=high`). Log to
   `release/gate.log`.
2. Build images `miro-release-yjs:e2e-<sha>` and `miro-release-web:e2e-<sha>`
   with `--pull --no-cache`; scan with
   `COMPOSE_FILE=release/scan-images.yml sh scripts/scan-production-images.sh`.
3. Backup and verify before deploy (`scripts/backup-production.sh`, then
   `scripts/verify-production-backup.sh`). Verification now includes encrypted
   rooms; before this release there are none.
4. Fast-forward the main checkout (the Compose working directory) to `<sha>`.
5. Pin the two images in `deploy.yml` (re-pin `yjs-public` and `cloudflared`
   unchanged), then:
   `docker compose -f docker-compose.prod.yml -f ~/.config/retro-board/maintainer/compose.yml -f deploy.yml up -d --no-deps --no-build yjs web`.
   Never add `--remove-orphans`: it would delete `miro-maintainer-gateway-1`.
   Confirm only `miro-yjs-1` and `miro-web-1` were recreated.
6. Smoke, in two browser contexts on production:
   - a normal board still opens, edits sync both ways, undo/redo works;
   - Google sign-in works;
   - create a locked board (password of 10+ characters, checkbox);
   - wrong password is refused, right password opens the board;
   - an edit syncs both ways between two browsers; reload asks for the password;
   - add an image and see it in the second browser;
   - change the password; the other browser unlocks with the new one;
   - "remove everyone": the other browser must unlock again, images still show;
   - `en` and `th` render; the privacy page shows the new sentence.

## Rollback

Put `image: miro-release-yjs:signin-e2d1ab7` and
`image: miro-release-web:signin-e2d1ab7` in `deploy.yml`, then run the same
command from step 5.

Effect on locked boards while the old relay runs: **they are closed, not
open.** This release writes registration marker `2` for a locked room
(`LOCKED_REGISTRATION_MARKER`) and keeps `1` for normal rooms; existing
production rooms keep `1` and are unchanged. The old relay at `e2d1ab7`
serves a document only when its marker is exactly `1`
(`src/server/relay-room-registry.js` lines 24 and 142-147), so it quarantines
every locked room at startup: the session exchange answers 404 (`yjs-server.mjs`
lines 1039-1044) and so does the WebSocket upgrade (lines 1664-1666). Its only
other way to reach a document by name needs both `YJS_ALLOW_LEGACY_ROOMS` and
`YJS_ALLOW_LEGACY_URL_TOKENS` (lines 1672-1676). `docker-compose.prod.yml`
sets neither; the relay's env file was not read for this note, so confirm
both are unset there before a rollback.
The old relay deletes nothing it quarantines: `retireIdleRooms` only visits
registered rooms and `YJS_WIPE_DOCS` is unset, so every locked room's lock,
log, snapshot and `.e2e` files stay as they were. Re-deploying this release
serves the locked rooms again, with their passwords. Checked by hydrating a
LevelDB written by this release with the `e2d1ab7` registry: the locked room
was not served, the normal room was, and the new registry served the locked
room again afterwards. Normal boards are unaffected in both directions.
