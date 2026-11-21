# Final re-review: fix wave a7baeaf..e067c5b

Reviewer: final-rereview (read-only). Scope: the in-scope findings named in fix-prompt.md and the 8-commit fix diff. Deferred items (react I2; bridge M4, M5, M6; relay M8, M9; harness step() copies and the common split) and relay I1 (closed by the orchestrator) are not judged here.

Method: I read the four review reports, fix-prompt.md, final-fix-report.md and the full fix diff (`git diff a7baeaf e067c5b`, 73 files). I checked each red-proof claim against the old code. For react M1 I rebuilt the hook sequence myself from `git show 83a7892:RetroBoard.jsx` with the test's own line matcher. Result: 258 hooks, identical to `p5b-hook-order.json` `hooks`, and equal to the count of every `use[A-Z]…(` call in the base component body. So the fixture really is derived from base and was not copied from new output. I ran no tests, browser, docker or analyzer. `git diff --check` is clean.

## Verdicts

**Totals:** 28 ADDRESSED, 0 PARTIAL, 0 NOT ADDRESSED.

### Harness

| Finding | Verdict | Evidence / red-proof plausibility |
|---|---|---|
| I1 async `waitForFunction` | ADDRESSED | All four sites now use `pollUntil(() => page.evaluate(...), accept, msg)`: `scripts/pan-live-check.mjs:145`, `:454`, `scripts/modal-live-check.mjs:446`, `:458`. `pollUntil` (`board-live-helpers.mjs:408-417`) re-reads until accepted and throws on timeout, so a false result now waits and then fails. No `waitForFunction(` with an async predicate remains in `scripts/`. A guard test was added (`live-check-common.test.mjs:461-465`). Its RED claim is plausible: the old modal and pan lines contain `waitForFunction(async`. |
| I2 zero-PASS run | ADDRESSED | `live-check-common.mjs:456` adds `&& steps.length > 0`. With `failed.length === 0` this is the same as at least one PASS line. The test at `live-check-common.test.mjs:454-459` asserts `passed: false` and `judgeRun` → `'regression'`. RED is plausible: the old expression returns `true` for exit 0 with no steps. |
| `chooser.catch(() => {})` | ADDRESSED | `board-import-ui-live-check.mjs:95-99` now uses `Promise.all([waitForEvent, openMenu])`. Either rejection propagates and there is no swallow. No unit test exists for it; it was syntax-checked only (stated in the report). |

### Bridge

| Finding | Verdict | Evidence / red-proof plausibility |
|---|---|---|
| I1 source-text test | ADDRESSED | `remote-snapshot-wiring.test.js` is deleted. `applyRemoteBoard` now comes from `src/client/session/remote-snapshot-controller.js`, wired at `RetroBoard.jsx:674-678`. `remote-snapshot-controller.test.js` drives the real owner. Undo case: the clear happens before focus (`['focus', null, 0]`, map size recorded inside the focus callback) and before scheduling. Ordinary case: the forget runs inside the same updater (`calls.at(-1)` after `run()`). Absent case: nothing happens. Both negative intents survive: a clear moved into the updater makes the focus record size 1, and a forget outside or after the updater fails the post-`run()` assertions. RED claims are plausible. |
| M1 orphaned comments | ADDRESSED | `snapshot-doc.js:10-16` now holds the legacy-key comment above `LEGACY_BOARD_KEY` and the repair comment above `IMAGE_REPAIR_ORIGIN`. Both are removed from `storage-bridge.js` and from the `seedItem` site. |
| M2 kv key format | ADDRESSED | `bridge/kv-keys.js` owns `keyOf`, `userKey`, `userKeyPrefix` and `parseKvKey`, used by `storage-access.js:1`, `user-prefs.js:76,118`, `bridge-diagnostics.js:29` and `storage-bridge.js:164`. `git grep` finds no hand-written `` `u|`` or `'|'` parsing left in `src/client/session`. The parser keeps the old first-two-separator semantics, and `kv-keys.test.js` pins `key|suffix`. RED claim (encoding mutation) is plausible. |
| M3 producer exclusion | ADDRESSED | `storage-contract.test.js:165-167` `isStorageConsumer` excludes `src/client/session/bridge/`. A direct test is at `:169-173`. RED is plausible: the old filter treated `bridge/awareness-presence.js` as a consumer. |
| M7 RemoteCursorLayer | ADDRESSED | Named constants are at `RemoteCursorLayer.jsx:7-18` and indentation is fixed. Rendered values are unchanged: the test now pins `width/height 23`, `stroke-width 2.6`, `18ms`, margins, max-width and font values. RED is plausible. |

### Relay

| Finding | Verdict | Evidence / red-proof plausibility |
|---|---|---|
| M1 protocol literals | ADDRESSED | New `src/server/relay-status-codes.js` (`HTTP_STATUS`, `WS_CLOSE`) is used in upgrade, ws-connection, room-state, http-dispatch and ws-admission. Every replacement maps to the same value (1009→TOO_LARGE, 1008→POLICY, 1011→SETUP_ERROR, reservation `404`→NOT_FOUND). No bare status or close literal remains in those five files. The module is added to the `Dockerfile.yjs` COPY list and covered by the image-closure test. RED is plausible: `relay-ws-connection.test.mjs:7` holds its own literal `1011`. |
| M2 header placement | ADDRESSED | `yjs-server.mjs:1-2`. |
| M3 readiness comment | ADDRESSED | `relay-http-dispatch.js:48-51` matches base `yjs-server.mjs:1119-1122` word for word. |
| M4 `export … from` edges | ADDRESSED | The pattern at `relay-image-files.test.js:9` now accepts `import|export`. The scanner takes an injectable entry and reader, and a synthetic re-export-only fixture is at `:40-47`. RED is plausible: the old regex finds no edge in `export { X } from './only-reexported.js'`, so the closure would be empty. |
| M5 vacuous consumer case | ADDRESSED | The case and the `../client/` import are removed from `vote-comment-keys.test.js`. |
| M6 speculative `hasUndo` | ADDRESSED | `undo-guard.js:1` takes two parameters. The callers (`RetroBoard.jsx:831,836`) never passed a third one, so there is no behaviour change. The truth table is reduced to 4 rows. |
| M7 `.test.mjs` | ADDRESSED | All 14 files are renamed at 100% similarity. The `relay-*.test.js` files that remain predate the branch. |
| M10 `handleConnection` CC | ADDRESSED | The message callback is now `createMessageHandler(...)`, returning a named `onMessage` (`relay-ws-connection.js:26-55`). Statement order is unchanged. `limited` moved into that closure, which has one instance per connection exactly as before, and nothing else read it. My hand count gives `onMessage` about 10 and `handleConnection` about 6. No Sonar run, as the report states. The exactly-one-parser tests are pre-existing (`relay-ws-connection.test.mjs:9-22`), so their RED claim is plausible. |
| M11 recent-move parity | ADDRESSED | `apply-remote-snapshot.js:12` passes `context` through unchanged; the `isUndoRedo ? new Map()` override is gone. The call-site clear stays in `remote-snapshot-controller.js:12`, before the lazy updater, as in base. The new test at `apply-remote-snapshot.test.js:76-84` adds a move after the clear and expects x=90. RED is plausible: the old override ignores the map, which gives remote x=1 and `forgetMoveIds ['note']`. `applyRemoteSnapshot` has no other caller. |

### React

| Finding | Verdict | Evidence / red-proof plausibility |
|---|---|---|
| I1 one `forget(ids)` contract | ADDRESSED | There is one adapter at `RetroBoard.jsx:674`, passed to both the snapshot controller (`:677`) and `useFinalizeVotingSession` (`:753`). The finalizer calls `recentMoves.forget(ids)` once (`vote-finalization-controller.js:11-14`). Its test fake has the spec shape and expects `['forget', ['zone','card']]`. RED is plausible: the old per-id call hands a string to `ids.forEach` and throws. |
| M1 hook-order blind spots | ADDRESSED | The line matcher now includes `} = use…(` lines. The fixture is `{capturedFrom: '83a7892:RetroBoard.jsx', acceptedToastDismissMove: 156, hooks[258]}`, and I verified it independently as described under Method. The P5A wrappers are expanded. A negative test removes or reorders `useUserIdentity`, `useBoardTemplates` and `useAdminRole` (`hook-order.test.js:94-104`). See note N5. |
| M2 vote-flash identity | ADDRESSED | `updateVoteFlashState` (`use-vote-state.js:158-161`) returns `previous` when the flashes map is unchanged, which restores base's React bail-out. RED is plausible: the old updater always spread a new outer object. |
| M3 INV-14 binding | ADDRESSED | Each `RESET_FIELDS` key must start dirty and end equal to `DEFAULT_BOARD[key]`, and each `PRESERVED_FIELDS` key is kept (`use-admin-actions.test.js:40-44`). This closes the reviewer's gap. See N1 for a side effect. |
| M4 shadowing / needless injection | ADDRESSED | `Date`, `window`, `document` and `Element` are replaced with `clock`, `view`, `ownerDocument` and `elementType`. Constants and pure policies are imported directly in admin, vote-state, finalization, shortcuts, minimap, board-import and image-import. The async I/O seams stay injectable (`readBoardImport`, `prepareBoardImport`, `prepareImage`), as the prompt allowed. Receivers are all valid: `clock.now()` on `Date`, `view.*` on `window`, arrow wrappers in `MINIMAP_CLOCK`. Every RetroBoard call site passes none of the removed keys. |
| M5 names / no-op dispose | ADDRESSED | The functions are renamed `createAdminActions`, `createVoteStateController`, `createBoardImport` and `createImageImport`. The six no-op `dispose` methods and the unwired navigation `dispose` are removed. The throwaway controller in the root cleanup is replaced by the shared `clearMinimapHideTimer` (`use-minimap.js:13-15`, `RetroBoard.jsx:410`). |
| M6 `useTopBarProps` | ADDRESSED | It is renamed `topBarProps` and evaluated at the render site (`<TopBar {...buildTopBarProps()} />`), after the loading return. This matches base timing. |
| M7 Landing zoom guard | ADDRESSED | `Landing.jsx:53` calls `useBrowserZoomGuard({ blockGestures: true })`, and the duplicate hook is deleted. The behaviour matches the old Landing hook: the same meta handling, wheel/keydown/gesture prevention, DPR counter-zoom and full listener removal. Listener registration order changed only across different event types, so it has no effect. The board path passes no options, so the default `{}` applies. |
| M8 formatting | ADDRESSED | 2-space bodies, wrapped signatures and spaced return literals in the listed files. |
| M9 stale comment | ADDRESSED | `drag-timing.js:11` now names `domain/pending-local-items.js`. |
| M10 flag-mode viewport port | ADDRESSED | `previewViewport` / `finishViewport` / `commitViewport` (`RetroBoard.jsx:1545-1550`, `use-minimap.js:66,106,135`). The plain functions are passed by reference and have no receiver dependence. Their staleness is the same as in the old closure, which also captured them per render under the same `useCallback` deps. The test now asserts the preview port on the first and the queued move. |

## New issues introduced by the fix diff

**Critical:** none. **Important:** none.

Behaviour changes other than relay M11: none found. M2 and M6 restore base timing and identity. M10 and the Landing move are equivalent. There are no raised ratchets (RetroBoard 2895→2877, storage bridge 295→289, relay 441 unchanged). There are no new `NOSONAR`, `eslint-disable`, `skip`, `only` or empty catches, and no detached host-method receivers.

**Minor (none blocks merge):**

- **N1. INV-14 test lost its whole-object check** (`src/client/board/use-admin-actions.test.js:40-44`).
  - The old `deepEqual(next, {...})` also failed if `adminClearBoard` added a stray key. The per-key loops do not.
  - `assertClearDecisions` still forces every `DEFAULT_BOARD` field into one of the two lists.
  - This is a narrow loosening against the wave's no-weakening rule. The fix is one line: `assert.deepEqual(Object.keys(next).sort(), Object.keys(h.boardRef.current).sort())`.
- **N2. Botched rename in a test fixture** (`src/client/board/use-minimap.test.js:13`): `ownerDocument: { activeelementType: {} }`. The `Element→elementType` replace hit `activeElement`. Tests still pass only because the fake `panel.contains` ignores its argument. Rename it back to `activeElement`.
- **N3. Import placement regressions of the same class as relay M2, which this wave fixed in `yjs-server.mjs`:**
  - New imports sit above the file header comment in `scripts/pan-live-check.mjs:2` (above "Isolated Public pan regression") and `src/client/session/storage-bridge.js:1` (above "window.storage polyfill…").
  - They are out of group order in `src/client/app/Landing.jsx:1`, `src/client/board/use-board-shortcuts.js:1-2`, `bridge/bridge-diagnostics.js:1` and `bridge/user-prefs.js:1`, which has no blank line before its constants.
- **N4. The async-predicate guard is single-line only** (`scripts/live-check-common.test.mjs:463`): `/waitForFunction\(async\b/`. It misses `waitForFunction(\n  async …` and a named async function. None exist today. `/waitForFunction\(\s*async\b/` would cover the first form.
- **N5. The hook-order coordinator maps three wrappers to hard-coded base counts** rather than deriving them: `useToast`, plus `usePresenceBroadcastState` → 7×`useRef` and `usePresenceBroadcast` → 5×`useCallback` (`hook-order.test.js:54-58`). These are commented as accepted equivalences, and `WRAPPERS` still checks their internal order. Acceptable; noted for P6.
- **N6. Inline path literal** in `storage-contract.test.js:166` (`'src/client/session/bridge/'`), while its siblings use named prefix constants such as `CLIENT_SOURCE_PREFIX`.
- **N7. Cosmetic leftovers:**
  - a stray blank line where `dispose()` was removed (`src/client/board/use-selection.test.js:26`);
  - very long single lines at `modal-live-check.mjs:446,458` and in the `use-minimap.test.js` viewport fake.

## RULE CONFORMANCE (rules the fix diff touches)

- Code shape: PASS for the in-scope fixes. Minor findings: N2, N3 and N6.
- Tests: PASS. The red-proofs are plausible on the old code, and the hook fixture is base-derived (independently verified). Minor findings: N1 (narrow loosening) and N4.
- Logging and disk writes: N/A. No sinks changed; the log literals in relay modules are unchanged.
- Data location: N/A. No data written by the changed code.
- Karpathy guidelines: PASS. The fixes stay surgical and in scope, and the only behaviour change is M11, which restores base.
- Repo style: PASS overall, with N3 and N7. The relay `.test.mjs` rule is restored and the ceilings were lowered.
- Failure-path tests: PASS. Zero-step runs, the rejecting chooser path, the denied finalize plan and the missing snapshot are covered. The live scripts were not executed, which is the orchestrator's live run.
