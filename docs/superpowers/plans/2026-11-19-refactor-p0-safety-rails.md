# Refactor P0 Safety Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the live-check runner, five new live checks, the baseline manifest, the `window.storage` and undo/observer unit guards, the new ratchets and the mechanical cleanup, with ZERO production behaviour change, so P1+ moves have a net under them.

**Architecture:** Tooling and tests first, production edits last. Live checks stay manual Playwright scripts (not in CI, not in `npm test`); a new sequential runner starts isolated servers from a committed manifest, runs one check at a time under a hard timeout, kills only what it started and proves the ports are free. Unit guards use the real `storage-bridge.js` through one shared vite-SSR harness extracted from `storage-bridge.test.js`. The only production-source edits are the dead-code removals in tasks 7 and 8, each lowering a ceiling or removing an unused `export`.

**Tech Stack:** Node (`node:test`, `node:assert/strict`), Yjs 13, vite SSR loader, global Playwright (`/opt/homebrew/lib/node_modules/playwright`), React 18 (read only).

**Spec:** `docs/superpowers/specs/2026-11-19-codebase-refactor-design.md` (§6 "P0 Safety rails and mechanical cleanup", §5.4, §7.2, §7.3, §7.5) and the map `docs/superpowers/specs/2026-11-19-codebase-current-state.md` (§4 invariants INV-n, §8 gaps, §9 hygiene). Worktree `/Users/sakontheerasuwanajak/Documents/miro-wt-refactor`, branch `refactor/codebase` @ f6f8813. Re-grep every symbol before editing; line numbers below are from this worktree.

## Global Constraints

Every task inherits all of these.

- AGENTS.md binds in full: Sonar-clean new code, cognitive complexity <= 15, no magic numbers or strings (name each bound with its unit, e.g. `SYNC_TIMEOUT_MS`), imports at the top, shared logic in ONE module, no `NOSONAR`/`skip`/loosened test, no raised ceiling or ratchet baseline.
- Tests: no tautologies; expectations come from `CONTEXT.md`, `SECURITY.md`, the map's invariants or domain constants, never from copied current output. For every new test or guard state the revert/mutation that turns it red and show it red (record in the task report, then restore).
- Worktree only. No `docker compose`, no deploy, no `.env`, no backups, no edits to nginx CSP, cloudflared, compose security settings or `.github/workflows`. No new runtime or dev dependency.
- Commit trailers on every commit, verbatim, last two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01YMhR1CNNoCRLB1mKDDdt9m`
- Full gate per task, ONE blocking Bash call, timeout 600000: `(npm test -- --test-concurrency=2 && npm run build) > "$TMPDIR/<name>.log" 2>&1`, then read `tail`/`rg "ℹ (tests|pass|fail)"` of the log. Report tests/pass/fail numbers before and after.
- Live checks: at most ONE Chromium at a time on this Mac; ignore orphan pids 73524 and 73535-73537 and NEVER kill them (or any process the task did not start). Every run goes under `perl -e 'alarm 900; exec @ARGV' node ...`, kills every server it started, then confirms its ports are free (`lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing). A foreign process on a needed port means stop and report `env-skip`, not kill.
- Live-check outputs (screenshots, `report.json`, relay db, logs) go to `/Volumes/ssd-fluke/BaseData/retro-board/refactor-p0-20261119/<task>/` (AGENTS.md Data location; already symlinked at `~/basedata/retro-board/refactor-p0-20261119`). Never in the repo, `/tmp` or the scratchpad. Volume unmounted: stop and report.
- Every new script gets an entry in `scripts/README.md` in the same commit. Every new test file is `*.test.js` or `*.test.mjs` (`scripts/project-files.mjs:6` discovers nothing else).
- Frozen files: `RetroBoard.jsx` (3993 lines, ceiling 3993) and `yjs-server.mjs` (1445, ceiling 1446) gain no logic. A task that removes lines from `RetroBoard.jsx` lowers `RETRO_BOARD_MAX_LINES` in `src/rule-ratchets.test.js` to the MEASURED `wc -l` in the same commit.
- Behaviour is frozen: copy, URLs, timing constants (24 ms, 60/80 ms, 8000 ms, 30 s, 500 ms), Yjs keys, `window.storage` names and arity.
- Task order is strict (1, 1b.1-1b.5, 2, 3-9). The baseline in task 2 must run before any production-source edit (tasks 7 and 8); tasks 1-6 change only tests and scripts.

## Review Focus

Failure modes the design implies but no task's happy path exercises; each has an owning test or step below.

1. A needed port is held by a foreign process (production tunnel stack, orphan pids): the runner must report it and mark `env-skip`, never kill or reuse it. Owner: task 1 (`assertPortsFree` test) and task 2.
2. Data volume unmounted or output path escaping it via `..`/symlink: the runner and every check must refuse with no fallback. Owner: task 1 (reuses `prepareDataVolumeOutput`; runner test).
3. A gesture check leaves the mouse button down after a failed step, so the next step starts with a stuck drag. Owner: every 1b task (`finally { await page.mouse.up() }` in the shared `dragBy`).
4. `window.storage` has conditional members (`rotationSource` only for locked rooms, `boardReactions`/`writingTimer` only on `/b/`, `drawingPreviews` on both): a contract test that only loads a plain board misses them. Owner: task 3 (plain, locked, public-wall and landing variants).
5. An "unused" export is consumed through a namespace import, dynamic `import()`, `vite.config.js`, the maintainer app or an HTML entry, so the unit gate stays green and the build breaks. Owner: tasks 8b, 8c (namespace/dynamic rg, `npm run build` AND `npm run maintainer:build`).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/live-check-common.mjs` (new) | manifest schema/validator, port and process lifecycle, hard timeout, regression judge | 1 |
| `scripts/live-check-all.mjs` (new) | sequential CLI over the manifest | 1 |
| `scripts/live-check-common.test.mjs` (new) | tests of the above | 1 |
| `scripts/live-check-manifest.json` (new) | one entry per live check: recipe, baseline, reason, flake rate; plus unit/bundle baselines | 1 skeleton, 1b.x entries, 2 values |
| `scripts/board-live-helpers.mjs` (+ `.test.mjs`) | new shared Playwright helpers for the five checks | 1 |
| `scripts/board-drag-peer-live-check.mjs`, `board-resize-live-check.mjs`, `board-undo-middrag-live-check.mjs`, `presence-live-check.mjs`, `board-import-ui-live-check.mjs` (new) | design §7.3 | 1b.1-1b.5 |
| `src/test-support/bridge-harness.js` (new) | `withStorage` etc. moved out of `storage-bridge.test.js` | 3 |
| `src/client/session/storage-contract.test.js` (new) | window.storage surface | 3 |
| `src/client/session/storage-bridge.test.js` | two new tests, import of harness | 3, 4, 5 |
| `src/rule-ratchets.test.js` | new ceilings + generic oversize guard | 6, 7 |
| `RetroBoard.jsx`, `src/**` exports | dead-code removal | 7, 8 |
| `docs/superpowers/plans/2026-11-19-p0-doc-corrections.patch` (new) | AGENTS.md/ARCHITECTURE.md fixes, NOT applied | 9 |

## Design deviations (also returned to the owner)

1. `live-check-common.mjs` owns only process/port/manifest logic; participant, step and drag helpers stay in the existing `board-live-helpers.mjs` (it already holds `participant`, `step`, `runLiveCheck`). Copying them into a second module would add the duplication the map lists as hygiene debt.
2. The manifest file is created in task 1 with `baseline: "unrun"` entries (the runner needs it, and each 1b check must run through the runner's stack recipe); task 2 fills in the measured baselines, which is the design's §7.5 content.
3. The bridge has no function named `isUndoOrigin`; the check is inline `origin === undoManager` at `storage-bridge.js:517` and `:525`. Tests pin the observable behaviour; naming it is P3.
4. The item-drag leak check uses mouseup and `window` blur, not pointercancel/Escape: `startItemDrag` registers only `mousemove`, `mouseup` and `blur` (`RetroBoard.jsx:2336-2338`).
5. Dead exports measured by rg: 96 under `src/` (3 unused outright, 93 only need `export` removed), not "about 70"; `PUBLIC_RELAY_PORT` is NOT dead (`vite.config.js:3` imports it, the map was wrong). 5 more sit in `scripts/` and are left alone.

---

### Task 1: Live-check runner, manifest skeleton, shared helpers (design P0 task 1)

**Files:**
- Create: `scripts/live-check-common.mjs`, `scripts/live-check-all.mjs`, `scripts/live-check-common.test.mjs`, `scripts/live-check-manifest.json`
- Modify: `scripts/board-live-helpers.mjs` (add helpers below), `scripts/board-live-helpers.test.mjs`, `scripts/README.md`

**Interfaces:**
- Produces (`live-check-common.mjs`):
  - `BASELINE = Object.freeze({ PASS: 'pass', KNOWN_RED: 'known-red', ENV_SKIP: 'env-skip', FLAKY: 'flaky', UNRUN: 'unrun' })`
  - `parseManifest(json: unknown, { requireRun = false } = {}): Manifest` (throws `Error` naming the entry)
  - `serverPlan(entry, ports, outDir): Array<{ name, command, args, env, port }>` (pure)
  - `checkCommand(entry, ports, outDir): string[]` (pure; argv after `node`)
  - `assertPortsFree(ports: number[]): Promise<void>` (rejects `port <n> is held by another process`, kills nothing). IPv4 AND IPv6: for each port it attempts a TCP connect to BOTH `127.0.0.1` and `::1` and fails if either answers (OrbStack holds `[::1]` listeners, and `viteHost: localhost` may bind `::1` on macOS); a listen-on-`0.0.0.0` probe is NOT used because it misses a `::1` holder.
  - `startServers(plan, outDir): Promise<{ stop(): Promise<void> }>` (spawns each `detached`, logs to `<outDir>/<name>.log`, waits until `port` accepts a TCP connect on the entry's own host (`viteHost` for vite, `127.0.0.1` for node services; `localhost` resolves both families and passes if either answers), `SERVER_READY_TIMEOUT_MS` bound; logs are per-run, truncated on start, bounded by the hard timeout and kept on the data volume only, a deliberate exception to the AGENTS.md rotation rule, not an omission; `stop()` kills the process groups it spawned and awaits exit)
  - `runWithHardTimeout(argv: string[], { timeoutSec, env, cwd }): Promise<{ exitCode: number|null, signal: string|null, timedOut: boolean, stdout: string }>` (spawns the check `detached` so it leads its own process group; on timeout it sends SIGTERM then SIGKILL to the whole group via `process.kill(-pid, ...)`, so a Chromium or any grandchild the check started dies with it and the next check never meets a second Chromium; `perl -e 'alarm shift; exec @ARGV'` wraps the argv only as a backstop. `perl` is required: when `perl` is missing the function rejects with `perl is required for the live-check hard timeout`, a clear error, never a hang)
  - `summarizeRun(stdout: string, exitCode): { passLines: number, failLines: number, failedStep: string|null }` (parses the `PASS <step>`/`FAIL <step>` lines `runLiveCheck` prints)
  - `judgeRun(entry, attempts: Array<ReturnType<typeof summarizeRun>>): 'ok' | 'improved' | 'regression' | 'skipped'` (design §7.5)
- Produces (`board-live-helpers.mjs`): `boardItems(page): Promise<object[]>` (canonical `window.storage.get('boardState', true)` items); `itemById(items, id)`; `boxCenter(box): {x,y}`; `withinPx(actual, expected, tolerancePx): boolean`; `stickyBox(page, text): Promise<{x,y,width,height}>` (box of the `[data-sticky-id]` element containing `text`; throws if absent); `dragBy(page, from, by, { steps, hold = false }): Promise<void>` (mouse move, down, stepped move; releases in `finally` unless `hold`; with `hold` the caller must `page.mouse.up()`).
- Consumes: `prepareDataVolumeOutput`, `DATA_VOLUME_ROOTS` from `board-live-helpers.mjs`.

Manifest entry shape (JSON, all fields required unless marked):
`{ id, script, args: string[] (tokens `{base}` `{out}` allowed), stack: 'plain'|'oidc', viteHost: '127.0.0.1'|'localhost', ports: { vite?: number (fixed) }, publicRelay: boolean, maintainer: boolean, relayEnv: {string:string}, checkEnv: {string:string} (values `{oidcPort}` `{relayPort}` allowed), timeoutSec, baseline, reason? (required for known-red/env-skip/flaky), failingStep? (required for known-red), observedFailRate? (required for flaky) }`.
Ports: unless `ports.vite` is fixed, entry index `i` (position in the file) gets vite `5301+i`, relay `1301+i`, oidc `4401+i`, maintainer `1351+i`; the public relay is always `1235` (fixed by `vite.config.js`'s proxy), pan uses vite 5188 and public-tools 5187 (their scripts assert it).
Stack recipes (from the check headers): `plain` = relay `node yjs-server.mjs` with `YJS_ALLOW_INSECURE_HTTP=true YJS_PORT YJS_ROOM_CREATE_BURST=100 YJS_ROOM_CREATES_PER_HOUR=1000 YJS_ALLOWED_ORIGINS=http://127.0.0.1:<vite>,http://localhost:<vite> YJS_DB_DIR=<out>/db YJS_UPLOADS_DIR=<out>/uploads` plus `VITE_YJS_PORT=<relay> npx vite --host <viteHost> --port <vite> --strictPort`; `oidc` adds `node scripts/fake-google-oidc.mjs` (`FAKE_OIDC_PORT`) and relay `GOOGLE_OAUTH_ENDPOINT_BASE=http://127.0.0.1:<oidc> GOOGLE_OAUTH_CLIENT_ID=dev-client GOOGLE_OAUTH_CLIENT_SECRET=dev-secret GOOGLE_OAUTH_REDIRECT_URI=http://localhost:<relay>/api/auth/google/callback`; `publicRelay` adds `YJS_PUBLIC_WALL=true YJS_PORT=1235 YJS_DB_DIR=<out>/public-db YJS_ALLOW_INSECURE_HTTP=true YJS_ALLOWED_ORIGINS=<same>`; `maintainer` adds `YJS_MAINTAINER_PORT` and a per-run random base64url `YJS_MAINTAINER_KEY` (generated in memory, passed by env only, never logged or stored) and requires `dist-maintainer/` to exist (`npm run maintainer:build` once, gitignored).

- [ ] **Step 1: Write failing tests in `scripts/live-check-common.test.mjs`.** Names and assertions:
  - `manifest rejects a known-red, env-skip or flaky entry without its reason` (three `assert.throws(..., /reason/)`), `a known-red entry needs failingStep`, `a flaky entry needs observedFailRate`, `duplicate ids are rejected`, `an entry whose script file is missing is rejected`, `requireRun rejects any entry still unrun` (and without `requireRun` accepts `unrun`).
  - `serverPlan puts the public relay on 1235 and gives every other service its own port`, `serverPlan never puts the maintainer key in argv` (key only in `env`), `checkCommand substitutes {base} and {out}`.
  - `assertPortsFree rejects a port held by a foreign listener and leaves that listener open` (the test opens its own `net` server on port 0, then asserts it still accepts a connection afterwards); `assertPortsFree rejects a ::1-only listener` (a `net` server bound to `::1` on port 0, skipped with a stated reason only when the host has no IPv6 loopback) and `assertPortsFree rejects a dual-stack listener on ::`; `startServers waits on the entry's own host` (a `::1`-bound http server entry with `host: '::1'` becomes ready).
  - `stop() kills the process group it started and frees the port` (plan = `node -e` http server on a free port; after `stop()` `assertPortsFree` resolves).
  - `runWithHardTimeout kills a sleeping child after timeoutSec` (`node -e "setTimeout(()=>{},60000)"`, `timeoutSec: 1`, `timedOut === true`, elapsed < 5000 ms); `runWithHardTimeout kills a grandchild too` (the child spawns a grandchild `node -e` sleeper and prints its pid; after the timeout `process.kill(pid, 0)` throws `ESRCH`); `runWithHardTimeout reports a missing perl` (PATH emptied for the call: rejects with the message above).
  - Test hygiene (the file runs inside `npm test --test-concurrency=2` and in Linux CI): every test port comes from `listen(0)` (never a fixed port), unique per test; every process-spawning test is bounded by a `timeoutSec` of 1-2 so nothing can hang the gate; processes are killed in `finally`.
  - `summarizeRun counts PASS and FAIL lines and names the first failing step`.
  - `judgeRun`: `pass entry that fails once is a regression`; `known-red failing at its recorded failingStep is ok, at another step is a regression, passing is improved`; `flaky entry fails only when all three attempts fail`; `env-skip is skipped`.
  Extend `scripts/board-live-helpers.test.mjs`: `boxCenter returns the middle of a box`, `withinPx accepts the boundary and rejects one pixel beyond`, `dragBy releases the button when a move throws` (fake `page.mouse` whose `move` throws on the second call: `up()` is still called once) and `dragBy with hold leaves the button down` (`up()` not called). Mutation: remove the `finally` in `dragBy`; the first test goes red.
- [ ] **Step 2: Run** `node --test scripts/live-check-common.test.mjs scripts/board-live-helpers.test.mjs`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `live-check-common.mjs`** to the interfaces above. Name every constant with its unit (`SERVER_READY_TIMEOUT_MS`, `SERVER_STOP_GRACE_MS`, `DEFAULT_CHECK_TIMEOUT_SEC = 900`). `judgeRun` rules (§7.5): `pass` entry fails on any single failed attempt; `flaky` re-runs up to 3 attempts total and fails only if all fail; `known-red` is ok when the run fails at exactly `failingStep`, `improved` when it passes, `regression` when it fails at any other step; `env-skip` returns `skipped`. Keep functions small (CC <= 15): one function per stack service.
- [ ] **Step 4: Implement `live-check-all.mjs`** CLI: `node scripts/live-check-all.mjs --out-root <dir on a data volume> [--only id,id] [--list] [--attempts n]`. For each selected entry in file order: `prepareDataVolumeOutput` for `<out-root>/<id>/run-<n>`, `assertPortsFree` (foreign holder: print `ENV-SKIP <id>: port <n> in use` and continue), `startServers`, `runWithHardTimeout(['node', script, ...args])`, always `stop()` then `assertPortsFree` again (a still-bound port is a hard error), write `<run dir>/summary.json` (`id, exitCode, timedOut, passLines, failLines, failedStep, durationMs, judged`), print one line per entry. Never touches anything it did not spawn.
- [ ] **Step 5: Add the shared helpers to `board-live-helpers.mjs`** (signatures above; `dragBy` uses a named `DRAG_STEPS = 12` default and releases the button in `finally`). Do not migrate older checks to them.
- [ ] **Step 6: Create the manifest skeleton** with the 15 existing checks, all `baseline: "unrun"`, in this order and recipes: `ui` (plain, `127.0.0.1`, args `--base-url {base} --out {out}`), `facilitation`, `retro-outcomes`, `board-reactions` (args `{base} {out} plain`), `writing-timer` (`{base} {out} plain`, timeoutSec 900), `poker` (all plain, `{base} {out}`), `landing`, `modal` (both plain, `publicRelay: false`: their headers call them read-only/local, `landing` counts any WebSocket to `/yjs` or `/yjs-public` as a write and expects none, and `modal` only opens `/b/` boards; if task 2 shows a check needs the public relay, changing the recipe is a setup fix, not a check edit, and is recorded in `reason`), `mobile` (`{base} {out} chromium all`, publicRelay), `spacing` (`{base} {out} chromium check`, publicRelay), `pan` (vite 5188, publicRelay, `{base} {out} chromium images`), `public-tools` (vite 5187, publicRelay, `{base} {out} chromium`), `room-lock` (oidc, relayEnv `YJS_ROOM_SESSION_TTL_SECONDS=60`, viteHost `localhost`), `account` (oidc, maintainer, checkEnv `YJS_MAINTAINER_KEY`/`YJS_MAINTAINER_PORT` supplied by the runner, viteHost `localhost`), `room-management` (oidc, publicRelay, relayEnv `YJS_COLD_ROOM_OPEN_IP_BURST=100 YJS_COLD_ROOM_OPENS_PER_IP_PER_MINUTE=1000 YJS_COLD_ROOM_OPEN_ROOM_BURST=100 YJS_COLD_ROOM_OPENS_PER_ROOM_PER_MINUTE=1000 YJS_GUEST_ROOM_RETENTION_MS=20000 YJS_GUEST_SWEEP_INTERVAL_MS=1000`, checkEnv `FAKE_OIDC_PORT={oidcPort} YJS_GUEST_ROOM_RETENTION_MS=20000`, the check reads `<out>/relay.log`). Also add `board-reactions-locked` and `writing-timer-locked` (controller ruling 2026-11-19: P3 touches the E2E path): stack `oidc`, viteHost `localhost`, relayEnv `YJS_ROOM_SESSION_TTL_SECONDS=60`, args `{base} {out} locked`, same recipe as `room-lock` (each script's header). 17 entries in total.
- [ ] **Step 7: Run** the two test files again. Expected: PASS; then `node scripts/live-check-all.mjs --list` prints 17 ids.
- [ ] **Step 8: Revert checks:** make `assertPortsFree` ignore its argument; the foreign-listener test must go red. Restore. Make `assertPortsFree` probe only `127.0.0.1`; the `::1` test must go red. Restore. Make `runWithHardTimeout` signal only the node pid; the grandchild test must go red. Restore. Remove the `finally` in `dragBy`; its test goes red. Restore.
- [ ] **Step 9: README entries** for `live-check-all.mjs`, `live-check-common.mjs` and the manifest. Full gate. Commit `test(live): sequential live-check runner and manifest skeleton`.

### Task 1b.1: `board-drag-peer-live-check.mjs` (INV-5, INV-7, INV-2)

**Files:**
- Create: `scripts/board-drag-peer-live-check.mjs`
- Modify: `scripts/live-check-manifest.json` (entry `board-drag-peer`, stack `plain`, `127.0.0.1`, args `{base} {out}`), `scripts/README.md`

**Interfaces:** Consumes `runLiveCheck`, `addSharedSticky`, `boardItems`, `itemById`, `stickyBox`, `dragBy`, `withinPx`, `waitForTextOn`, `undoUntilHidden`-style key constants `UNDO_KEY`/`REDO_KEY`, `NAME_A`, `NAME_B`, `step`, `shot` from `board-live-helpers.mjs`. Produces: CLI `node scripts/board-drag-peer-live-check.mjs <base-url> <out>`.

Setup recipe: `plain` stack through the runner: `node scripts/live-check-all.mjs --only board-drag-peer --out-root /Volumes/ssd-fluke/BaseData/retro-board/refactor-p0-20261119/1b.1` (default `runLiveCheck` setup: English A creates the board, Thai B joins).

Steps (each a `step(report, name, ...)`; PASS lines are the step names):
1. `both add a shared sticky`: A adds shared sticky `alpha` at (480, 360), B adds shared sticky `beta` at (960, 360); both texts visible on both pages. Record `alpha0`, `beta0` world `x,y` from `boardItems(a)`.
2. `A drags alpha while B drags beta and types, A is never snapped back`: A `dragBy(..., { hold: true })` in 40 steps of 12 px with `SAMPLE_INTERVAL_MS = 25` waits; concurrently (`Promise.all`) B drags `beta` +100 px and types `BETA_TYPING` (30 chars, keyboard `delay: 20`) into it. After every A step, wait two `requestAnimationFrame`s and read alpha's rendered `stickyBox`; assert its centre is within `SNAP_TOLERANCE_PX = 4` of A's pointer-implied position for EVERY sample (INV-5: local geometry survives remote snapshots during a drag). B's typed text must appear on A before A releases (remote text still applied).
3. `peers converge after the drag`: A mouseup; wait `SYNC_TIMEOUT_MS`-bounded until `boardItems` of A and B agree on alpha and beta `x,y` (within 0.5 world px) and beta's text; alpha moved in the pointer's direction and `(alpha.x-alpha0.x)/(alpha.y-alpha0.y)` equals the pointer's dx/dy within 2% (zoom-independent).
4. `still not snapped back inside the 8000 ms recent-move window`: wait 1500 ms, A's alpha still equals step 3's value on both pages.
5. `undo on A reverts only A's drag, redo restores it, on both pages`: A presses `UNDO_KEY`; alpha is back at `alpha0` and beta is unchanged (B's move not undone) on both; A presses `REDO_KEY`; alpha at the dragged position on both.
6. last step `no page errors` via `errorsStep`.

- [ ] **Step 1:** Write the script (constants named with units; all gestures through `dragBy`; every step ends with `page.mouse.up()` in `finally` if a hold was open).
- [ ] **Step 2:** Run through the runner on the unmodified worktree. Expected: all PASS lines, exit 0. Run it twice; both clean (manifest policy).
- [ ] **Step 3: Deliberate break (must turn red):** in `src/domain/board-reconciliation.js` `reconcileItem`, replace the line `if (draggedIds?.has(remote.id)) return withLocalGeometry(remote, previous);` with `if (false) return withLocalGeometry(remote, previous);`. Run: step 2 must FAIL (A's rendered alpha deviates by more than 4 px). If it passes by luck, rerun up to 3 times and lengthen `BETA_TYPING` until it is red on the first run; record the final length. Restore with `git checkout -- src/domain/board-reconciliation.js` and confirm green again.
- [ ] **Step 4:** README entry; full gate; kill servers and confirm ports free; commit `test(live): drag with a peer converges and is never snapped back`.

### Task 1b.2: `board-resize-live-check.mjs` (INV-6)

**Files:** Create `scripts/board-resize-live-check.mjs`; modify the manifest (`board-resize`, plain, `127.0.0.1`), `scripts/README.md`.
**Interfaces:** same helpers as 1b.1 plus `addZone`, `ITEM_MIN_SIZE_PX`, `ITEM_MAX_SIDE_PX` imported from `src/domain/item-size-limits.js` (expectations come from the domain constants, not from output).
Recipe: `plain` via runner, out `.../1b.2`. Handles are `[data-selection-corner="nw|ne|sw|se"]` (rendered by `renderResizeHandles`, `RetroBoard.jsx:3373`).

Steps:
1. `zone resize syncs`: A draws zone `Resize zone` (`addZone`, drag (200,200)-(560,420)), selects it, drags the `se` handle by (+120,+80). Zoom = zone box width / `zone.w` from `boardItems`. Expect `w`,`h` grew by `120/zoom`,`80/zoom` (+-1) on A and B; `x,y` unchanged; `Number.isFinite` and `0 < w <= ITEM_MAX_SIDE_PX.zone` for both.
2. `sticky se handle resizes both axes`: A adds shared sticky `rs`, selects it, `se` by (+90,+60): `w,h` grow by `90/zoom`,`60/zoom` (+-1) on A and B.
3. `nw handle moves the origin`: `nw` by (+30,+20): `x,y` move by `+30/zoom`,`+20/zoom`, `w,h` shrink by the same, bottom-right corner fixed (+-1).
4. `shrinking stops at the minimum`: `se` by a delta computed from the minimum, `-((w - ITEM_MIN_SIZE_PX.sticky.w) * zoom + MARGIN_PX)` per axis (`MARGIN_PX = 40`), so the pointer ends a little past the minimum and the handle stays inside the 1440x900 viewport: `w === ITEM_MIN_SIZE_PX.sticky.w`, `h === ITEM_MIN_SIZE_PX.sticky.h` on both pages.
5. `growing stops at the maximum`: zoom the board out first (`window.storage` zoom seam or the zoom control, recorded) so the target fits the viewport, then `se` by `(ITEM_MAX_SIDE_PX.sticky - w) * zoom + MARGIN_PX` per axis (the sticky cap is 1200 world px, so no multi-thousand-pixel mouse path); keep the `se` handle within or only slightly beyond the viewport edge: `w,h <= ITEM_MAX_SIDE_PX.sticky` and finite on both.
6. `a locked zone shows no resize handles`: A sets the zone `locked` through the public seam `page.evaluate(id => window.storage.updateItem(id, { locked: true }), zoneId)`, selects it: `[data-selection-corner]` count is 0.
7. `undo restores the previous size on both`: A unlocks via the same seam, resizes the sticky once more, presses `UNDO_KEY`: A and B size equals the pre-resize size (+-0.5).

- [ ] **Step 1:** Write the script. **Step 2:** run twice green via the runner.
- [ ] **Step 3: Deliberate break:** in `RetroBoard.jsx` `startItemResize` (`:2500-2501`) change `w = initial.w + dx; h = initial.h + dy;` (the `corner === 'se'` branch) to `w = initial.w + dx; h = initial.h + dx;`. Step 1 (or 2) must FAIL on the `h` assertion. Restore with `git checkout -- RetroBoard.jsx`; confirm green.
- [ ] **Step 4:** README, gate, ports free, commit `test(live): resize handles sync, clamp and respect locks`.

### Task 1b.3: `board-undo-middrag-live-check.mjs` (INV-3, INV-7)

**Files:** Create `scripts/board-undo-middrag-live-check.mjs`; modify manifest (`board-undo-middrag`, plain), README.
**Interfaces:** same helpers; strings via `appLabel(lang, key)`: `topbar.finishDragFirst` ("Release the drag before undoing/redoing"), `common.warnLockEdit` ("Editing locked by admin"), `topbar.lockEdit`/`topbar.unlockEdit` (topbar button `title`), `topbar.nothingToUndo`.
Recipe: `plain` via runner, out `.../1b.3`.

Steps:
1. `A has an undoable sticky`: A adds shared sticky `ut`; `window.storage.canUndo()` true on A.
2. `undo is refused mid-drag`: `dragBy(a, ..., { hold: true })` beyond the 4 px threshold; press `UNDO_KEY`; the toast text `appLabel('en','topbar.finishDragFirst')` is visible; `ut` still exists on A and B; `canUndo()` still true.
3. `releasing the mouse allows undo again`: `mouse.up()`; `UNDO_KEY` reverts the drag (`ut` back at its start position on A and B), no `finishDragFirst` toast.
4. `a drag that ends by window blur does not leak the drag lock` (INV-7): hold a second drag and do NOT call `mouse.up()`; `page.evaluate(() => window.dispatchEvent(new Event('blur')))`; press `UNDO_KEY`: it works (state reverts, no `finishDragFirst` toast). Only then release the mouse for cleanup (in `finally`). A normal mouse-up also runs `finalize`, so this ordering is what isolates the blur path.
5. `non-admin undo is refused while editing is locked`: B adds shared sticky `bt`; A clicks the topbar button titled `appLabel('en','topbar.lockEdit')`; B presses `UNDO_KEY`: toast `appLabel('th','common.warnLockEdit')`, `bt` still visible on both.
6. `unlocking lets B undo`: A clicks `appLabel('en','topbar.unlockEdit')`; B's `UNDO_KEY` removes `bt` on both.

- [ ] **Step 1:** write; **Step 2:** twice green.
- [ ] **Step 3: Two deliberate breaks, one run each, each restored with `git checkout -- RetroBoard.jsx`:** (a) delete the `if (midDrag()) { ...; return; }` line in `doUndo` (`RetroBoard.jsx:1137`): step 2 FAILS. (b) delete `window.addEventListener('blur', onBlur);` in `startItemDrag` (`RetroBoard.jsx:2338`): step 4 FAILS (blur no longer finalizes, undo stays blocked) and step 3 stays GREEN (normal mouse-up still finalizes). Do not use deleting `dragItemsRef.current = null;` (`:2322`, the same text also sits at `:2271`, `:2394`, `:2445`, `:2548`, `:2694`): that blocks undo after every release and would fail step 3 instead, so it does not isolate INV-7.
- [ ] **Step 4:** README, gate, ports free, commit `test(live): undo is refused mid-drag and when locked, and the drag lock never leaks`.

### Task 1b.4: `presence-live-check.mjs` (INV-10, INV-11 visible half)

**Files:** Create `scripts/presence-live-check.mjs`; modify manifest (`presence`, plain), README.
**Interfaces:** `PLAYER_PRESENCE_STALE_MS` from `src/domain/awareness-liveness.js`; selectors `.rb-player-cursor` (carries `data-cursor-x/y` and the player name) and `[role="status"][aria-label="..."]` for selection and editing labels (`RetroBoard.jsx:3680-3740`); labels via `appLabel('en', 'selection.by', { name })`, `appLabel('en','editing.by',{ name })`, `appLabel('th', ...)`, `common.warnItemBusy`.
Recipe: `plain` via runner, out `.../1b.4`. B's name is the Thai `NAME_B`, A's `NAME_A`.

Steps:
1. `A sees B's cursor and its name`: B moves the mouse over the canvas at two points 300 px apart; on A `.rb-player-cursor` containing `NAME_B` is visible and its `data-cursor-x` increases between the two points.
2. `B sees A's cursor` (mirror, A's UI English label `NAME_A` shown on B).
3. `selection label appears and clears`: A adds shared sticky `pres`; B clicks it: A shows `status` with aria-label `appLabel('en','selection.by',{name:NAME_B})`; B clicks empty canvas: label hidden on A.
4. `editing indicator appears and clears`: B double-clicks `pres` and types; A shows `appLabel('en','editing.by',{name:NAME_B})`; B presses Escape: hidden on A.
5. `busy claim blocks a peer drag and clears when the claimant leaves`: B holds a drag on `pres`; A drags `pres`: toast `appLabel('en','common.warnItemBusy')` and no move; B navigates its page to `about:blank` (leaves) mid-drag; within `PLAYER_PRESENCE_STALE_MS + SYNC_TIMEOUT_MS` A's drag of `pres` succeeds (position changes) with no busy toast.
6. `cursor, selection and editing indicators are gone for a departed peer`: with B gone, A shows no `.rb-player-cursor` for `NAME_B`, no selection and no editing label, within the same bound (record the measured time in `report.json`).

- [ ] **Step 1:** write; **Step 2:** twice green (record the measured clear-on-leave time; if it is not under the bound twice, report `flaky` for task 2 rather than widening the bound silently).
- [ ] **Step 3: Deliberate break:** in `RetroBoard.jsx` delete `storage.setLocalSelectedItems(selectedIds);` (`:459`): step 3 FAILS. Restore with `git checkout`.
- [ ] **Step 4:** README, gate, ports free, commit `test(live): presence, selection, editing and busy claims across two contexts`.

### Task 1b.5: `board-import-ui-live-check.mjs` (INV-13)

**Files:** Create `scripts/board-import-ui-live-check.mjs`; modify manifest (`board-import-ui`, plain), README.
**Interfaces:** `download`, `openMenu`, `BASE_LABELS`, `appLabel`; the hidden `input[type=file]` is driven through `page.waitForEvent('filechooser')` after `openMenu(a,'en',appLabel('en','topbar.import'))` as `retro-outcomes-live-check.mjs:100-106` does; the confirm button is `appLabel('en','import.confirm.ok')`; menu entries `topbar.export` (ZIP) and `topbar.exportCsv`; toasts `import.fail`, `common.adminOnly`; JSON manifest shape `{ version: 1, exportedAt, boardCode, board: { items }, votes: {}, comments: {}, moods: {}, customTemplates: [] }` (`createJsonBackupArtifact`).
Recipe: `plain` via runner, out `.../1b.5`. Files written by the check go under `<out>`.

Steps:
1. `ZIP round trip is exact and shows on both pages`: A adds shared stickies `imp-1`, `imp-2` and zone `Imp zone`; `snapshot0 = boardItems(a)` normalized (sorted by id, `id,type,x,y,w,h,text,title`); A downloads the ZIP (`topbar.export`); A deletes `imp-2` and adds `extra`; A imports the ZIP (chooser, confirm); `boardItems` of A AND B deep-equal `snapshot0`; `extra` gone; `imp-2` visible on A without reload (INV-13: `confirmImport` must `setBoard`). The `boardItems` equality is read from canonical Yjs and stays green without the local echo, so only the DOM assertion (`waitForTextOn(a, 'imp-2')` on A, no reload, run BEFORE any reload or navigation) can turn red; it must be a separate assertion line in the step.
2. `JSON import applies`: write a JSON manifest with one sticky `from-json` (valid geometry) into `<out>`; import it; A and B show exactly that sticky.
3. `CSV import lays cards out by zone`: A downloads `topbar.exportCsv`, deletes a sticky, imports the CSV: the sticky text is back on A and B (positions are laid out again; assert text only, per the CSV warning copy `import.csv.warning`).
4. `failure 1: invalid JSON is rejected and the board is unchanged`: file `not json` named `bad.json`: toast starts with the English `import.fail` prefix `Invalid file —`; `boardItems` unchanged on A and B.
5. `failure 2: an explicit invalid value is rejected`: JSON with a sticky whose `x` is `null` (rejected as "invalid coordinates", `import-schema.test.js:139`): same assertions as 4.
6. `failure 3: a non-admin cannot import`: B opens the Import entry: toast `appLabel('th','common.adminOnly')`, no file chooser event within 1000 ms, board unchanged.
7. `cancelling the confirm dialog leaves the board unchanged`.

- [ ] **Step 1:** write; **Step 2:** twice green.
- [ ] **Step 3: Deliberate break:** in `RetroBoard.jsx` `confirmImport` delete `setBoard(nextBoard);` (`RetroBoard.jsx:3168`; `:824` is a different call, leave it). Step 1 must FAIL, and the red must come from the `imp-2` DOM-visibility assertion on A (the `boardItems` equality alone will not go red); record which assertion failed. Restore with `git checkout`.
- [ ] **Step 4:** README, gate, ports free, commit `test(live): file-chooser import round trip and its failure paths`.

### Task 2: Baseline run and manifest values (design P0 task 2, §7.5)

**Files:** Modify `scripts/live-check-manifest.json`, `scripts/live-check-common.test.mjs`; no source edits (the tree must still equal the baseline).
**Interfaces:** Consumes the runner from task 1 and all 22 entries. Produces the manifest later phases gate on.

- [ ] **Step 1:** `npm run maintainer:build` once (output `dist-maintainer/` is gitignored; needed by `account`). Confirm `git status` shows only the manifest and test changes expected from this task.
- [ ] **Step 2:** Run every entry through the runner, sequentially, under the runner's hard timeout: `node scripts/live-check-all.mjs --out-root /Volumes/ssd-fluke/BaseData/retro-board/refactor-p0-20261119/2 --attempts 2`. Two clean consecutive runs required for `pass`. A check that fails or cannot be set up here is `known-red` (record `reason` and `failingStep` = first FAIL step) or `env-skip` (record the reason, e.g. webkit missing or a foreign port holder); an intermittent one is `flaky` with `observedFailRate` (e.g. `"1/3"`), re-run up to 2 more times. The `unitTests.atBaseline` count is the pre-P0-tasks-3-8 number; the manifest README entry says later phases compare against the count re-recorded at the end of P0 (task 9 step 4), not this one. Never edit a check to make it pass.
- [ ] **Step 3:** Record unit and bundle baselines in the manifest under `baselines`: `{ unitTests: { atBaseline: { commit, tests, pass, fail } } }` (`commit` = `git rev-parse --short HEAD` of the tree measured) from the `ℹ tests/pass/fail` lines of the gate log, and `bundle: [{ prefix, kB, gzipKB }]` for the entries printed by `vite build` (match by prefix such as `index-`, since hashes change).
- [ ] **Step 4:** Add to `live-check-common.test.mjs`: `the committed manifest has no unrun entry` (`parseManifest(JSON, { requireRun: true })`), `every committed entry's script exists`, `the manifest lists all 22 live checks` (ids = the 17 listed in task 1 plus `board-drag-peer`, `board-resize`, `board-undo-middrag`, `presence`, `board-import-ui`).
- [ ] **Step 5:** Run gate; confirm after the runs all ports free and no process started by the runner remains (`ps` lists none; orphans 73524/73535-73537 untouched). Commit `test(live): record the live-check baseline manifest`.
- [ ] **Step 6:** Report to the controller the table id / baseline / reason, the run count per check and total duration.

### Task 3: `window.storage` contract test and shared bridge harness (design P0 task 3, INV storage seam)

**Files:**
- Create: `src/test-support/bridge-harness.js`, `src/client/session/storage-contract.test.js`
- Modify: `src/client/session/storage-bridge.test.js` (delete the moved helpers, import them)

**Interfaces:**
- Produces (`bridge-harness.js`): `VALID_ITEM`, `ROOM_HANDLE`, `LOCKED_EPOCH`, `ROOM_KEY_CHANGED_EVENT`, `withStorage(check, { publicWall = false, locked = false, landing = false } = {}): Promise<void>` where `check(browser, cache, server)` as today; `landing: true` loads the bridge at `http://localhost:5180/` with no room session (the noop-stub route); `putItem(browser, item)`; `unlockLockedRoom(server)`. Behaviour of existing options identical.
- Consumes: `fakeLockedRelay` etc. from `src/test-support/fake-locked-relay.js`. `SESSION_TTL_MS`, `LOCK_PASSWORD` and `OfflineSocket` have no other users and stay private to the harness. `storage-bridge.test.js` keeps its own `import { fakeLockedRelay, LOCKED_TEST_CODE, LOCKED_TEST_HANDLE, LOCKED_TEST_TOKEN }` (`LOCKED_TEST_HANDLE` is used at lines 664, 666, 769) and imports `LOCKED_EPOCH` (3 uses) and `ROOM_KEY_CHANGED_EVENT` (2 uses) from the harness.

- [ ] **Step 1:** Move `OfflineSocket`, `unlockLockedRoom`, `withStorage`, `putItem`, `VALID_ITEM`, `ROOM_HANDLE` and the lock constants they need from `storage-bridge.test.js:9-76` into `bridge-harness.js` unchanged, add the `landing` option, import them back. Run `node --test src/client/session/storage-bridge.test.js`: all 36 tests pass (the count must not change; this is the step 1 gate, with no `ReferenceError` for a moved constant).
- [ ] **Step 2: Write `storage-contract.test.js`** (failing first against an empty contract). Tests:
  - `every storage method the client calls exists on the board route`: statically scan `RetroBoard.jsx` and every non-test file under `src/client` for `(?<![A-Za-z])(?:window\.)?storage\??\.([A-Za-z]+)`, excluding `localStorage`/`sessionStorage`; assert each name is in `Object.keys(window.storage)` of the board route. Any name that is not a storage member goes in `NOT_STORAGE_MEMBERS` with a one-line reason (expected empty).
  - `board route keys equal the frozen contract`: `assert.deepEqual([...Object.keys(storage)].sort(), BOARD_KEYS)`, where `BOARD_KEYS` is the consumer-scan names plus the explicitly listed `UNCONSUMED_BUT_FROZEN` members (each with a reason, e.g. used only by e2e hooks or poker); a key present in storage but in neither list fails.
  - `the public wall route is the board route without boardReactions and writingTimer` (spec: retro-only, `storage-bridge.js:1457` comment).
  - `a locked room adds rotationSource and nothing else`.
  - `the landing stub has exactly the frozen no-op keys` and `every landing stub method is inert`: `await get('anything')` is `null`; `snapshotTemplates()` is `[]`; `putTemplate()`/`removeTemplate()` are `false`; `findRemoteBusyItem()` is `null`; `getRemoteBusyItems()`, `getRemoteEditingItems()`, `getRemoteSelectedItems()` are empty `Map`s; `getPresenceSnapshot()` is `{}`; `onBusyChange`, `onEditingChange`, `onSelectionChange`, `onPresenceChange` return a function.
  - `method arity is frozen`: table `{ name: length }` for every method in `BOARD_KEYS` that is a function, read from each parameter list in `storage-bridge.js`.
  - The file header states this is a deliberate freeze contract (a refactor-safety net for the P1+ moves, not a behaviour spec), so deriving `BOARD_KEYS` and the arities from current code is intended. Each `UNCONSUMED_BUT_FROZEN` entry carries a reason citing its consumer (e2e hook, poker, `CONTEXT.md` or `SECURITY.md` section). Step 4's red proofs show the test catches drift.
- [ ] **Step 3:** Run `node --test src/client/session/storage-contract.test.js`; all pass.
- [ ] **Step 4: Revert checks (record each red, then restore):** add a dummy parameter to `addItem` (arity test red); rename `getPresenceSnapshot` in the stub (landing keys test red); in `storage-bridge.js` change `route.kind === 'board'` to `['board','public'].includes(route.kind)` at the reactions block (public test red).
- [ ] **Step 5:** Full gate; commit `test(storage): freeze the window.storage surface for board, public and landing routes`.

### Task 4: Bridge emits `isUndoRedo` (INV-2, INV-4)

**Files:** Modify `src/client/session/storage-bridge.test.js` (new tests, using `withStorage`).
**Interfaces:** Consumes `withStorage`, `VALID_ITEM`; the bridge's `storage.on(handler)` (`detail = { scope: 's', key: 'boardState', value, isUndoRedo, deletedItemIds }`), `storage.addItem`, `storage.undo`, `storage.redo`.

- [ ] **Step 1: Write tests** (they pass on current code; red proof is step 2):
  - `undo and redo each emit boardState with isUndoRedo true`: collect `boardState` events; `addItem(VALID_ITEM)` then `stopUndoCapture()`; `undo()` yields one event with `isUndoRedo === true` and `value.items` lacking the item; `redo()` yields one event with `isUndoRedo === true` and the item present.
  - `a local write does not echo`: `addItem` and `updateItem` produce zero `boardState` events.
  - `a remote update and a system write are not undo or redo`: apply an update from a second `Y.Doc` with origin `peer` (as in `storage-bridge.test.js:78-114`) and run `ydoc.transact(() => yMeta.set('title','x'), 'system')`; both events have `!isUndoRedo`.
  - `undo of a vote does not set the boardState flag`: `undo()` after a vote toggle emits no `boardState` event with `isUndoRedo` (kv keys dispatch their own change events).
- [ ] **Step 2: Revert check:** in `storage-bridge.js` `fireBoardChange` (`:525`) change `origin === undoManager` to `false`; the first test must FAIL; restore.
- [ ] **Step 3:** Run file; full gate; commit `test(storage): undo and redo flag board changes, local writes do not echo`.

### Task 5: Observer order (spec §5.2 "5 ymap.observe handlers keep order")

**Files:** Modify `src/client/session/storage-bridge.test.js` (new tests, shared harness; the spy is installed inside the test before `withStorage` loads the bridge).
**Interfaces:** Spy: replace `Y.Map.prototype.observe` with a wrapper that records `{ target, handler }` then calls the original; restore in `finally` by `delete Y.Map.prototype.observe` (the method is inherited from `AbstractType`, so assigning the original back would leave an own property behind; or restore the saved own-property descriptor if there was one). The bridge's `yjs` is the same externalized module instance the test imports (existing tests already mix instances).

- [ ] **Step 1: Write tests:**
  - `the kv map has exactly five observers, registered in the order change dispatch, votes, comments, templates, moods`: record handlers whose target is `browser.__rbYDoc.getMap('kv')`; assert length 5. Classify each by feeding it a synthetic event `{ keysChanged: new Set([key]), transaction: { origin: 'peer', local: false } }` with one probe key per kind after writing a matching value into the map (vote key `s||vote:<itemId>:<userId>` shaped as `parseVoteKey` expects, a comment key, a template key from `isTemplateKey`, a mood key from `moodKey`), and observing which emitter fires (`storage.on` change, `onVotesChange`, comments, templates, moods listeners). Assert the classified sequence equals `['change','votes','comments','templates','moods']`.
  - `one remote transaction touching all five key kinds notifies in that order`: apply one update that sets a vote, comment, template and mood key plus a plain `u|` key; subscribe to all five emitters and assert the arrival order equals the same sequence.
  - `the board-change observers are yItems.observeDeep then yMeta.observe`: spy `observeDeep` and `observe` on `yItems`/`yMeta`; each registered once (Public additionally registers the creation guard on `yItems` at `storage-bridge.js:188`). Other modules register on the same maps (`drawing-previews.js:79` does `items.observe(itemsChanged)` on both routes, `e2e-vote-expiry.js:82` does `yItems.observeDeep` on locked rooms), so the spy keeps only handlers registered from `storage-bridge.js` (record `new Error().stack` at registration and filter on the `storage-bridge.js` frame) or, alternatively, the public test asserts only the board-vs-public DIFFERENCE: exactly one extra storage-bridge `yItems.observe`, registered before the kv handlers. Never assert a global count of `yItems.observe`.
- [ ] **Step 2: Revert check:** swap the template and mood `ymap.observe` blocks (`:651` and `:660`) in a scratch edit; the order tests must FAIL; restore.
- [ ] **Step 3:** Run file; full gate; commit `test(storage): pin the five kv observers and their notification order`.

### Task 6: Ratchets for `storage-bridge.js`, `i18n.js` and a generic oversize guard (design P0 task 6)

**Files:** Modify `src/rule-ratchets.test.js`.
**Interfaces:** Produces `STORAGE_BRIDGE_MAX_LINES = 1469`, `I18N_MAX_LINES = 2506` (the measured `wc -l` today; re-measure before writing), keys `src/client/session/storage-bridge.js` and `src/client/ui/i18n.js` added to `LINE_CEILINGS`; `export function oversizeWithoutCeiling(lineCounts: Map<string, number>, ceilings: Map<string, number>, maxLines: number): string[]`; `UNCEILINGED_MAX_LINES = 1250`; shared `countLines(source)` extracted from `assertLineCeiling` (same counting, trailing newline excluded).
- [ ] **Step 1: Write failing tests:** `storage-bridge.js stays within its frozen line ceiling` and `i18n.js ...` come from the existing loop once the map has the entries (the new `LINE_CEILINGS` entries must be written failing first by setting them to `lines - 1` and seeing red, then correct); `every production source above 1250 lines has its own ceiling` (reads `productionSources()`); `oversizeWithoutCeiling flags an unlisted file at 1251 lines and accepts one at 1250 or one with a ceiling` (in-memory maps).
- [ ] **Step 2:** Implement; run `node --test src/rule-ratchets.test.js`. The nine locale files (1176 lines each) must pass without entries.
- [ ] **Step 3: Revert checks:** append one line to `storage-bridge.js` (red), restore; append one line to `i18n.js` (red), restore; add 75 blank-comment lines to a scratch `src/client/ui/locales/de.js` (guard red), restore.
- [ ] **Step 4:** Full gate; commit `test(ratchet): freeze storage-bridge and i18n sizes and guard new oversize files`.

### Task 7: Remove dead constants and the stale comment in `RetroBoard.jsx` (design P0 task 7, R1)

**Files:** Modify `RetroBoard.jsx` (delete `const SAVE_DEBOUNCE = 200;` and `const TEXT_SAVE_DEBOUNCE = 350;` at `:161-162`, `const clamp = ...` at `:200` plus one adjacent blank line, and the orphaned comment block `:149-154` ("A full board import writes every item ... belt-and-suspenders net for anything that still doesn't fit.", which precedes `DRAG_THRESHOLD` and describes a constant that no longer exists)); modify `src/rule-ratchets.test.js` (`RETRO_BOARD_MAX_LINES` to the measured count, expected 3983).

- [ ] **Step 1:** Prove unused: `rg -n "\bSAVE_DEBOUNCE\b|\bTEXT_SAVE_DEBOUNCE\b|\bclamp\b" RetroBoard.jsx` shows only the three definitions (the current tree: yes), and `rg -n "IMPORT_MAX_BUNDLE_BYTES|belt-and-suspenders" RetroBoard.jsx` shows the comment has no matching constant in the file. Record the output.
- [ ] **Step 2:** Delete the lines; `wc -l RetroBoard.jsx`; set the ceiling to exactly that number.
- [ ] **Step 3: Revert check:** the ratchet is the test: restore the three constants, the ceiling test must FAIL at the new ceiling; delete again.
- [ ] **Step 4:** Full gate. Live smoke (orchestrator tier, you run it): `node scripts/live-check-all.mjs --only ui --out-root .../7`; its PASS lines must match the manifest baseline. Ports free. Commit `chore(board): drop unused constants and an orphaned comment, lower the ceiling`.

### Task 8a: Remove `retro_board_prompt.md` and three unused functions (design P0 task 8, H3 + H5 part 1)

**Files:** Delete `retro_board_prompt.md`; modify `src/client/app/router.js` (remove `generateBoardCode`, `generateBoardToken`), `src/client/ui/theme.js` (remove `getThemePref`).
- [ ] **Step 1:** `rg -n "retro_board_prompt" . --glob '!docs/**' --glob '!.git'` (already shows no references; also check `Dockerfile*`, `.dockerignore`, `package.json`) and `rg -nw "generateBoardCode|generateBoardToken|getThemePref" . --glob '!docs/**'` shows only each definition. Record.
- [ ] **Step 2:** Remove them (also any import or comment left orphaned by the removal, nothing else). Revert check: restore one function; no test fails (unused), so the proof is the rg output plus `npm run build` passing.
- [ ] **Step 3:** Full gate plus `npm run maintainer:build`; commit `chore: remove an unreferenced prompt file and three unused helpers`.

### Task 8b: Un-export dead exports, `src/domain` and `src/server` (H5 part 2)

**Files:** Modify only the declaration lines (drop the `export` keyword) in the files below. Nothing is deleted and no value changes: each name is still used inside its own file (`ownUses >= 2` in the scan).
Domain (22): `board-ownership.js` effectiveArea; `import-schema.js` IMPORT_MAX_COMMENTS, IMPORT_MAX_COMMENTS_PER_ITEM, IMPORT_MAX_RECORDS, IMPORT_MAX_VOTES; `item-size-limits.js` IMAGE_MAX_SIDE_PX, STICKY_MAX_SIDE_PX, TEXT_MAX_SIDE_PX (NOT used by task 1b.2, which imports `ITEM_MAX_SIDE_PX`); `public-zone-layout.js` enlargedZoneGeometry, PUBLIC_ZONE_LAYOUT_SCALE_FACTOR; `room-retention.js` IDLE_ROOM_RETENTION_MS; `security-boundaries.js` GIF_MAX_DIMENSION, GIF_MAX_PIXELS; `template-model.js` TEMPLATE_PLACEMENT_GAP_PX, TEMPLATE_PLACEMENT_MAX_RINGS; `template-store.js` LEGACY_TEMPLATE_KEY, TEMPLATE_PREFIX; `vote-results.js` VOTE_RESULTS_VERSION; `zone-title.js` ZONE_AUTO_TITLE_FONT_STEP_PX, ZONE_AUTO_TITLE_HEIGHT_PER_FONT_PX, ZONE_AUTO_TITLE_MIN_FONT_PX, ZONE_AUTO_TITLE_WIDTH_PER_FONT_PX.
Server (25): `auth-google.js` MAX_PENDING_FLOWS, TOKEN_EXCHANGE_TIMEOUT_MS; `e2e-blobs.js` E2E_BLOB_CACHE_CONTROL, E2E_BLOB_CONTENT_TYPE; `e2e-relay.js` REPLAY_CHUNK_BYTES, REPLAY_CHUNK_FRAMES, REPLAY_DRAIN_TIMEOUT_MS; `maintainer-snapshot.js` maintainerRooms; `public-action-limit.js` publicSyncUpdate; `public-wall-config.js` PUBLIC_MAX_DATABASE_BYTES; `relay-http.js` readBoundedBody; `relay-maintenance.js` pruneBuckets; `relay-room-registry.js` UNLOCKED_REGISTRATION_MARKER; `relay-uploads.js` E2E_BLOB_EXTENSION, IMAGE_SNIFF_BYTES; `room-deletion.js` decodeDeletionEntry, DELETE_DRAIN_TIMEOUT_MS, DELETE_STATUS, DELETION_KEY_PREFIX; `room-lock-commit-body.js` MAX_KEEP_BLOBS, parseCommitHeader; `room-lock-routes.js` MAX_PASSWORD_BODY_BYTES; `room-lock.js` DEFAULT_VERIFIER_MAX_KEYS, WRONG_PASSWORDS_PER_ROOM; `room-title-writer.js` TITLE_UNLOAD_RECHECK_MS.

- [ ] **Step 1: Re-verify every name before touching it.** For each: `rg -nw <name> . --glob '!docs/**' --glob '!node_modules'` must show only its own file; also `rg -n "import \* as .* from '.*/<module>'|import\(.*<module>|export \* from '.*<module>'"` must be empty for that module. A name that fails either check is skipped and reported, never forced.
- [ ] **Step 2:** Remove `export ` from each verified declaration. No `Dockerfile.yjs` change is needed (files unchanged in set); `src/server/relay-image-files.test.js` must still pass.
- [ ] **Step 3:** Full gate (relay and spawn suites run in `npm test`); `npm run maintainer:build`. Revert check: an export cannot be "reverted" by a failing test, so the proof is the rg output per name, a green `npm run build` and `npm run maintainer:build`, and a scratch test importing one un-exported name that must fail to import (delete the scratch).
- [ ] **Step 4:** Relay smoke (orchestrator tier): `room-lock` and `room-management` through the runner exercise the server modules at runtime; PASS lines match the manifest baseline; ports free. `npm run build` and `npm run maintainer:build` already cover import resolution, so this is belt-and-braces against a namespace or dynamic import the rg scan missed.
- [ ] **Step 5:** Commit `chore(domain,server): stop exporting names nothing imports`.

### Task 8c: Un-export dead exports, `src/client` (H5 part 3)

**Files:** declaration lines only, same rules as 8b (re-verify each name, skip failures).
Client (46): `account/AccountMenu.jsx` SignedOutControl; `app/Landing.jsx` RECENTS_SECTION_ID; `app/LandingGuide.jsx` GUIDE_FAQ_KEYS, GUIDE_FEATURES, GUIDE_STEP_KEYS; `board/appear-animation.js` APPEAR_ANIMATION_MAX_AREA_CSS_PX2; `board/DrawingAutosave.js` DRAWING_AUTOSAVE_IDLE_MS; `board/grid-background.js` liveTextureZoom; `board/mobile-editor-viewport.js` mobileEditorWidthLimitPx; `board/selection-toolbar-model.js` FONT_SIZE_MAX_PX, FONT_SIZE_MIN_PX; `board/SelectionToolbar.jsx` FontColorPicker; `board/sticky-font.js` STICKY_CREATION_MAX_WIDTH_PX, STICKY_DEFAULT_FONT_PX; `chrome/chrome-layout.js` MINIMAP_ZOOM_GAP_PX, TOAST_DOCK_GAP_PX, ZOOM_CONTROLS_H_PX; `maintainer/monitoring-model.js` CRITICAL_USAGE_RATIO, WARNING_USAGE_RATIO; `maintainer/Monitoring.jsx` ResourceAlerts; `poker/poker-actions.js` POKER_ORIGIN; `public-wall/snapshot-image-resource.js` SNAPSHOT_IMAGE_CACHE_MAX_ENCODED_BYTES; `reactions/reaction-channel.js` reactionSenderName; `room-lock/e2e-images.js` BlobNotFoundError, E2E_EPOCH_CACHE_MAX_ENTRIES, e2eImagePath; `room-lock/rotate-room.js` ROTATION_IMAGE_TIMEOUT_MS; `seo/seo-pages.js` SEO_LANG; `session/awareness-transport.js` MOTION_BROADCAST_MS; `session/client-sync.js` BOARD_SHARED_MAP_NAMES; `session/e2e-image-repair-schedule.js` IMAGE_REPAIR_DEBOUNCE_MS; `session/e2e-provider.js` E2E_MAX_BACKOFF_MS, E2E_SYNCED_SETTLE_MS; `session/e2e-vote-expiry.js` E2E_VOTE_GRACE_MS; `session/player-cursors.js` PLAYER_CURSOR_MAX_WORLD_COORD; `session/room-deleted.js` ROOM_DELETED_EVENT; `session/room-session.js` validateLockedResponse, validateLockGrant; `session/RoomDeletedBoundary.jsx` RoomDeletedScreen; `session/SyncBanner.jsx` useSyncStatus; `session/useAdminRole.js` HEARTBEAT_MS; `transfer/board-image-export.js` readBoardImageLook; `transfer/use-board-exports.js` boardImageLabels, summaryLabels; `ui/palette.js` DOCK_TILE_NAME; `writing-timer/WritingTimer.jsx` EndAnnouncer.
Do not touch `RetroBoard.jsx` here (no line count change, ceiling unchanged).

- [ ] **Step 1:** re-verify each name as in 8b; skip and report any that fails. **Step 2:** remove `export `. Confirm `src/rule-ratchets.test.js` colour scan and `src/architecture.test.js` stay green.
- [ ] **Step 3:** Full gate plus `npm run maintainer:build`. Live smoke (orchestrator tier): `ui`, `landing` and `room-lock` through the runner (room-lock covers the room-lock, session and e2e client modules at runtime); PASS lines match the manifest. Ports free.
- [ ] **Step 4:** Commit `chore(client): stop exporting names nothing imports`.

### Task 9: Prepare the AGENTS.md and ARCHITECTURE.md corrections as a patch, then STOP (design P0 task 9, map §9)

**Files:** Create `docs/superpowers/plans/2026-11-19-p0-doc-corrections.patch`. Must NOT commit `AGENTS.md` or `ARCHITECTURE.md`.
**Interfaces:** Consumes the final ceilings from tasks 6-7.

- [ ] **Step 1:** Edit the two files in the worktree. AGENTS.md: replace the literal "`RetroBoard.jsx` (4177 lines) and `yjs-server.mjs` (1836 lines)" with wording that points at the authoritative ceilings in `src/rule-ratchets.test.js` (no literal counts, so it cannot go stale again) and names the new `storage-bridge.js` and `i18n.js` ceilings; leave the `th`/`en` i18n sentence (it changes in P2). ARCHITECTURE.md: replace "4,177 and 1,881 lines" the same way; extend the `src/client/` tree with the directories that exist and are missing (`account`, `guide`, `maintainer`, `poker`, `reactions`, `room-lock`, `seo`, `workspace`, `writing-timer`), each with a one-line responsibility read from the directory's files; add `scripts/live-check-all.mjs`, `live-check-common.mjs` and `live-check-manifest.json` to the scripts block.
- [ ] **Step 2:** `git diff -- AGENTS.md ARCHITECTURE.md > docs/superpowers/plans/2026-11-19-p0-doc-corrections.patch`, then `git checkout -- AGENTS.md ARCHITECTURE.md`. Verify `git apply --check` against the worktree and, read-only, `git -C /Users/sakontheerasuwanajak/Documents/miro apply --check <patch>` (the main checkout has an uncommitted AGENTS.md edit around lines 86-95; the hunks here are far from it and must still apply). Write nothing in the main checkout.
- [ ] **Step 3:** Commit only the patch file (`docs(plans): prepared AGENTS.md and ARCHITECTURE.md corrections for owner approval`). Report and STOP: the owner approves and applies; do not apply.
- [ ] **Step 4 (before the report):** re-record `baselines.unitTests` as `atEnd` `{ commit, tests, pass, fail }` from the final gate log in the manifest (a manifest-only commit `test(live): record the end-of-P0 unit test count`); later phases compare against `atEnd`. Add the one-line explanation to the manifest's `scripts/README.md` entry in the same commit.

---

## Rejected critique

None of the critique items was rejected. Facts verified against the code while applying them: `dragItemsRef.current = null;` appears at `RetroBoard.jsx:2271, 2322, 2394, 2445, 2548, 2694` (the item-drag `finalize` is 2322 and its blur listener is `:2338`); `confirmImport`'s `setBoard(nextBoard)` is `:3168` (`:824` is another call); `drawing-previews.js:79` and `e2e-vote-expiry.js:82` register on the item map; `landing-live-check.mjs` treats any `/yjs` or `/yjs-public` WebSocket as an unexpected write and `modal-live-check.mjs` only opens board URLs, so neither needs `publicRelay` (marked as a task-2 setup fix if wrong).

## Self-review

1. **Spec coverage (§6 P0):** (a) runner and common helpers: task 1 (deviation 1); (a2) five checks written and recorded: 1b.1-1b.5 then task 2; (b) baseline: task 2; (c) contract test: task 3; (d) isUndoRedo: task 4; (e) observer order: task 5; (f) ratchets: task 6; (g) test count and bundle baselines: task 2 step 3; tasks 7, 8, 9 as listed. §7.3 table: all five scripts. §7.5 policy: `judgeRun`, task 2 step 2. §5.4 not needed in P0 beyond not adding a render-hook helper. Exit criteria: ceiling lowered in task 7; each new test has a stated revert check.
2. **Step scan:** every code step names file, signature and values; no step says "handle edge cases".
3. **Type consistency:** helper names `boardItems`, `itemById`, `stickyBox`, `dragBy`, `withinPx`, `boxCenter` are defined in task 1 and used identically in 1b.x; `withStorage` options match tasks 3-5; manifest ids match task 2's list.
4. **Review Focus:** items 1-2 are tested in task 1, 3 in the shared `dragBy`, 4 in task 3, 5 in 8b/8c.
5. **Proportion:** signatures, test names and assertions only; no function bodies.
