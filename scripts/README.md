# Script catalog

- `backup-production.sh` — Encrypt a consistent production database/uploads backup; requires owner approval to stop production Yjs and an existing backup key.
- `verify-production-backup.sh` — Decrypt a backup into scratch storage and verify its LevelDB documents open.
- `scan-production-images.sh` — Scan source secrets, container configuration and production images with pinned Trivy.
- `ui-live-check.mjs` — Check landing/board appearances, two-user sync and undo/redo using global Playwright; writes nine screenshots and `report.json` under BaseData. Start the Vite/relay servers as documented in its header, then run `node scripts/ui-live-check.mjs --base-url http://127.0.0.1:5180 --out <BaseData>/<task>/<run>`. Each run creates one board, so raise the relay's per-IP room-create limit (header shows the env) for repeated local runs; use `--strict-console` to fail on console errors or `PLAYWRIGHT_MODULE` to override module resolution.

- `relay-hydration-probe.mjs` — Seed a board with 15,000 item maps/texts, then measure cold LevelDB hydration in a fresh process (heap checkpoints plus GC before sizes, and RSS high-water mark). Requires an existing `RB_PROBE_DIR` on the operator-selected bulk storage; retains database and worker logs there. Run `RB_PROBE_DIR=<BaseData>/<task>/probe node --max-old-space-size=432 scripts/relay-hydration-probe.mjs`. Reports Node/V8 limits, encoded bytes, observed peak heap/RSS, and per-phase memory.
