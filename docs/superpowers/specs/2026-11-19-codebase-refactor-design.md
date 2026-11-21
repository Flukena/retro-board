# RetroBoard codebase refactor: design (2026-11-19)

Input: the factual map `docs/superpowers/specs/2026-11-19-codebase-current-state.md` (main @ 5493a90). Section ids below (R*, S*, Y*, U*, T*, H*) are the map's seam ids (map §10); invariants (INV-n) are the map's §4 table. Line numbers are against main @ 5493a90 (`RetroBoard.jsx` and `yjs-server.mjs` sit at the repo root); re-grep symbols before editing. "(inferred)" = not verified by running code.

## 1 Intent and why (ruling R0)

Owner ruling R0: whole-codebase refactor for maintainability, ZERO behaviour change, no further detail given. Concretely:

- Two frozen files dominate cost: `RetroBoard.jsx` 3993 lines (238 hook calls, map §2) and `yjs-server.mjs` 1445 lines; `storage-bridge.js` 1469 lines has no ratchet; `i18n.js` 2504 lines is churned by every feature.
- Work is done by AI subagents task by task with a review per task, so every task must be independently verifiable and leave main releasable.
- Production runs on this Mac and deploys need owner approval, so the refactor ships in batched releases.
- Nine collaboration invariants have no unit guard today (INV-1,3,5-fixture,6,7,9,14,15 and the bridge half of INV-2; map §4, §8). That is why the safety net lands before the moves.

## 2 Goals, non-goals, anti-goals

| Kind | Item |
|---|---|
| Goal | RetroBoard.jsx and yjs-server.mjs shrink, ceilings (`src/rule-ratchets.test.js:8-9`) lowered in the same commit as the removed lines |
| Goal | New focused modules with paired colocated tests (`.test.js`, since `.test.jsx` is not discovered, map §8 / `scripts/project-files.mjs:6`) |
| Goal | All 15 invariants map to a named unit test or a named live check by the end |
| Goal | storage-bridge.js gets a ratchet, then shrinks to a composition root; i18n.js becomes a runtime over static locale modules |
| Goal | New code: Sonar-clean, cognitive complexity <= 15, one-way dependencies (`src/architecture.test.js`), Warm Studio tokens, i18n th/en parity |
| Non-goal | e2e-provider.js (already factored), room-session state machine location (S9 optional), CSS, maintainer app, poker, nine generated locales, theme token values |
| Non-goal | New runtime dependency, new framework/state manager, TypeScript, lazy th, live checks in CI |
| Anti-goal | ANY behaviour change: copy, URLs, UX, timing constants (24 ms, 60/80 ms, 8000 ms, 30 s, 500 ms), effect order, render count of memoised items |
| Anti-goal | Wire-format or storage-schema change (Yjs keys, window.storage method names/arity, relay close codes/HTTP statuses/log lines/error strings) |
| Anti-goal | Raising any ceiling or ratchet baseline; silencing a gate (`NOSONAR`, skip, loosened tests) |
| Anti-goal | Unifying `uid()` (Math.random) with `createRandomId` (Web Crypto) (map §11 Q4) |
| Anti-goal | Merging the default item-size variants (0 vs 200 vs `sizeForPlacement` 1200x1080) or the `isPlainObject` variants that differ on arrays (map §9, §11 Q5) |
| Anti-goal | Merging `startItemDrag`/`startZoneDrag` (about 90% duplicate, not proven equal) or moving the optimism refs out of React into a factory |
| Anti-goal | Merging the 24 ms component cursor throttle with the 100 ms awareness-transport throttle (INV-11) |

## 3 Constraints

| Constraint | Consequence for the plan |
|---|---|
| Frozen-file ceilings only go down (`rule-ratchets.test.js:8-9`) | Each task commit sets the ceiling to the MEASURED post-move line count (never a projected target) |
| `Dockerfile.yjs:31-47` COPY lists every `src/server` and `src/domain` file; guard is `src/server/relay-image-files.test.js:8-37` | Any new file imported (transitively) by `yjs-server.mjs` is added to the COPY list in the same commit; relay-image-files test runs in every relay or domain task. New client-only files are not added |
| Source-scanning tests: `confirm-then-pin.test.js:6`, `theme.test.js:151`, `i18n-keys.test.js:7-13,27`, `rule-ratchets.test.js:58`; relay: `resilience.test.mjs:12-24,32,48,65,103,114`, `relay-http.test.js:98-107,154`, `relay-local-files.test.mjs:39-41`; `Landing.test.js:55` (passes vacuously after a move) | Phase 1 migrates them before any code moves; afterwards only the ratchet reads RetroBoard.jsx/yjs-server.mjs text |
| One Chromium at a time, live checks manual (`scripts/*live-check*.mjs`) | A single sequential runner; live-run slot serialises tasks that need it; Codex cannot launch Chromium in worktrees so the orchestrator runs live checks and commits |
| Owner-approved releases only | Phases end releasable; deploys batched at release points (§6); no agent touches compose, tunnel, `.env`, backups |
| No edits to nginx CSP, cloudflared, compose security settings, `.github/workflows` | No CI wiring of live checks |
| AGENTS.md is shared with Codex and has an uncommitted edit in the main checkout | Doc fixes to AGENTS.md are prepared as a diff and stop for owner approval |
| Data location rule | Live-run logs and captures go to `/Volumes/ssd-fluke/BaseData` (or stop if unmounted), symlinked under `~/basedata/<project>/<task>` |
| Hooks must stay above the `if (!loaded)` early return (`RetroBoard.jsx:3596`) | Lint-style test (P5) scans for hooks after it |

## 4 Approaches considered

| Proposal | Idea | Judge 1 | Judge 2 | Judge 3 | Mean (of 48-ish) | Key weakness |
|---|---|---|---|---|---|---|
| safety-first | Characterise, then move, one releasable gate at a time; coupled core last | 48 | 49 | 48 | 48.3 | Risk concentrated in last phase (18 tasks), no stop rule, 900-line target speculative |
| velocity-first | Order by git churn x low risk; defer core, conditional P7 | 48 | 45 | 48 | 47.0 | Leaves RetroBoard.jsx at about 2800-3000 lines; churn data is mostly November |
| architecture-first | Target-first: optimism guards factory, ViewportPort, bridge factory, 250/1500-line targets | 38 | 43 | 41 | 40.7 | Moves refs out of React, event-inverts follow ordering, merges drag paths: behaviour risk |

Chosen: safety-first as the base, unanimous winner. Grafts and explicit resolutions:

| Disagreement or choice | Resolution | Reason |
|---|---|---|
| Churn ordering vs strict safety order | Keep safety-first order but pull `i18n` locale split and the key-router/dialog-host seams forward (velocity-first) | i18n.js is the most-touched non-frozen file (48 touches) and parallel subagents adding `t()` keys collide there |
| Coupled-core stop rule | Adopted from velocity-first: if a live check or state-machine test fails twice on a P6 task, stop the phase, keep what shipped, report; final shrink target is measured, owner opts in after P5 release | Avoids an unbounded high-risk tail |
| Optimism state location | Stay React refs behind handles (safety-first); `createLocalOptimismGuards` factory REJECTED | Refs are mutated inside `setBoard` updaters (INV-15); moving them changes timing (arch-first admits "inferred only") |
| Bridge as `createStorageBridge(deps)` factory | Not in this refactor. Bridge stays the single import-time singleton loaded from `main.jsx:48` and becomes a composition root over pure modules that each take `{doc, awareness, clock}` style params so they are testable on a bare `Y.Doc`. A factory is an optional follow-up after P3 | Contract + observer-order test pin behaviour; avoids changing singleton semantics now |
| ViewportPort | Adopted as an interface shape (get/commit getters) for follow and minimap; NOT the `onUserNavigated` event inversion | Inversion changes call order of stopFollowing vs commit (INV-9) |
| Drag/zone unification | Rejected (arch-first). Shared gesture lifecycle helper allowed only if it is a pure move of identical exit-path cleanup, proven by the state-machine test | Zero behaviour change |
| Folder layout | `src/client/board/` is flat (about 150 files, map note); new code goes to feature subfolders only where listed in §5; no mass move | Keeps blame and diffs small |
| Late-bound relay callbacks | Adopted (arch-first): one late-binding object plus a test that fails when a callback is unset | Y-seam forward refs (map §6) |
| Extra architecture rules | Adopted: `architecture.test.js` folder rules (follow and minimap must not import viewport internals; bridge modules must not import the bridge root) | Enforces one-way deps |
| Targets | RetroBoard.jsx "under 900" demoted to aspirational; committed numbers are measured per phase; yjs-server.mjs about 600; storage-bridge.js under 400 | Estimates overlap (map §11 Q1) |

## 5 Target architecture

### 5.1 Layout (new files only; existing files stay)

| Folder | New modules (each with colocated `*.test.js`/`*.test.mjs`) | Seams |
|---|---|---|
| `src/domain/` | `vote-comment-keys.js` (key schema), `zone-move-lock.js`, `item-factory.js` (named size variants), `apply-remote-snapshot.js` (pure reducer), `undo-guard.js`, `resize-geometry.js`, `duplicate-items.js` | R9 R10 R16 T1 R14 R33 R24 S5 |
| `src/client/ui/` | `locales/th.js`, `locales/en.js` (static), `language-options.js`, `use-toast.js`, `BoardDialogs.jsx`; `i18n.js` becomes runtime (~100 lines) | U1 U2 R3 R18 |
| `src/client/board/` | `use-browser-zoom-guard.js`, `board-key-router.js` + `use-board-shortcuts.js`, `use-undo-redo.js`, `use-board-writes.js`, `use-vote-state.js`, `use-admin-actions.js`, `use-selection.js`, `use-minimap.js`, `use-viewport-controller.js`, `use-follow-controller.js`, `pointer-gesture.js`, `use-drag-gestures.js`, `use-canvas-pointer.js`, `RemoteCollaborationLabels.jsx`, `CanvasOverlays.jsx`, `BoardItems.jsx`, `SelectionLayer.jsx`, `BoardCanvas.jsx`, `BoardCanvasView.jsx`, drag/cursor/minimap/follow constant modules | R2 R4 R6 R7 R19-R33 |
| `src/client/session/` | `latest-throttle.js`, `use-presence-broadcast.js`, `use-editing-presence.js`, `use-board-sync.js`, `RemoteCursorLayer.jsx`; `bridge/` modules (below) | R11 R15 R17 R30 S* |
| `src/client/session/bridge/` | `snapshot-doc.js`, `awareness-presence.js`, `user-prefs.js`, `public-permit.js`, `import-plan.js`, `undo-controller.js` | S1-S7 |
| `src/client/transfer/` | `use-board-import.js`, `use-image-import.js` | R12 R13 |
| `src/client/chrome/` | `use-topbar-props.js` | R8 |
| `src/client/app/` | `BoardLoading.jsx` | R5 |
| `src/server/` | `relay-client-ip.js`, `relay-origins.js`, `relay-admission-limits.js`, `relay-awareness-policy.js`, `relay-room-accounting.js`, `relay-vote-expiry.js`, `relay-persistence.js`, `relay-room-state.js`, `relay-ws-admission.js`, `relay-ws-connection.js`, `relay-upgrade.js`, `relay-http-dispatch.js`, `relay-runtime.js`, `relay-late-bindings.js` | Y1-Y14 |
| `src/test-support/` | `fake-clock.js` (injectable clock and timers for controllers), `ssr-load.js` (vite `ssrLoadModule` loader for `.jsx` imports, as `TopBar.test.js` does); NO `render-hook.js` (it cannot run effects, see §5.4) | T2 |
| `scripts/` | `live-check-all.mjs` (sequential runner), `live-check-common.mjs` (participant/activate/step helpers), new live checks (§7.3) | T3 |

### 5.4 Testing stateful hooks (decision D-HOOK, default Option A)

`renderToString`/`renderToStaticMarkup` render once and never run `useEffect`, `useLayoutEffect`, cleanup or timers, so a react-dom/server driver cannot give effect-order, unmount-cleanup or timer coverage. Existing component tests use vite `ssrLoadModule` (`TopBar.test.js`), which covers markup only; any test importing a `.jsx` module must use that loader (`src/test-support/ssr-load.js`).

- Option A (default, no new dependency): every piece of stateful logic (throttles, flush timers, presence broadcast, busy claim, gesture state machine, unmount cleanup, sync reconcile) is written as a plain-JS controller (closure or class taking handles and an injected clock, in a `.js` file) and unit-tested with fake timers. The hook is a thin wrapper (create controller in a ref, call it from effects, return handles) with no logic of its own. Effect order, render count and cleanup-on-unmount of the WRAPPERS are verified only by live checks plus the hook-order lint test; the design claims no unit coverage for them.
- Option B (owner decision): add a dev-only test renderer (`react-test-renderer` or `@testing-library/react` with jsdom) as a devDependency so hooks and effects run under test. It is not a runtime dependency, but it changes `package.json`/lockfile and the Docker/CI install surface, so it needs owner approval before P5. If approved, wrappers also get effect-order and unmount tests; controllers still stay plain JS.
- Consequence: P5/P6 task lists below say "controller + wrapper"; safety-net lines claim unit tests for controllers and live checks for wrappers.

Dependency direction is unchanged: domain <- client/server <- composition roots (`RetroBoard.jsx`, `storage-bridge.js`, `yjs-server.mjs`). `src/architecture.test.js:17-54` stays green and gains the folder rules above.

### 5.2 Owners of the coupled clusters (single owner each, no back-references)

| Cluster | Owner module | Interface | Rules |
|---|---|---|---|
| `pendingGeomRef`, `lastFlushRef`, `saveTimerRef`, `recentlyMovedRef` | `use-board-writes.js` (R29) | returns `commitGeometry`, `recentMoves = {mark(ids), has(id), forget(ids), clear()}` | Storage first then optimistic `setBoard` (INV-1); locked-zone filter via `domain/zone-move-lock.js` (INV-6); 60/80 ms flush and 8000 ms window keep their names (`DRAG_FLUSH_MS`, `DRAG_TRAILING_MS`, `RECENT_MOVE_WINDOW_MS`). Until P6 these refs stay in RetroBoard.jsx and are passed as injected handles |
| `dragItemsRef`, `interactionRef`, busy claim, finalizer refs | `pointer-gesture.js` / `use-drag-gestures.js` (R33) | exposes read handle `isDragging()/dragIds()` to sync and undo | Every exit path (pointerup, pointercancel, Escape, blur, unmount) clears all four (INV-7) |
| `isUndoRedo` consumption and `recentlyMovedRef.clear()` (`RetroBoard.jsx:925`) | `use-board-sync.js` (R30, thin wrapper over a reconcile controller) reconcile step | receives the `recentMoves` handle | Clear happens exactly when the bridge reports `isUndoRedo` (INV-2); `applyRemoteBoard` mutation inside the `setBoard` updater stays idempotent (INV-15) |
| undo guard | `domain/undo-guard.js` + `use-undo-redo.js` (R14) | pure `(midDrag, locked, hasUndo) -> allowed` | takes `midDrag` from the gesture handle |
| viewport, `viewportRef`, `renderedViewportRef`, wheel refs, layer refs, finalizers | `use-viewport-controller.js` (R31) | returns `{viewport, getViewport(), commitViewport(v), animateTo, stopMotion, worldToScreen}`; cull circularity broken with a getter passed at construction | follow and minimap only receive `getViewport/commitViewport`; they never call back into the owner |
| `followedUserIdRef` | `use-follow-controller.js` (R32) | `stopFollowing`, ref set before state (INV-9) | landed with or after R31; `stopFollowing` still invoked by wheel/mousedown/fit/Escape through the same call sites |
| minimap | `use-minimap.js` (R22) | consumes viewport interface only | bidirectional coupling kept as get/commit |
| `window.storage` singleton | `storage-bridge.js` composition root | frozen method names and arity; `Object.keys(window.storage)` identical for board route, noop stub, public-wall route | One Y.Doc; 5 `ymap.observe` handlers keep order (515, 598, 621, 651, 660); `isUndoOrigin` defined before the first observer; `undoManager` still assigned late; `captureTimeout` becomes a named constant (500) |
| relay shared counters (`dbUsageBytes`, `pendingStoreOps/Bytes`, `activeDocumentBytes`, `storageFailure`, `shuttingDown`) | `relay-room-accounting.js` state object | getters, never copied values | test increments then reads |

### 5.3 What the three composition roots become

| File | Now | Becomes | Target (measured, not promised) |
|---|---|---|---|
| `RetroBoard.jsx` | 3993 lines, 238 hooks, gestures/sync/writes inline | Container: composes about 20 hooks, renders `BoardCanvasView`; all hooks above the early return | about 3100 after P5 release series, aspirational under 900 after P6; ceiling = measured count at each commit |
| `storage-bridge.js` | 1469 lines, no ratchet, 475-line literal | Composition root: builds Y.Doc, provider, registers modules in fixed order, assembles `window.storage` from module-provided method maps | under 400; ratchet added at 1469 in P0 |
| `yjs-server.mjs` | 1445 lines | Composition root: env, banner, top-level await ordering (WIPE `:238` before hydrate `:277`; `setPersistence` before `migrateLegacyImages` `:747`), late-bindings object, listen, signals | about 600 |
| `i18n.js` | 2504 lines | `import th`, `import en` (static, synchronous), `LOCALE_LOADERS` for the nine others, `setLang/t/useLang/languageReady` | about 100 |

Module contracts: pure `.js` for logic; hooks take explicit params (no 30-arg grab bags where an object of related handles exists); no module imports upward; relay modules receive callbacks (markStorageFailure -> shutdown, hasActiveRoomCapacity -> e2eRelay, accountRooms -> roomDeletion, HTTP -> roomLockRoutes) via `relay-late-bindings.js`, whose test fails if one is unset.

## 6 Phases (strict order; every phase ends releasable)

Task loop for every task (applies to all phases): (1) characterization test against UNMOVED code, shown passing; (2) move; (3) same test passing against the new module; (4) revert/mutate the moved logic and show the test fails (state it in the task report); (5) `npm test` + `npm run build`; (6) the named live check(s); (7) ceiling lowered to the measured count in the same commit; (8) review incl. RULE CONFORMANCE.

Release points: R-A after P0-P2, R-B after P3+P4, R-C after P5, R-D after P6. Each release needs the full release gate (`DEPLOYMENT.md`) plus the live suite on the release candidate, then owner approval. P3 and P4 touch disjoint files and may run in parallel by separate agents (never two tasks on the same frozen file at once); the live slot is serialised.

### P0 Safety rails and mechanical cleanup

| Field | Content |
|---|---|
| Goal | Tooling and baseline; only trivially reversible changes |
| Seams | S0, T3, T4, R1, H3, H5, U1 (prep), H1 (prepare) |
| Safety net first | (a) `scripts/live-check-all.mjs` + `live-check-common.mjs`, tested by extending `board-live-helpers.test.mjs`; (a2) ALL FIVE new live checks (§7.3: drag-peer, resize, undo-middrag, presence, import-ui) written in P0 against unrefactored main and recorded in the manifest (§7.5) as the baseline, because P2 already touches drag-adjacent and sync-adjacent logic (T1 reducer, R14 undo guard, R10 item factory, R24 router); (b) BASELINE live run of every existing live check on unmodified main, per the manifest policy in §7.5; (c) `storage-contract.test.js`: `Object.keys(window.storage)` for board route, noop stub, public-wall route vs a spec-derived list; (d) bridge test "undo and redo each emit isUndoRedo=true; a local write does not echo" (INV-2/4, gap map §8); (e) observer-order test (5 handlers) with a spy `Y.Map`; (f) ratchets: storage-bridge.js 1469, i18n.js, new file-size ratchet that only lowers; (g) record baselines: npm test count, bundle size |
| Tasks | 1 runner + common helpers; 1b write the five new live checks (§7.3), each shown red when its guarded behaviour is broken; 2 baseline live run into the manifest (§7.5); 3 window.storage contract test; 4 isUndoRedo bridge test; 5 observer-order test; 6 ratchets (bridge, i18n); 7 delete dead constants + stale comment (R1: SAVE_DEBOUNCE `:161`, TEXT_SAVE_DEBOUNCE `:162`, clamp `:200`, comment `:149-154`) and lower ceiling; 8 remove `retro_board_prompt.md` (H3) and rg-verified dead exports in batches (H5, about 70); 9 prepare AGENTS.md/ARCHITECTURE.md corrections (4177/1836 -> actual, tree) as a diff, STOP for owner approval |
| Exit | gate green; baseline recorded; RetroBoard.jsx ceiling 3993 -> measured (about 3975); new tests each shown to fail when the guarded line is broken |
| Risk | low. Release point: with R-A |

### P1 Migrate layout-pinning tests

| Field | Content |
|---|---|
| Goal | Failures after this phase mean real regressions, not layout |
| Seams | prerequisites of R18, Y7, Y10, H2 (the U1 prerequisites, `i18n-keys.test.js` and `Landing.test.js:55`, now live INSIDE P2 task 1, see below) |
| Safety net first | each replacement test proven red on a deliberately mutated copy |
| Tasks | (former tasks 1-2, `i18n-keys.test.js` and `Landing.test.js:55`, are MOVED into P2 task 1: `dict` is not exported from i18n.js and `locales/th.js`/`en.js` do not exist until U1, so those tests cannot be migrated first) 1 `confirm-then-pin.test.js`: replace the regex over the `onConfirm=` expressions in RetroBoard.jsx with an equivalent wiring check on the owner of the dialogs (a `BoardDialogs.jsx` source/props contract once R18 lands; until then keep the regex check and repoint it in the R18 commit) that still asserts the order confirm -> PIN -> admin action; a model-only assertion is NOT enough; 2 `theme.test.js:151` keeps its explicit file list and gains a rule: every R26, R27, R28 (and any task creating a producer of inline `--rb-*` vars) extends the list in the same commit, a missing producer fails loudly; also inventory and keep green the other source-reading tests: `TopBar.test.js:84` (scans TopBar.jsx, TopBarPopovers.jsx, Avatar.jsx for signatures reading `board`/`setBoard`; matters for R8 `use-topbar-props`) and `Modals.test.js:135` (fixed component and CSS pairing list); 3 `resilience.test.mjs` slices -> behaviour tests (spawn or injected deps); 4 `relay-http.test.js:98-107,154` and `relay-local-files.test.mjs:39-41` likewise; 5 `rule-ratchets.test.js:58` reviewed (kept: it is the ceiling check) |
| Exit | no test reads RetroBoard.jsx/yjs-server.mjs text except the ceiling/colour ratchets and the named source-scan tests listed above (each with a documented owner list); npm test green |
| Risk | low. Release: R-A. Root relay tests are NOT moved yet (H2 deferred to the end of P4) |

### P2 Pure-core extractions and early wins (test-first)

| Field | Content |
|---|---|
| Goal | Move every pure rule out first; pull forward i18n and the feature-slot seams (velocity-first graft) |
| Seams | U1, U2, R3, R4, R5, R9, R10, R16, T1, R14 (pure part), R24 (router part), R33 (pure `resize-geometry`), S5 (key schema, now `src/domain/vote-comment-keys.js`), Y1, Y2, Y3, H4 (per module only) |
| Safety net first | (task 1 only: the old `i18n-keys.test.js` runs green against the unmoved i18n.js immediately before the commit; the replacement is shown red on a removed `en` key) `i18n.test.js` (sync `setLang('th')`, fallback current -> en -> key, failed chunk keeps language); frozen JSON of every `t()` output per key from main, compared byte-for-byte after the move; prerender output diff byte-identical (`scripts/prerender-pages.mjs`); `zone-move-lock.test.js` table (derived from `CONTEXT.md`, cycle guard, nested zones); `item-factory.test.js` + `board-geometry` footprint tests pinning the four size variants as separate named functions; `apply-remote-snapshot.test.js` (returns `{board, forgetMoveIds}`, never touches refs; focus-drop, 8000 ms window, pending creates, isUndoRedo override, repeated-updater idempotence INV-15); `undo-guard` truth table (midDrag, locked, nothing to undo); `board-key-router.test.js` truth table derived from `onKey` order at `RetroBoard.jsx:2760-2857` and run against BOTH implementations during the move (swap-two-guards revert check); `resize-geometry.test.js` from `startItemResize` handle math; `vote-comment-keys` byte-identical key fixtures; canonical-votes, mood-check, the storage-bridge and `remote-board-decoder.js`/`retro-summary.js` key parsing all consume it (test: a key built by the schema is parsed by each consumer, and a key literal in each consumer's old format still parses); relay `client-ip`, `origins` (error strings byte-identical to security test `:429`), `admission-limits` with injected clock |
| Tasks (about 16) | 1 locales/th.js + en.js, i18n.js runtime (U1), in ONE commit that also rewrites `i18n-keys.test.js` (imports th/en directly, keeps parity and placeholder checks, derives `lazyCodes` from the runtime's `LOCALE_LOADERS`/exported list instead of slicing `dict`) and `Landing.test.js:55` (asserts on the imported dict with a negative test); show `i18n-keys.test.js` red on a removed `en` key and green after restoring it; 2 language-options (U2); 3 use-toast with stable `setToast` identity test (R3); 4 constants to leaf modules (R4); 5 BoardLoading (R5); 6 zone-move-lock (R9); 7 item-factory with named variants (R10, R16); 8 apply-remote-snapshot reducer (T1), wired but called from the same place. The current code mutates `recentlyMovedRef` inside the `setBoard` updater (INV-15), so the reducer is pure and returns `{board, forgetMoveIds}`; the call site applies `recentMoves.forget(forgetMoveIds)` inside the SAME updater, in the same order as today, and idempotently. `recentlyMovedRef.clear()` at `RetroBoard.jsx:925` stays at its call site (the reconcile step, owned by R30 only in P6) and is pinned by the isUndoRedo test. Tests: updater run twice (as StrictMode/React do) gives identical board and identical final recent-move set; `forgetMoveIds` matches the legacy deletions for focus-drop and 8000 ms window cases; 9 undo-guard (R14 pure); 10 board-key-router (R24 router, binding stays inline until P5); 11 resize-geometry (R33 pure); 12 `src/domain/vote-comment-keys.js` consumed by canonical-votes, mood-check, remote-board-decoder, retro-summary and later the bridge (S5, keys byte-identical); it is imported by relay code, so add it to the `Dockerfile.yjs` domain COPY list in the same commit and run `relay-image-files.test.js`; domain must not import client (`architecture.test.js`); 13 relay-client-ip (Y1); 14 relay-origins (Y2); 15 relay-admission-limits (Y3, shared bucket maps injected); 16 Dockerfile.yjs COPY updates as part of 13-15 |
| Exit | gate green; `ui-live-check` (th and en, undo/redo, two contexts) and `landing-live-check` pass; `Dockerfile.yjs` lists every new relay/domain file; ceilings lowered (RetroBoard.jsx about 3700, yjs-server.mjs about 1290) |
| Risk | low (pure functions with tests first); i18n move changes bundle chunking, compare to P0 size baseline. Release: R-A |

### P3 storage-bridge decomposition

| Field | Content |
|---|---|
| Goal | Thin composition root over testable modules, same observer order and `window.storage` surface |
| Seams | S1, S3, S4, S6, S7, S2, S8 (S5 done in P2) |
| Safety net first | P0 contract + isUndoRedo + observer-order tests green before EVERY task; `user-prefs` dual-write recovery tests with fake localStorage (blocked storage); `awareness-presence` with fake Awareness (30 s freshness, per-connection slots, busy cleared on destroy; the 3 readers stay distinct named functions unless a characterization proves equality); `snapshot-doc` on a bare Y.Doc (read/diff-write idempotence, origin `local` vs `system` decides undo tracking); `import-plan` one test per rejection path plus export -> import exact round trip (existing `storage-bridge.test.js:286`, `board-backup.test.js:89-132`); undo-controller tests (named `captureTimeout`) |
| Tasks (about 8) | 1 public-permit (S1, keep microtask); 2 user-prefs (S3); 3 awareness-presence (S4); 4 snapshot-doc (S6); 5 undo-controller (S7); 6 import-plan (S2, permit order kept, transaction stays in bridge); 7 composition (S8: method map assembly, e2e hook, reactions/timer board-route methods); 8 ratchet lowered at every task |
| Exit | storage-bridge.js under 400; 36 existing bridge tests unchanged and green; `Object.keys(window.storage)` unchanged; `ui-live-check` undo/redo two contexts plus a UI import round trip (new check §7.3) |
| Risk | medium (late `undoManager` assignment at `:1385`, observer order). Release: R-B |

### P4 Relay decomposition

| Field | Content |
|---|---|
| Goal | yjs-server.mjs becomes a composition root; preserve top-level-await order and late-bound refs |
| Seams | Y6, Y7, Y5, Y8, Y9, Y10, Y11, Y12, Y13, Y14, Y4, H2 |
| Safety net first | `room-accounting.test.js` (getters; increment then read); `vote-expiry.test.js` with fake timers (replaces the migrated slice); `awareness-policy` with fake Awareness (plan then commit, ownership by connection); persistence characterization with fake timers and fake LevelDB written against inline code (churn, compaction scheduling steps, store-queue drain on shutdown, failure latch `:286-300`); `ws-admission`/`upgrade` with injected policy functions and recording socket stubs; startup-order test (WIPE before hydrate, `setPersistence` before `migrateLegacyImages`) via an order-recording harness; spawned-relay smoke (two WS clients propagate updates; listener attached before first await; resilience and security spawn suites unchanged); late-bindings test (fails if a callback is unset); `relay-image-files.test.js` + build-less check that every imported file is in `Dockerfile.yjs`; local image build smoke (no deploy, no compose change) |
| Tasks (about 12) | 1 room-accounting (Y6); 2 vote-expiry (Y7); 3 awareness-policy (Y5); 4 ws-admission (Y8); 5 upgrade (Y9); 6 http-dispatch (Y10); 7 yjs runtime shim/banner (Y11, node_modules resolved from repo root); 8 persistence (Y12, `scheduleRoomCompaction` split into steps with CC <= 15); 9 room-state (Y13); 10 ws-connection (Y14, single-listener check kept); 11 late-bindings + remove config destructure (Y4); 12 relocate the 7 root tests into `src/server` (H2, fix URLs/imports) |
| Exit | yjs-server.mjs about 600, ceiling lowered each task; all 65 server tests + 7 relocated green; no change to log lines, close codes, rejection counters, HTTP statuses (diff of `rejectionCounters` under the security test); no new top-level mutable `let` shared across modules; no new per-message log lines (logging rule) |
| Risk | medium. Release: R-B. Image rebuild is owner-approved, not performed by the agent |

### P5 Leaf React extractions and the live harness

| Field | Content |
|---|---|
| Goal | Prove the controller-plus-thin-wrapper pattern (§5.4) and the P0 live checks on easy targets |
| Seams | R2, R6, R7, R8, R11, R12, R13, R15, R17, R18, R19, R20, R21, R22 (R20/R21 only after R19; R22 only with the viewport get/commit interface injected from RetroBoard) |
| Safety net first | decision D-HOOK resolved (§5.4) before the first task; `src/test-support/fake-clock.js` + `ssr-load.js` with self-tests; the five new live checks (§7.3) already exist from P0 and are re-run (P5 only adds checks for new areas); use-toast identity test; markup characterization (`renderToStaticMarkup` via the vite SSR loader, expectations derived from props contract) for `RemoteCollaborationLabels`, `CanvasOverlays`, `BoardDialogs`, `RemoteCursorLayer`; `latest-throttle` controller fake-timer tests (24 ms) kept separate from the 100 ms awareness layer; unmount-cleanup characterization at CONTROLLER level (busy claim, timers, presence cleared, `:374-390`: each controller exposes `dispose()` tested with fake timers; wrapper cleanup wiring is covered by live checks only, see §5.4); toggleVote reads the live snapshot (INV-12) and `removeItem` deletes item+votes+comments in one transaction; `adminClearBoard` pins phase+moodCheck by name with a guard failing when a `DEFAULT_BOARD` field is added without a decision (INV-14) |
| Tasks (about 17) | R2 zone guard; R6 labels; R7 overlays; R8 topbar props; R18 dialog host (repoint source-scan tests in same commit); R11 editing presence; R15 throttle then broadcast; R17 cursor layer; R12 board import (3 failure paths, `confirmImport` calls `setBoard`, INV-13); R13 image import; R19 selection (ref mirror before state, effect order kept); R20 vote state (sync effect split first); R21 admin actions + vote session; R22 minimap; hook-order lint test (no hooks after `if (!loaded)`); `board-key-router` binding as `use-board-shortcuts` |
| Exit | each controller has a colocated test (wrappers: live checks + hook-order lint, no effect-order unit claim unless Option B);  new live checks green after each extraction; RetroBoard.jsx about 3100; hook order unchanged |
| Risk | medium. Release: R-C. No hook in P5 owns `recentlyMovedRef`, `dragItemsRef`, `pendingGeomRef`; handles are created in RetroBoard and injected |

### P6 Coupled clusters and container/view split (conditional, stop rule)

| Field | Content |
|---|---|
| Goal | Single-owner moves of writes, sync, undo, gestures, viewport/follow, then view split |
| Seams | R29, R30, R14 (hook), R33, R31, R32, R23, R24 (rest), R26, R27, R28, R25 |
| Safety net first | record-and-replay characterization for the `board-writes` controller (fake timers: 60/80 ms flush, rollback on write failure, locked-zone filter, `recentMoves` marks; INV-1,5,6) against inline code; reconcile-clears-`recentMoves`-exactly-on-isUndoRedo test (INV-2); gesture exit-path state-machine test (INV-7); viewport tests on pure helpers + `pan-live-check`, `spacing-live-check`; follow ordering test (INV-9); render-count probe around `BoardItems` for `renderedItems` memo identity (30-entry dep list `:3288-3325`); `SelectionLayer` `data-selection-*` attribute contract test; folder rules in `architecture.test.js` |
| Tasks (about 18), in order | 1 use-board-writes (R29); 2 use-board-sync (R30, takes handle, owns `:925` clear); 3 use-undo-redo hook (R14, takes `midDrag` from gesture handle); 4 pointer-gesture + drag/resize (R33); 5 canvas-pointer (R23); 6 viewport controller (R31) piecewise: wheel, fit/zoom, minimap interface; 7 follow controller (R32); 8-9 shortcuts and remaining (R24); 10 SelectionLayer (R26); 11 BoardItems (R27); 12 canvas shell (R28) (tasks 10-12 each extend the `theme.test.js:151` producer file list in the same commit; R18 and R8 tasks repoint `confirm-then-pin.test.js`, `TopBar.test.js:84` and `Modals.test.js:135` as needed); 13 container/view split (R25); 14 final sweep and ceiling set to measured |
| Exit | all 15 invariants have a named unit test or live check; ui, facilitation, retro-outcomes, board-reactions, writing-timer, pan, spacing, mobile and all new live checks green on the final tree |
| Stop rule | If any live check or state-machine test fails twice on a task, stop the phase, keep what shipped, report to owner; the end line count is whatever was measured |
| Risk | high. Release: R-D, owner opt-in to start P6 after R-C |

## 7 Verification strategy

### 7.1 Per-layer

| Layer | Method |
|---|---|
| Unit | Colocated tests; expectations derived from `CONTEXT.md`/invariants, never copied from current output; no mocking the unit under test |
| Contract | `window.storage` method list + arity; observer order; Dockerfile COPY list; frozen `t()` JSON; `data-selection-*` attributes |
| Migrated source-slicing tests | Replaced in P1 by behaviour tests or imports; each shown red on a mutated copy |
| Revert check | Per task: revert/mutate moved logic and show its test fails (recorded in the task report; required by AGENTS.md Tests rule) |
| Gate per task | `npm test` + `npm run build`; for relay tasks also `relay-image-files.test.js` and spawn suites; complexity checked ad hoc (eslint complexity <= 15) on new modules |
| Rule conformance | Review ends with RULE CONFORMANCE (Code shape, Tests, Logging, Data location, Karpathy, repo style, failure-path tests) |

### 7.2 Live checks per phase

| Phase | Required live checks (two browser contexts, th and en, one Chromium at a time) |
|---|---|
| P0 | baseline of all: ui, facilitation, retro-outcomes, writing-timer, board-reactions, modal, room-lock, room-management, account, mobile, pan, spacing, landing, public-tools, poker |
| P2 | smoke per task (ui, drag-peer, undo-middrag for T1/R14/R10/R24 tasks); full P2 subset at phase end: ui, landing (th/en identical text), drag-peer, undo-middrag, resize, presence; prerender diff |
| P3 | ui-live-check undo/redo, UI file-import round trip, room-lock |
| P4 | relay smoke against `yjs:dev` with two clients; resilience and security spawn suites |
| P5 | each task: edit syncs both ways, undo/redo, th/en, plus the new check for its area |
| P6 | tiered, see §7.2a |

### 7.2a Live-check tiers and the live slot

The orchestrator owns the single live slot (one Chromium; Codex cannot launch Chromium in worktrees). Executing agents must NOT try to run live checks: they state the required tier in the task report, push the branch, and the orchestrator runs it and commits. Tiers:

| Tier | When | Checks |
|---|---|---|
| Smoke | after every P5/P6 task (and P2 tasks flagged above) | `ui-live-check` + `board-drag-peer-live-check` (+ the one check mapped to the task below) |
| Phase | end of each phase / each batch of about 5 tasks | the P6 subset: ui, drag-peer, resize, undo-middrag, presence, pan, spacing, mobile |
| Release | release candidate (R-A..R-D) | the full manifest suite (§7.5) |

P6 task to extra smoke check: 1 use-board-writes -> drag-peer, resize; 2 use-board-sync -> drag-peer, undo-middrag; 3 use-undo-redo -> undo-middrag; 4 gestures -> undo-middrag, resize; 5 canvas-pointer -> pan; 6 viewport -> pan, spacing; 7 follow -> presence, pan; 8-9 shortcuts -> ui; 10 SelectionLayer, 11 BoardItems, 12 canvas shell -> drag-peer, mobile; 13-14 container split -> phase tier. P3 and P4 may run in parallel but their live slots queue behind each other.

### 7.3 New live checks (ALL written in P0, passing on unrefactored main first; later phases only run them, P5 may add checks for new areas)

| Script | Covers |
|---|---|
| `board-drag-peer-live-check.mjs` | A drags a sticky while B moves another and edits text; both converge; A not snapped back; undo/redo on A (INV-5,7,2) |
| `board-resize-live-check.mjs` | resize handles, geometry sync to peer (INV-6) |
| `board-import-ui-live-check.mjs` | file-chooser round trip (json/zip/csv), 3 failure paths, exact round trip (INV-13) |
| `board-undo-middrag-live-check.mjs` | undo refused mid-drag and when locked; leak check after pointercancel/Escape (INV-3,7) |
| `presence-live-check.mjs` | cursor, selection label, editing indicator visible both ways and cleared on leave (INV-10) |

### 7.5 Live-check manifest and regression policy

`scripts/live-check-manifest.json` (written in P0 task 2, committed) has one entry per live check: setup recipe (fake OIDC server, public-wall relay, data volume, env flags, relay start command), expected baseline (`pass`, `known-red`, `env-skip`), and flakiness. Policy: a check must pass 2 clean consecutive runs on unmodified main to be recorded `pass`; a check that is red or cannot be set up on this Mac is recorded `known-red`/`env-skip` with the reason and is excluded BY NAME from gates; an intermittent check is recorded `flaky` with its observed rate and is re-run up to 2 times (fails only if it fails every time). "No regression" means same-or-better than the manifest: a `pass` check never fails, a `known-red` check does not get worse (same failing step). Manifest changes need a reviewer note; promoting known-red to pass is allowed, demoting is a regression.

### 7.4 Invariant coverage target

| INV | Final guard |
|---|---|
| 1,5,6 | use-board-writes characterization + drag-peer live |
| 2 | bridge isUndoRedo test + reconcile clear test + ui-live-check |
| 3 | undo-guard truth table + undo-middrag live |
| 4 | existing `storage-bridge.test.js` (`:78,:116,:262,:361`) |
| 7 | gesture state-machine test + undo-middrag live |
| 8,9 | viewport tests + follow ordering test + pan live |
| 10,11 | awareness-presence tests + throttle tests + presence live |
| 12,13 | existing bridge tests + import hook test + import-ui live |
| 14 | named-field guard test |
| 15 | apply-remote-snapshot repeated-updater test |

## 8 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hook extraction changes effect order, render count, memo identity (`renderedItems` 30-entry deps) (inferred only) | logic in plain-JS controllers (unit-tested with fake timers), thin wrappers, hook-order lint test, render-count probe only if Option B is approved (else live checks), live checks per tier (§7.2) |
| Characterization tests are tautological | Expectations from CONTEXT.md/invariants; mutate-and-fail evidence mandatory |
| storage-bridge observer order / late `undoManager` | contract + order tests before every task; singleton kept |
| Relay top-level-await order, shared `let` counters copied by value | getters + increment-then-read test; startup-order test; late-bindings test |
| Dockerfile.yjs COPY forgotten | relay-image-files test every relay/domain task; local image build smoke |
| Source-scan tests fail or pass vacuously | P1 migrates first; negative tests |
| Manual live checks, one Chromium, Codex cannot launch Chromium | runner script; orchestrator runs live checks and commits; serialised slot |
| AGENTS.md edits collide with the uncommitted edit | diff prepared, owner approval, coordinate |
| Ratchet blocks legitimate work | ceilings set to measured counts; new file-size ratchets start equal to current size |
| Duplicate-variant unification temptation | forbidden by anti-goals; parameterised named variants |
| Estimated reductions are eyeballed; some tasks may need re-splitting | measure first (line count, eslint complexity) in each task; split without raising any ceiling |
| P6 failure | stop rule; everything before it already released |

## 9 Measurable outcomes

| Metric | Now | After P2 | After P4 | After P5 | After P6 (measured, may stop earlier) |
|---|---|---|---|---|---|
| RetroBoard.jsx lines (ceiling) | 3993 | about 3700 | about 3700 | about 3100 | under 900 aspirational |
| yjs-server.mjs lines (ceiling) | 1445 (1446) | about 1290 | about 600 | about 600 | about 600 |
| storage-bridge.js lines (ceiling) | 1469 (none) | 1469 ratchet | under 400 (P3) | under 400 | under 400 |
| i18n.js lines | 2504 | about 100 | about 100 | about 100 | about 100 |
| Invariants with unit test or named live check | 6 of 15 | 10 | 11 | 13 | 15 |
| New live checks | 0 | 5 (written P0/P5) | 5 | 5 | 5 |
| Root relay tests | 7 | 7 | 0 | 0 | 0 |

Also: every new module has a paired colocated test shown to fail on mutation; no new function over cognitive complexity 15; `architecture.test.js` and `relay-image-files.test.js` green throughout; stale AGENTS.md/ARCHITECTURE.md counts corrected after owner approval; about 70 dead exports and 3 dead constants removed; plan task count about 100.

## 9a Rejected critique

None rejected; all 8 gaps accepted. Judgement calls: gap 1 uses the cleaner option (merge into U1); gap 2 defaults to Option A (controllers plus thin wrappers, no dependency) and leaves Option B (dev-only test renderer) as owner decision D-HOOK; gap 5's `forgetMoveIds` shape is a design choice the implementer may rename but not weaken.

## 10 What is left to the implementers

| Item | Note |
|---|---|
| Exact task splitting and ordering inside a phase | Follow the order in §6; re-split if a task does not fit one review |
| Measured line counts and ceilings | Always measure; targets above are projections |
| Param shapes of hooks, internal naming | Keep names of timing constants; keep hook identity stability where the map says so (setToast, publishLocalView) |
| Whether to run `eslint complexity` ad hoc and which complexity hotspots to split (key handler `:2760-2857`, `startItemResize`, sync effect, `scheduleRoomCompaction`, WS connection, upgrade, `importBundle`) | Not a new gate |
| Unresolved map questions: CI workflow content (§11 Q6), whether duplicate default-size variants are equal (§11 Q5), real complexity numbers (Q10) | Resolve by measurement before touching; if unresolved keep variants separate |
| Owner decisions | AGENTS.md edit approval, release batches, P6 opt-in, optional bridge factory follow-up, `uid` unification stays out, D-HOOK (§5.4: Option A default vs Option B dev-only test renderer devDependency) |
