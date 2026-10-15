<!-- Canonical agent instructions for Claude and Codex. CLAUDE.md imports this file; edit only here. -->
# RetroBoard

Real-time collaborative retro board: React 18 + Vite client, Yjs CRDT over `y-websocket`, Node relay `yjs-server.mjs` with LevelDB persistence. Production is publicly reachable (`retro.sagonzis.space`) through Cloudflare Tunnel only.

Read before touching the matching area (sections only, not whole files):
- Domain terms and data invariants: `CONTEXT.md`
- Security model, room capability/session flow: `SECURITY.md`
- Release gate, deploy, backups, capacity: `DEPLOYMENT.md`

## Commands

```sh
npm ci --ignore-scripts --no-audit --no-fund   # install (Node 24, same as CI and images)
npm run yjs:dev                                # relay for local dev (insecure HTTP, localhost origins)
npm run dev                                    # Vite client on :5173
npm test                                       # node --test src/*.test.js *.test.mjs
npm run build                                  # production bundle
```

Release gate (full list, run from a clean checkout): `DEPLOYMENT.md` §Release gate. Backup/verify/image-scan: `scripts/backup-production.sh`, `scripts/verify-production-backup.sh`, `scripts/scan-production-images.sh`. Use these; do not write new ad-hoc versions.

## Code structure (all new code)

- `RetroBoard.jsx` (4505 lines) and `yjs-server.mjs` (2241 lines) are frozen in size: do not add logic to them. They only wire. Put new behaviour in a focused module under `src/` (pure `.js` for logic, `.jsx` for components) with a paired `src/<module>.test.js`; relay changes get a module plus `*.test.mjs`. Moving existing logic out of the two big files is welcome; growing them is not. `src/rule-ratchets.test.js` enforces the ceilings and colour-literal rule; ceilings may only be lowered.
- Pure logic stays out of components: geometry, voting, ownership, import/export, schema decoding are plain functions the component calls (see `board-geometry.js`, `vote-finalization.js`, `board-ownership.js`).
- UI follows the Warm Studio direction, token-first: colours, radii, fonts and shadows come from `src/theme.js` CSS-variable tokens (extend them there) and shared UI primitives extracted into `src/` as they are needed, never new inline literals. No tape on stickies; keep functional signals (selection `#2563eb`, gold top-3 glow, zone colours). Reference tokens: `warmLook()` in https://claude.ai/artifact/Y62Xiyyi6a6zN2sYtY8aMF
- Every user-visible string goes through `t()` with keys added to **both** `th` and `en` in `src/i18n.js`.

## Data invariants

- Yjs room state is canonical, not a render fallback. Item geometry is finite and bounded; zones have positive bounded `w`/`h` (`CONTEXT.md`).
- A backup manifest must pass the same decoder used by import, with no repair or information loss: export → import round-trips exactly. Untrusted imports reject explicit invalid values.
- Collaboration changes must keep undo/redo, local-optimism guards and remote presence correct; these broke before (`c879817`, `26bc4c5`).

## Verifying work

Unit tests are necessary but not sufficient for UI or sync changes. Run `yjs:dev` + `dev`, open the board in **two** browser contexts (global `playwright` 1.64 at `/opt/homebrew/bin/playwright`; `playwright-cli` is not installed) and confirm the edit syncs both ways, undo/redo still works, and both `th` and `en` render. Report what you exercised.

## Needs owner approval (prepare, then stop)

- Any production deploy or `docker compose -f docker-compose.prod.yml` create/recreate/down.
- Edits to `cloudflared*.yml`, `nginx.conf` CSP, `YJS_ALLOWED_ORIGINS`, `docker-compose.prod.yml` security settings, `.github/workflows/`.
- Reading or changing `.env`, tunnel credentials, `~/.config/retro-board/backup.key`.
- Deleting or rewriting `yjs-db/`, `uploads/`, production volumes, or restoring a backup.
- Dependency upgrades that change pinned runtime/base images.
