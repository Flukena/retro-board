# Script catalog

- `backup-production.sh` — Encrypt a consistent production database/uploads backup; requires owner approval to stop production Yjs and an existing backup key.
- `verify-production-backup.sh` — Decrypt a backup into scratch storage and verify its LevelDB documents open.
- `scan-production-images.sh` — Scan source secrets, container configuration and production images with pinned Trivy.
- `ui-live-check.mjs` — Check landing/board appearances, two-user sync and undo/redo using global Playwright; writes nine screenshots and `report.json` under BaseData. Start the Vite/relay servers as documented in its header, then run `node scripts/ui-live-check.mjs --base-url http://127.0.0.1:5180 --out <BaseData>/<task>/<run>`. Each run creates one board, so raise the relay's per-IP room-create limit (header shows the env) for repeated local runs; use `--strict-console` to fail on console errors or `PLAYWRIGHT_MODULE` to override module resolution.
