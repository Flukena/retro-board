# Final review: storage bridge, sync and i18n (83a7892..a7baeaf)

Reviewer: final-review-bridge (read-only). Scope: `src/client/session/` (incl. `bridge/`), sync wiring, `src/client/ui/i18n.js` + `locales/th.js`/`en.js`, `language-options.js`, the related tests and fixtures.

Method:
- Read the composed bridge (`storage-bridge.js`, 295 lines) and each `bridge/*.js` module at a7baeaf beside the original 1469-line bridge at 83a7892, statement by statement. Checked observer and listener registration order, the live `undoManager` binding, host-method receivers, the dev-only branch and public property order.
- Compared the th/en dictionaries mechanically. I evaluated the old inline `dict` from 83a7892 `i18n.js:9-2416` and deep-compared it with the new `locales/th.js` and `locales/en.js`. Both are deep-equal, with the same key order (1175 keys each) and no th-only or en-only keys.
- Compared the P5 session hooks (`latest-throttle`, `use-presence-broadcast`, `use-editing-presence`, `RemoteCursorLayer`) with the original code at 83a7892 `RetroBoard.jsx:258-261, 374-386, 431-460, 521-596`.
- Did not re-run tests or browser checks, per the brief.

## Critical

None found.

Behaviour equivalence of the bridge decomposition holds on every path I traced:
- **Construction order** is unchanged: provider, client sync, public guard, permit, `connect`, motion publisher, clientId, maintenance `sync` handler (and its immediate `provider.synced` run), kv dispatch observer, `yItems.observeDeep`, `yMeta.observe`, then the vote, comment, template and mood observers, the awareness `change` listener, the undo manager, E2E, `status` log, dev handles, previews, reactions and writing timer.
- **Undo binding**: `undoManager` is still declared at the top (`storage-bridge.js:151`) and assigned late (`:282`), so the observers read the live binding through `isUndoOrigin` (`:152`).
- **E2E handoff**: `attachRoomEncryption` receives `undoManager` after that assignment (`:286-288`). Its `images` port has every member `repairOldEpochImagesOnce` reads (`listImageSources`, `rewriteImageSources`; `e2e-image-repair.js:7,30`).
- **Receivers**: no host method is detached onto a foreign receiver. `queueMicrotask` is called bare. `eventTarget.dispatchEvent` is a method call. `getSyncStatus: syncStatus.getSnapshot` is detached exactly as in the original (`83a7892 storage-bridge.js:1366`). `HOST_CLOCK` wraps `globalThis.*` in arrows (`latest-throttle.js:1-5`).
- **Key formats** from `domain/vote-comment-keys.js` produce the same strings as the old `VOTE_KEY`/`COMMENT_KEY`. The permissive stored parsers keep the old behaviour (empty and colon-bearing fields).
- **Simplifications**: `tryMigrate`'s merged early-flag branch (`snapshot-doc.js:201`) and `writeBoardSnapshot` now calling `seedItem` (`:113`) are equivalent to the old code.
- **Teardown in the P5 hooks** keeps the original order. Geometry busy is cleared, then text busy, then selection. Timers are cancelled, then the cursor is nulled, then the view.

## Important

### I1. A new test reads `RetroBoard.jsx` text, against the P1 exit criterion
- **Where:** `src/client/session/remote-snapshot-wiring.test.js:5-46`, added in P2 (2b172a1).
- **What breaks, and for whom:** nothing at runtime. But the binding spec says (design §P1 Exit, `docs/superpowers/specs/2026-11-19-codebase-refactor-design.md:148`): "no test reads RetroBoard.jsx/yjs-server.mjs text except the ceiling/colour ratchets and the named source-scan tests listed above (each with a documented owner list)". This file does `readFileSync('RetroBoard.jsx')` and asserts statement order with `indexOf` on exact source strings, for example `'if (isUndoRedo) recentlyMovedRef.current.clear();'` and `'recentMoves.forget(result.forgetMoveIds);'`. It is not in the named list and has no owner list. This is exactly the kind of layout-pinning test P1 exists to remove: an innocent reformat or rename (`recentlyMovedRef` → anything) turns it red with no behaviour change, which teaches future authors to "fix" the test string. P5 moved further code out of `RetroBoard.jsx`, so the next move of `applyRemoteBoard` either breaks this test or must re-point it.
- **Evidence:** `git grep "RetroBoard.jsx'" a7baeaf -- '*.test.js'` lists it beside the spec-sanctioned `hook-order.test.js`, `storage-contract.test.js`, `i18n-keys.test.js` and `theme.test.js`.
- **Suggested fix:** either
  - replace it with a behaviour test of the reducer and caller contract (undo/redo clears recent moves before focus, and forget happens inside the same updater). `applyRemoteSnapshot` is already pure, so drive it through the hook/controller that owns `applyRemoteBoard`; or
  - get an explicit owner ruling that adds it to the named source-scan list with a documented owner. The negative tests (`:22-25`, `:43-46`) are good and should be kept in whichever form survives.

## Minor

### M1. Comments left orphaned by the moves
- `src/client/session/bridge/snapshot-doc.js:153`: "Not a tracked undo origin: a repair rewrites sources without becoming an undo step." now sits above `seedItem`. The constant it describes, `IMAGE_REPAIR_ORIGIN`, is at `:12`.
- `src/client/session/storage-bridge.js:154-157`: the "`boardState` now flows through yItems/yMeta … this guard ensures any rogue write …" comment now sits above `createSnapshotDoc(...)`. The guard it describes is `LEGACY_BOARD_KEY` (`snapshot-doc.js:10`) and `dispatchKey` (`storage-bridge.js:166`).
- Fix: move each comment next to its constant.

### M2. The kv key format `scope|cid|key` is spelled in four places
- `bridge/storage-access.js:4` defines `keyOf`.
- `bridge/user-prefs.js:75` and `:117` hand-write `` `u|${clientId}|${key}` `` twice.
- `bridge/bridge-diagnostics.js:28` hand-writes the `` `u|${clientId}|` `` prefix.
- `storage-bridge.js:165-173` parses the same format.
- The original had one `keyOf` (83a7892 `:200`). The split duplicated it, which breaks the AGENTS.md "Shared layer: multi-caller logic belongs in ONE neutral module" rule.
- Fix: one small key module (or `domain/vote-comment-keys.js`, which already owns the `s||…` prefixes) exporting `keyOf` and a `userKey(cid, key)`, used by all four.

### M3. The storage contract's producer exclusion still names only the old file
- `src/client/session/storage-contract.test.js:18` excludes only `storage-bridge.js` as the producer. Producer code now lives in `src/client/session/bridge/*.js`, and those files are scanned as consumers.
- The hazard the comment at `:17` describes ("its own `window.storage.x = ...` assignments would make any new member look consumed") now applies to them. A comment already matches the pattern: `bridge/awareness-presence.js:130` "storage.on('change')". It is harmless today because `on` is consumed elsewhere, and the fixture `bridge/fixtures/storage-keys.json` independently pins the exact key order on all four routes.
- Fix: exclude the `src/client/session/bridge/` prefix as well.

### M4. i18n key-parity coverage now follows the loader map, not the picker list
- `src/client/ui/i18n-keys.test.js:42,66` now derive `lazyCodes` from `LOCALE_LOADERS`. They used to derive them from `LANGUAGE_OPTIONS`. `LOCALE_LOADERS` was newly exported (`i18n.js:16`) for this.
- No test ties `LANGUAGE_OPTIONS` to `dict` ∪ `LOCALE_LOADERS`. Someone could add a picker entry and its locale file but forget the loader. The picker would then show a language that `setLang` silently ignores (`i18n.js:62-63` returns without switching), and the parity test would no longer check that file's keys.
- Fix: one assertion that the set of `LANGUAGE_OPTIONS` codes equals `Object.keys(dict) ∪ Object.keys(LOCALE_LOADERS)`.

### M5. The 12,949-line i18n output golden master will act as a change detector
- `src/client/ui/i18n.test.js:76-90` with `src/client/ui/fixtures/i18n-outputs.json`.
- It was captured before extraction (abcf9da), which is correct for proving the move. After the merge, though, every legitimate copy fix in any of 11 languages turns it red, and the only way back to green is regenerating the fixture from the new output. That is the tautology the Tests rule forbids.
- The deep-equal check this review ran, old `dict` vs new locales, proves the same thing once.
- Fix: retire the fixture test once the branch merges, or narrow it to a handful of spec-derived samples. Keep the behaviour tests at `:7-74` and `:92-110`.

### M6. The locale files are close to the generic size cap
- `locales/th.js` is 1211 lines and `locales/en.js` is 1196, against `UNCEILINGED_MAX_LINES = 1250` (`rule-ratchets.test.js:12`). Neither has its own ceiling.
- That leaves about 39 keys in th before `every production source above the unceilinged limit has its own ceiling` fails. A ceiling can then only be added, not raised later. This is the same squeeze as ruling I18N-SEQ, one level down, and the owner's feature branches add keys.
- Fix: decide now. Either split the locales by namespace (for example `locales/th/{board,legal,maintainer}.js`) or record an owner ruling that locale data files are exempt from the line cap (data, not logic).

### M7. `RemoteCursorLayer.jsx` brought inline literals and broken indentation into a new module
- `src/client/session/RemoteCursorLayer.jsx:9-57`: the JSX is indented 6 spaces under `return (`, and there is a stray blank line before `);` at `:57`.
- Unnamed numeric style literals came along with the move: `size={23}`, `strokeWidth={2.6}`, `marginTop: 17`, `maxWidth: 160`, `fontSize: 13`, `lineHeight: 1.15`, and `'transform 18ms linear'`.
- This is a verbatim move, but the file is new, and AGENTS.md says "no new issues regardless of existing ones" and "no magic numbers".
- Fix: name them (`CURSOR_ICON_PX`, `CURSOR_LABEL_MAX_WIDTH_PX`, `CURSOR_TRANSITION_MS`, …) or move them into theme tokens, and re-indent.

## Deferred-minor triage (ledger items in this area)

| Ledger item | Status at a7baeaf | Verdict |
|---|---|---|
| T3: `bridge-harness.js:41` repeats `'TEST'`/`'Abcdefgh12345678'` from `BOARD_URL` (`:18`) | still present | can-wait |
| T3: `bridge-harness.js:23` exports `unlockLockedRoom`, used only inside the file (`:40`) | still present | can-wait (drop `export`) |
| T3: `storage-contract.test.js:21` filters `NOT_STORAGE_MEMBERS` by name everywhere | still present | can-wait; route-key fixture is the stronger guard |
| T3: `storage-contract.test.js:157` pins arity on the board route only | still present (`:157-163`) | can-wait; public and locked routes share the same function objects |
| T3-D5: `clearVotesForItems`, `editComment` have no consumers | still on the surface (`contribution-store.js:147,165`); listed in `UNCONSUMED_BUT_FROZEN` | can-wait; P3 kept the frozen surface. Removing them is a surface change that needs an owner decision |
| T4: `storage-bridge.test.js:759` peer item built with `id: undefined` | still present | can-wait |
| T4: only the undo/redo test has a recorded red proof | unchanged | can-wait |
| T5: registration-order test is a tripwire, not notification order | unchanged; the companion notification test (`storage-bridge.test.js:886-900`) covers order | can-wait |
| T5: `kvProbeEntries` JSDoc (`storage-bridge.test.js:810`) says `u|` is the only kind the dispatch forwards; `s|` keys are forwarded too (`storage-bridge.js:173`) | still wrong | can-wait (one-line fix) |
| T5: `BRIDGE_FRAME` depends on the V8 stack layout | unchanged. It still matches because the board observers stayed in `storage-bridge.js` (`:213-225`). If they ever move, the test fails loudly rather than passing vacuously (non-empty expected list) | can-wait |
| T6: guard title wording; `oversizeWithoutCeiling` exported for its own test | unchanged | can-wait |
| Ruling I18N-SEQ (i18n.js at its ceiling blocks new keys) | resolved: `i18n.js` is 92 lines and keys now go into `locales/*.js`. See M6 for the next limit | resolved |

No ledger minor in this area is must-fix-before-merge.

## RULE CONFORMANCE

- Code shape: FAIL → M1 (orphaned comments), M2 (key format duplicated, shared-layer rule), M7 (magic numbers and indentation in a new module). One-way dependencies PASS: modules get lower-owned handles and method maps, nothing imports the bridge, and there are no cycles. CC ≤ 15 PASS per the P3 ESLint evidence and my reading.
- Tests: FAIL → I1 (source-text scan of `RetroBoard.jsx` outside the sanctioned list), M5 (golden master becomes a change detector after merge), M4 (coverage drift). The characterization expectations are captured from pre-move commits (`storage-keys.json` `capturedFrom: 6a891b8`, `i18n-outputs.json` from abcf9da), not from new output. Existing bridge and contract tests are unchanged since 576e3bd. No skip, only or suppression was added, and every ceiling went down.
- Logging and disk writes: PASS. The only log line (`console.debug('[yjs]', ROOM_LABEL, status)`) keeps its format and frequency, and no sinks were added.
- Data location: PASS. Committed fixtures are small test inputs.
- Karpathy guidelines: PASS. The decomposition is surgical: no behaviour changes, no speculative abstraction.
- Repo style: FAIL → M7 (indentation). Otherwise it matches.
- Failure-path tests: PASS. Import rejection subtests leave the state unchanged. There are tests for blocked localStorage, transact refusal, dead-relay bounded sync wait, public-permit rejection expiry, and a failed locale chunk keeping the current language.
