# Room management rollout

Status: **prepared, not deployed.** Needs owner approval before any step below
touches production.

## What ships

- Signed-in owners get a "My boards" dialog (account menu): list their rooms
  with working links, rename, and permanently delete (type the code to confirm).
- Rooms created from this release on record an owner. Guest rooms (created
  without signing in) are deleted 24 h after last use by an hourly sweep.
- Owner delete uses a durable tombstone (`retro-relay-deletions`) so a crash
  never resurrects a room.
- Legacy rooms (about 200 in production) and owned rooms are never swept
  automatically; their 60-day retirement stays operator-triggered.
- Privacy text updated in all 11 locales; SECURITY.md, CONTEXT.md and
  DEPLOYMENT.md updated.

## Owner-approval items

1. **The deploy itself** (yjs and web recreate). First gate: no step runs
   without the owner's go-ahead.
2. **`LEGAL_EFFECTIVE_DATE_ISO`** is pinned to the deploy date `2026-11-17`
   in `src/client/legal/legal-content.js` and its pin test in
   `src/client/legal/LegalPage.test.js`.
3. No change to `cloudflared*.yml`, `nginx.conf`, `docker-compose.prod.yml` or
   `.github/workflows/` is needed.

## Deploy plan

Work dir: `/Volumes/ssd-fluke/BaseData/retro-board/room-management-<date>/`.

1. Release gate on a clean `git archive` of the release commit `<sha>`
   (`npm ci --ignore-scripts --no-audit --no-fund`, `npm test`,
   `npm run build`, maintainer build, `npm audit --audit-level=high`). Log to
   `release/gate.log`.
2. Build images `miro-release-yjs:rooms-<sha>` and `miro-release-web:rooms-<sha>`
   with `--pull --no-cache`; scan with
   `COMPOSE_FILE=release/scan-images.yml sh scripts/scan-production-images.sh`.
3. Record the room count (`rooms-before.txt`), then backup and verify
   (`scripts/backup-production.sh`, `scripts/verify-production-backup.sh`).
4. Fast-forward the main checkout (the Compose working directory) to `<sha>`.
5. Pin the two images in `deploy.yml` (re-pin `yjs-public` and `cloudflared`
   unchanged), then:
   `docker compose -f docker-compose.prod.yml -f ~/.config/retro-board/maintainer/compose.yml -f deploy.yml up -d --no-deps --no-build yjs web`.
   Never add `--remove-orphans`: it would delete `miro-maintainer-gateway-1`.
   Confirm only `miro-yjs-1` and `miro-web-1` were recreated.
6. Smoke:
   - **the room count right after deploy equals the count before**
     (`rooms-after.txt`); no existing room was retired;
   - a normal board opens, edits sync both ways in two browser contexts,
     undo/redo works; `en` and `th` render; the privacy page shows the new
     retention sentence and date;
   - signed in: create a board, see it in "My boards", rename it (the other
     browser sees the title), delete it (the other browser is closed out, the
     link then answers 404);
   - a guest room is created (201); it is not swept within the hour.

## Rollback

Before rolling back, confirm the new relay has been up for at least one
maintenance tick (1 minute) and that its log since the last start has no
`[yjs] room deletion recovery failed` line. This check catches failed
recoveries only: a deletion still waiting on in-flight work logs nothing.
A pending deletion is safe under the old relay anyway (see below); the
check only keeps its rows from sitting on disk longer than needed.

Put `image: miro-release-yjs:e2e-c23f18c` and
`image: miro-release-web:e2e-c23f18c` in `deploy.yml`, then run the same
command from step 5. Web and yjs are replaced together, so the old relay
rejecting the new client's `{kind}` create body only matters during the deploy
window.

Effect while the old relay runs:

- It ignores the owner meta `retro-room-owner-v1`, so it neither lists nor
  protects owned rooms, and it never runs the guest sweep.
- The `retro-relay-deletions` document is a new LevelDB document the old relay
  does not read; leave it in place.
- Rooms deleted before the rollback stay deleted: a deletion writes its
  journal entry and removes the room's registration marker in one fsynced
  batch, and the old relay registers a room only by that marker. A deletion
  still pending (a crash before it finished) is quarantined by the old relay
  (`[yjs] quarantined incomplete room`); its rows and files stay on disk
  until the new relay is back and its recovery finishes the deletion. This
  holds only while `YJS_ALLOW_LEGACY_ROOMS` stays off, as in production.
  Restore deleted rooms only from a backup.
- Guest rooms created meanwhile fall back to the 60-day rule.

## Deployment record

Not deployed yet. Fill in after approval, in the structure of
`2026-11-08-room-lock-e2e-rollout.md` (gate, images and scan, backup, deploy
containers before/after, smoke, rollback file).
