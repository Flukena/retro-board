# Final review — React extractions (area D)

Range 83a7892..a7baeaf (worktree HEAD a7baeaf). Scope covered:
- RetroBoard.jsx wiring.
- Every client extraction outside `src/client/session`: P2 client modules, and the P5 controllers, components and hooks.
- `src/test-support`.
- The `src/*.test.js` ratchets.

Method:
- Compared each extracted body side by side against `git show 83a7892:RetroBoard.jsx`. For P5B pieces I also compared against 43c81d3.
- Diffed the moved JSX blocks against base.
- Compared the effect sequence by hand, base against HEAD, with wrapper effects spliced in at their call lines.
- Skimmed every new test for expectations taken from new-code output.

I ran no browser and no analyzer, as the brief instructs. Code-shape findings rest on the wording in AGENTS.md, not on analyzer rule ids.

Bottom line:
- No behaviour drift found in the moved logic. Each of these is verbatim or equivalent to base, including deps arrays and stale-closure behaviour:
  - toggleVote, which reads the live snapshot (INV-12);
  - removeItem, as one transaction;
  - the seven admin actions, including the named phase/mood clear (INV-14);
  - confirmImport, which calls `setBoard` (INV-13), and image import;
  - the minimap reveal/navigation/keys;
  - the shortcut routing, checked against every base branch including `preventDefault` placement;
  - the selection/focus ref-before-state order;
  - the BoardDialogs, CanvasOverlays, RemoteCollaborationLabels and TopBar props JSX.
- Host-method receivers are correct in every module I reviewed. The clock objects use arrow wrappers, and listeners are called as methods on `view`/`document`.
- The unmount-cleanup effect still clears everything base cleared, and adds flash-timer disposal.
- The sync effect keeps the base order: register → resync → `onSynced` → poll → vote/comment subscribe, with the same cleanup.
- The findings are about contract and design drift, guard strength, and code shape.

## Critical

None.

## Important

### I1. Two incompatible `recentMoves.forget` contracts; the finalizer's shape breaks against the spec handle
- **Where:** `RetroBoard.jsx:685` takes an array, `forget(ids) => ids.forEach(...)`. `RetroBoard.jsx:769` takes one id, `forget(id) => ...delete(id)`. The single-id call site is `src/client/board/vote-finalization-controller.js:11`, `.forEach((item) => recentMoves.forget(item.id))`.
- **What breaks, and for whom:**
  - Nothing breaks today, because each call site builds its own ad-hoc adapter.
  - The binding spec (design §5.2, `use-board-writes.js` row) fixes the single owner handle as `recentMoves = {mark(ids), has(id), forget(ids), clear()}`. P6 is told to pass that one handle to sync and to finalization.
  - When P6 wires the spec handle into `createVoteFinalizationController`, `forget('item-id')` runs `'item-id'.forEach` and throws a TypeError.
  - That happens inside admin Stop (`adminStopTimer` → `finalizeVotingSession`) and the deadline auto-end. The vote session is then never finalized for the facilitator.
- **Why it slipped through:** `vote-finalization-controller.test.js` injects its own `forget(id)` fake, so it pins the wrong shape.
- **Suggested fix:**
  - Make the finalizer call `recentMoves.forget(ids)` once, with the filtered id list. This also matches the spec's "scoped forget" wording.
  - Build ONE `recentMoves` adapter in RetroBoard, used by both `applyRemoteBoard` and `useFinalizeVotingSession`.
  - Update the test fake to the spec shape.

### I2. Wrapper hooks do not follow the D-HOOK contract
- **Where:**
  - `src/client/board/use-admin-actions.js:134-164`
  - `use-vote-state.js:141-147`
  - `use-board-import.js:57-67`
  - `use-image-import.js:45-47`
  - `use-minimap.js:132-142`
  - `use-board-shortcuts.js:80-85`
  - `use-selection.js:26,32`
  - Call sites at `RetroBoard.jsx:871, 933, 1051, 1569-1573, 2184-2194, 2316-2335, 2344-2348`.
- **What the spec says:**
  - Design §5.4 Option A: "The hook is a thin wrapper (create controller in a ref, call it from effects, return handles)".
  - §5.3 module contracts: "hooks take explicit params (no 30-arg grab bags where an object of related handles exists)".
- **What the code does:**
  - Every wrapper is `useCallback(createController(options).fn, dependencies)`.
  - A full controller is rebuilt on every render, once per wrapper: seven admin controllers, each with seven closures, per render.
  - The caller hand-passes the dependency array. That puts every dependency list outside what React's exhaustive-deps lint can check.
  - The same 14-key `adminActionsOptions` bag (`RetroBoard.jsx:2316`) and the same 9-key import bag (`:2344-2348`) feed functions that each use 2-5 of the keys. `createController` in `use-admin-actions.js:9` takes 21 fields.
- **Effect:**
  - No runtime defect today. I checked every deps array against base, and each matches.
  - The stale-closure safety now rests on hand-copied arrays, so the next edit that adds an option silently goes stale.
  - RetroBoard re-renders on every drag frame (`commitGeometry` → `setBoard`), which adds avoidable allocations on that hot path.
- **Suggested fix:**
  - Create each controller once (ref or lazy `useState`).
  - Read the changing values through a `latest` ref, or pass them per call.
  - Return stable handles, and narrow each controller's input to the handles it uses.
  - P6 rewrites several of these owners. If the owner prefers to defer, record that as an explicit ruling rather than leaving it implicit.

## Minor

### M1. The hook-order guard has blind spots
- **Where:**
  - `src/client/hook-order.test.js:42` counts only lines that start with `  const ` or `  use[A-Z]`.
  - `src/test-support/p5b-hook-order.json` therefore has no `useUserIdentity` (`RetroBoard.jsx:185`), `useBoardTemplates` (`:585`) or `useAdminRole` (`:604`), because each is called on a `} = useX(` line.
  - The fixture is baselined at 43c81d3, after P5A, not at production 83a7892.
  - `WRAPPERS` (`:9-33`) expands only the batch-B wrappers. `useToast`, `useEditingPresence`, `usePresenceBroadcast*` and `useBrowserZoomGuard` stay opaque.
- **Effect:** moving or reordering those three hooks, or effects inside the P5A wrappers, passes the guard.
- **What I verified by hand, base 83a7892 against HEAD:**
  - Every effect keeps its relative order except one: the toast auto-dismiss effect. It was at base ~1113, between viewport-persist and the undo-state subscription. It now sits inside `useToast()` at `RetroBoard.jsx:238`, before `useSpacePan`. This came from P2 R3.
  - That effect reads only `toast`, and no neighbouring effect depends on it, so the move is harmless.
  - Everything else matches 1:1: the selection mirror, the three editing-presence effects, the zoom guard (still after the undo subscription), the shortcuts, and paste.
- **Suggested fix:**
  - Match `use[A-Z]\w*\(` on every top-level statement line, including `} = use…(`.
  - Expand the P5A wrappers too.
  - Rebaseline from 83a7892, and record the toast move as accepted.

### M2. Superseded vote-flash timer forces an extra RetroBoard render
- **Where:** `src/client/board/use-vote-state.js:135-137`, `setState(previous => ({ ...previous, flashes: update(previous.flashes) }))`.
- **What changed:** base `setVoteFlashes` returned `prev` when a newer flash superseded the timer, and React bailed out. The new wrapper always returns a fresh outer object, so the heavy root re-renders anyway.
- **When it happens:** vote, unvote and re-vote on the same card within 900 ms.
- **Suggested fix:** `setState(prev => { const flashes = update(prev.flashes); return flashes === prev.flashes ? prev : { ...prev, flashes }; })`.

### M3. The INV-14 guard does not bind the code to its decisions
- **Where:** `src/client/board/use-admin-actions.test.js:9-13,41`.
- **The gap:**
  - `assertClearDecisions` forces a new `DEFAULT_BOARD` field into `RESET_FIELDS` or `PRESERVED_FIELDS`.
  - But the expected board at `:41` is a hand literal, not derived from `RESET_FIELDS`.
  - So adding field X to `DEFAULT_BOARD` and to `RESET_FIELDS`, with `adminClearBoard` untouched, still passes, and X silently survives Clear.
- **Suggested fix:** for each `RESET_FIELDS` key, assert that `next[key]` equals the cleared value. That means `[]` for items and `DEFAULT_BOARD[key]` or the named null/false otherwise. The harness board is already dirty on those keys.

### M4. Injectable parameters shadow globals and expose constants and pure domain functions as configuration
- **Where:**
  - `use-admin-actions.js:9`: `Date`, `window`, `CLEARED_VOTE_RESULTS`, `voteSessionScope`, `extendedDeadline`, `resetVoteSessionEntries`.
  - `use-vote-state.js:37`: `Date`, `window`, `activeVoteZone`.
  - `vote-finalization-controller.js:4`: `Date`, `window`.
  - `use-image-import.js:6`: `IMAGE_MAX_BYTES`, `IMAGE_MAX_MIB_LABEL`, `isSafeImageMime`, `canStartImageImport`, `prepareImageBlob`.
  - `use-board-import.js:5`: `ImportBundleLimitError`.
  - `use-board-shortcuts.js:64-65`: `document`, `Element`, `routeBoardKey`, `ZOOM_STEP_FACTOR`.
  - `use-minimap.js:13,37`.
- **Why it matters:**
  - These are test seams for things the tests mostly re-inject with the real implementation. For example, `use-minimap.test.js` passes the real `minimapPointToWorld`, and `use-admin-actions.test.js:26` passes the real `CLEARED_VOTE_RESULTS`.
  - That is configurability nobody needs (Karpathy rule 2).
  - Parameter names that shadow `Date`, `window` and `document` hurt readability (AGENTS.md: readable, long-lived code).
- **Suggested fix:**
  - Keep `clock`, `storage` and `window` as handles under non-shadowing names, such as `clock` and `view`.
  - Import constants and pure functions directly.

### M5. Generic names, dead lifecycle API, and a throwaway controller
- **Where:**
  - Four modules export the same `createController` name: `use-vote-state.js:37`, `use-admin-actions.js:9`, `use-board-import.js:5` and `use-image-import.js:6`.
  - Six controllers return a no-op `dispose() {}`: `use-vote-state.js:94`, `use-selection.js:13`, `vote-finalization-controller.js:22`, `use-admin-actions.js:131`, `use-board-import.js:54` and `use-image-import.js:42`. Tests call these only for coverage.
  - `createMinimapNavigation(...).dispose` (`use-minimap.js:127-129`) is never wired.
  - `RetroBoard.jsx:409-411` builds a fresh `createMinimapVisibility` just to call `dispose`. It works only because the state lives in refs.
- **Suggested fix:**
  - Use intention-revealing names, such as `createAdminActions` and `createBoardImport`.
  - Drop the no-op `dispose` methods until a controller owns a resource.
  - Clear the minimap timer in the cleanup through one shared helper.

### M6. `useTopBarProps` is not a hook, and now runs during loading
- **Where:** `src/client/chrome/use-topbar-props.js:5` calls no hooks. `RetroBoard.jsx:2639` calls it before `if (!loaded) return <BoardLoading />` (`:2720`).
- **Effect:**
  - Base computed `adminPillModel` and `playerRows` only inside `renderTopBar()`, which ran only after loading.
  - It is harmless today, but the `use` prefix makes readers and the hook-order fixture (`p5b-hook-order.json:240`) treat it as a hook.
- **Suggested fix:** rename it to `topBarProps(...)` and compute it at the render site.

### M7. Duplicated zoom-guard logic is not reported
- **Where:** `src/client/app/Landing.jsx:38-87` (`useBlockBrowserZoom`) is the same logic as the newly extracted `attachBrowserZoomGuard` (`src/client/board/use-browser-zoom-guard.js:7-48`), plus gesture handlers.
- **Rule:** AGENTS.md "Shared layer: multi-caller logic belongs in ONE neutral module", and "Report duplication you could not remove". Neither the P5A report nor the code mentions it.
- **Suggested fix:** give `attachBrowserZoomGuard` an option for the gesture listeners and use it from Landing. At minimum, record the duplication.

### M8. Formatting does not match repo style
- **Where:**
  - `use-vote-state.js:6-35` has mis-indented closures and `}, dispose() {` / `} };` on odd columns.
  - `use-browser-zoom-guard.js:8-47` uses a 4-space body inside a 2-space file.
  - `use-admin-actions.js:9`, `use-vote-state.js:37` and `use-image-import.js:6` have one-line signatures of roughly 300-600 characters.
  - Return literals have no spaces: `return {toggleVote,removeItemUnchecked, dispose() {}}` at `use-vote-state.js:94`, and the same at `use-admin-actions.js:131`, `use-board-import.js:54` and `use-image-import.js:42`.
- **Suggested fix:** reformat to the repo's 2-space and line-wrap style.

### M9. Stale comment after the constant move
- **Where:** `src/client/board/drag-timing.js:11` says "Mirrors RECENT_AUTHOR_WINDOW_MS below", but that constant is not in this file.
- **Suggested fix:** name its module, or drop the clause.

### M10. The minimap viewport port adds a flag-mode switch in the root
- **Where:** `RetroBoard.jsx:1561-1567`, `commitViewport(next, { live } | { finish } | {})`, which dispatches to three different commit paths.
- **Rule:** design §5.2 fixes the port as `getViewport()/commitViewport(v)`. The boolean-flag mode is new glue logic in the size-frozen root. It is behaviour-equivalent; I checked it against the base `liveApplyViewport`/`setViewport`/`commitViewportImmediately` calls.
- **Suggested fix:** expose three named commits, such as `previewViewport`, `finishViewport` and `commitViewport`, or move the dispatch into the minimap controller. Note it for the R31 viewport owner in P6.

## Deferred-minor triage (ledger minors in this area)

| Ledger item | Current state | Triage |
|---|---|---|
| Task 3: `bridge-harness.js` repeats board code/token from `BOARD_URL` | Still present: `src/test-support/bridge-harness.js:41` vs `:18` | can-wait |
| Task 3: `unlockLockedRoom` exported but never imported | Now used internally at `:40`; the `export` at `:23` still has no importer | can-wait (drop `export`) |
| Task 6: guard test title says "above the unceilinged limit" | `src/rule-ratchets.test.js:122`, unchanged | can-wait |
| Task 6: `oversizeWithoutCeiling` exported, used only in its file | `src/rule-ratchets.test.js:43`, unchanged | can-wait |
| fix-draw: CSS-text tests cannot catch real overflow (`drawing-toolbar-layout.test.js`) | Unchanged; the live mobile check is the guard | can-wait |
| fix-draw: mobile visual order differs from DOM order | Unchanged; accessibility follow-up | can-wait |
| fix-draw: Close sits far right on coarse-pointer tablets; disabled/loading states unmeasured | Unchanged | can-wait |

None in this area is must-fix-before-merge.

Ratchet check: `src/rule-ratchets.test.js` only lowers ceilings (RetroBoard 3993 → 2895) and adds ceilings and an oversize guard. The colour allowlist is unchanged. There are no new skip/only/todo/NOSONAR/eslint-disable markers anywhere in the area.

## Not covered

- Locale dictionaries, `src/client/ui/fixtures/i18n-outputs.json`, and the i18n runtime split. These belong to the C reviewer.
- CSS files.
- `src/client/session/*` and `src/domain/*`. Other reviewers own these; I reviewed only their RetroBoard call sites.
- The relay fixtures in `src/test-support` (`relay-entrypoint.js`, `relay-connection-fixture.js`, `relay-persistence-fixture.js`) were skimmed only.
- Nothing was exercised in a browser.

## RULE CONFORMANCE

- Code shape: FAIL. I1 (one contract, two adapters), I2 (wrapper contract and option grab bags), M4, M5, M6, M7, M8, M9, M10.
- Tests: FAIL. M1 (hook-order guard blind spots) and M3 (INV-14 guard not bound to the code). The characterization expectations are otherwise derived from base or spec; I found no copies of new-code output.
- Logging and disk writes: N/A. No new sinks.
- Data location: PASS. Test temp directories (`relay-entrypoint.js:22`, `mkdtemp` in `os.tmpdir()`) are small and removed in `t.after`.
- Karpathy guidelines: FAIL. M4 (injection nobody needs) and M5 (no-op lifecycle API).
- Repo style: FAIL. M8.
- Failure-path tests: PASS. Import read/prepare/bridge rejection, image MIME/size/decode/upload failure, denied admin/vote/cut, failed session writes, timer cancel and dispose, and the hook-after-return negative test.
