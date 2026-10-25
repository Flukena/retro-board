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
npm test                                       # recursively discovers root/src/scripts tests
npm run build                                  # production bundle
```

Release gate (full list, run from a clean checkout): `DEPLOYMENT.md` §Release gate. Backup/verify/image-scan: `scripts/backup-production.sh`, `scripts/verify-production-backup.sh`, `scripts/scan-production-images.sh`. Use these; do not write new ad-hoc versions.

## Code structure (all new code)

Read `ARCHITECTURE.md`. Put browser features in `src/client/`, portable rules in
`src/domain/`, and relay behavior in `src/server/`; dependencies point toward domain.

- `RetroBoard.jsx` (4177 lines) and `yjs-server.mjs` (1881 lines) are frozen in size: do not add logic to them. They only wire. Put new behaviour in a focused module under `src/` (pure `.js` for logic, `.jsx` for components) with a paired colocated `<module>.test.js`; relay changes get a module plus `*.test.mjs`. Moving existing logic out of the two big files is welcome; growing them is not. `src/rule-ratchets.test.js` enforces the ceilings and colour-literal rule; ceilings may only be lowered.
- Pure logic stays out of components: geometry, voting, ownership, import/export, schema decoding are plain functions the component calls (see `board-geometry.js`, `vote-finalization.js`, `board-ownership.js`).
- UI follows the Warm Studio direction, token-first: colours, radii, fonts and shadows come from `src/client/ui/theme.js` CSS-variable tokens (extend them there) and shared UI primitives extracted into `src/` as they are needed, never new inline literals. No tape on stickies; keep functional signals (selection `#2563eb`, gold top-3 glow, zone colours). Reference tokens: `warmLook()` in https://claude.ai/artifact/Y62Xiyyi6a6zN2sYtY8aMF
- Every user-visible string goes through `t()` with keys added to **both** `th` and `en` in `src/client/ui/i18n.js`.

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

<!-- SHARED_RULES_START (generated from ~/.claude/coding-standards.md; do not edit here) -->
<!-- Single source for the per-repo coding rules (Claude + Codex). Edit ONLY this file.
     NOT global (owner 2026-10-22): copied into the AGENTS.md of the repos listed in
     ~/.claude/hooks/sync-shared-rules.py TARGETS, between SHARED_RULES markers
     (auto on Edit/Write; after a shell edit run it with --now).
     Provenance: ~/.claude/docs/rules-history.md -->
# Coding standards (shared by Claude and Codex)

## Code shape (hard rule)
Every implementation, fix, refactor and test, in all repos and roles (including Codex prompts and subagents):
- Sonar-clean (SonarQube/SonarLint): no new issues regardless of existing ones — no smells, bugs, vulnerabilities, security hotspots, duplication, unused vars, magic numbers, broad catches, hardcoded secrets or resource leaks; cognitive complexity ≤15 per function.
- Types (classes/structs/enums/traits) own invariants; readable, long-lived code; small single-purpose functions.
- Shared layer: multi-caller logic belongs in ONE neutral module/trait; never copy-paste per caller.
- Helpers: name repeated snippets; reuse existing helpers/constants first.
- Constants: no magic numbers/strings; name every bound, interval, cap and label with its unit in the name (e.g. `POLL_INTERVAL_MS`); add a comment only for a non-obvious source (spec/ICD/plan line).
- One-way dependencies, top → down: no lower-to-owner/caller calls, parent callbacks, back-references (e.g. Rc/Weak or a stored parent handle), circular imports or module cycles. Report upward only by return, event/message, or interface/trait owned by the lower layer. A coordinator calls mutually dependent peers.
- Imports at the top, never mid-file or left behind by moved/deleted blocks. Inline only to break a circular dependency; comment why.
- Report duplication/cycles you could not remove in files you own.
- Never silence a gate to pass: no new `noqa`/`NOSONAR`/`type: ignore`/`#[allow]`, `skip`/`xfail`, raised ratchet baselines or lowered coverage/quality thresholds. If a rule looks wrong, report it with the reason.
- Reuse tooling first: check the repo's `scripts/` (and its script catalog, if any) before writing a probe/check script. A new script likely to be reused goes in `scripts/` and its catalog entry.

## Tests (hard rule)
- No tautological tests: never mock the unit under test, and never copy the code's current output into the expected value. Assert behaviour derived from the spec/contract.
- A test must fail when the code is wrong: for every fix, revert the fix (or run the test before it) and confirm the test fails; state that you did.
- Bug fixes: reproduce on the source that actually matters (current `main`, or the release snapshot that is live) before editing; if it no longer reproduces, report that instead of fixing. Group reports that share a root cause and fix the cause once.

## Logging and disk writes (hard rule)
Goal: minimal bytes and write ops per useful line, so SSD/HDD wear stays low. Applies to any code that writes logs, state or captures to disk.
- Batch, don't drip: buffered/async writes through a bounded queue, flushed by size or interval; no per-line flush or fsync for diagnostic logs. Flush at once on WARN+ and at shutdown so crash context survives. Queue full → drop and count, never block the caller.
- fsync only durable records (ledgers, audit, execution evidence), group-committed; they are data, not logs, so never remove their existing durable-write path.
- Write less: production level INFO; DEBUG only temporarily. No per-tick/per-message lines on hot paths; rate-limit or sample repeated lines (never ERRORs or ledger events) and log the suppressed count. State/snapshot files are rewritten only on change and throttled, atomically (temp + rename), never every loop.
- Append-only; never rewrite or truncate a log in place.
- Every file sink has size-based rotation, compression of rotated files and retention; every container sets log `max-size`/`max-file`.
- Location: logs, captures and bulk data follow §Data location below.
- Never log secrets, tokens, keys, signed payloads or personal data.
- New machine-read logs are JSON with UTC ISO-8601 timestamps and short keys; otherwise keep the repo's existing format. Human-only logs stay compact text, not JSON (fewer bytes written).

## Data location (hard rule)
Logs, long probes/captures and bulk datasets go to one of two data volumes, per-task folder (e.g. `<root>/<project>/<probe>-<YYYYMMDD>/`):
- Fast/frequent writes (high write rate, hot captures, data read back often) → `/Volumes/ssd-fluke/BaseData`.
- Infrequent writes, speed not needed (archives, occasional logs, cold datasets) → `/Volumes/BaseDisk/Base`.

Never internal disk, repo trees, `/tmp` or scratchpad. Chosen volume unmounted → stop/report, no fallback to the other. Claude also symlinks each new task folder at `~/basedata/<project>/<task>` (outside repos). Small throwaway temp files use the session scratchpad (Codex: its sandbox temp).

## Long runs (hard rule)
- Long builds/tests (`cargo`, `pytest`, probes): run them as ONE blocking command with output redirected to a file and the longest yield/timeout the tool allows, then read only `tail`/`rg` of that file. Do not poll with repeated `write_stdin`/`sleep`, because every poll re-sends the whole context. Use quiet flags (`-q`, `--quiet`, `--message-format short`) and filter for failures.

## Karpathy guidelines (hard rule)
1. Think first: state assumptions and competing interpretations; push back when a simpler approach exists; stop and ask when unclear.
2. Minimum solution: no speculative features, single-use abstractions, unnecessary configurability or impossible-scenario handling.
3. Surgical edits: touch only what the task needs, match style, leave adjacent code/comments/formatting and pre-existing dead code alone; remove only your own new orphans.
4. Define verifiable success criteria; multi-step work gets a brief plan with checks.

## Reviews
Every review (Claude or Codex, whoever wrote the code) checks every rule in Code shape, Tests, Logging and disk writes, Data location and Karpathy guidelines, plus repo style and failure-path tests. Each violation is a finding. End the review with a `RULE CONFORMANCE` section: one line per rule, PASS / FAIL → finding / N/A.
<!-- SHARED_RULES_END -->
