# RetroBoard codebase: current-state map for the refactor (2026-11-19)

Factual input to a refactor design, not the design. Goal of the refactor: maintainability with zero behaviour change. Citations are `path:line` against main @ 5493a90. "(inferred)" marks claims not verified by running code.

## 1. Scope and method

- Commit: main @ 5493a90 (verified `git rev-parse`), worktree `/Users/sakontheerasuwanajak/Documents/miro-wt-main`. Read-only recon, no browser, no relay, no full test suite.
- Eight parallel readers: rb-state (component body), rb-render (JSX and top-of-file), rb-collab (collaboration paths), session (storage-bridge, e2e-provider, room-session), relay (yjs-server.mjs + src/server), i18n-ui, tests (safety net), hygiene. This synthesis re-verified: file lengths, ceilings, component start line, storage-bridge test count, dead constants, and the absence of any `isUndoRedo` assertion in bridge tests.
- Not examined: CSS, public/, maintainer app internals, poker, SEO prerender beyond i18n, Docker image build, CI workflows (`.github/workflows` not read), real complexity numbers (no Sonar; all complexity figures are eyeballed). Nothing was run in a browser; render-count and effect-order claims are inferred.
- Line numbers drift if other branches touch RetroBoard.jsx; re-grep symbols before editing.

## 2. Metrics

### Largest production files (verified by wc unless noted)

| File | Lines | Ceiling / note |
|---|---|---|
| RetroBoard.jsx | 3993 | ratchet 3993 (`src/rule-ratchets.test.js:8`), zero slack |
| src/client/ui/i18n.js | 2504 | no ceiling; th 10-1216, en 1217-2409 |
| src/client/session/storage-bridge.js | 1469 | no ratchet, no exports |
| yjs-server.mjs | 1445 | ratchet 1446 (`rule-ratchets.test.js:9`), 1 line slack |
| e2e-provider.js | 681 | clean class, injected seams |
| theme.js | 678 | tokens 1-605, runtime 606-678 |
| room-session.js | 565 | |
| e2e-room-log.js 520, relay-config.js 500, relay-room-registry.js 445, relay-uploads.js 440, import-schema.js 410 | | |
| locales/{zh,ja,ko,es,pt,de,fr,vi,id}.js | 1175 each | generated parallel copies |

### RetroBoard.jsx hook counts (rg line counts, 238 total)

| Hook | Count |
|---|---|
| useState | 29 |
| useRef | 52 |
| useMemo | 28 |
| useEffect | 33 |
| useCallback | 96 |
| useLayoutEffect | 0 |

Component: `export default function RetroBoard` at :213 (rb-state said 212; verified 213). Hooks end :3591; early `if (!loaded)` return :3596-3606; JSX return :3608-3992. Any hook must stay above :3596.

Hooks by concern (approx, from rb-state): viewport 35, votes/comments 25, remote presence 20, selection/focus 20, geometry writes 20, presence broadcast 14, follow 14, toast/dialog flags 14, item creation 12, render memos 12, minimap 10, permissions 9, export/import 8, text editing 5, z-order 5, vote session 5, load/sync 5, others <5.

Hot shared symbols (uses in body): boardRef 53, setToast 50, interactionRef 43, viewportRef 36, stopFollowing 27, reportWriteFailure 26, requireEdit 25, settleWheelBeforeInteraction 20, activeGeometryFinalizerRef 19, dragItemsRef 17, updateFocusedText 16, activeViewportFinalizerRef 15, liveApplyViewport 12, commitGeometry 12. `window.storage` references: 53 (rb-state/rb-collab) vs 80 `storage.` call sites (session); different greps.

### Layers and tests

| Item | Value |
|---|---|
| src/client/ui total | 16876 lines |
| src/server | 127 files = 62 production + tests, 19146 lines |
| Test files in src | 392: domain 69, server 65, client 227 (board 77, session 37, ui 25, app 15, room-lock 15, transfer 14, public-wall 9), src top 2 |
| Root tests | 7; scripts tests 8 |
| storage-bridge.test.js | 776 lines, 36 tests (verified; session reader said 35) |
| board-reconciliation.test.js / pending-local-items.test.js | 6 / 4 tests |
| Live-check scripts | 15-17 Playwright scripts, ~7000 lines, manual |
| Unused exports | 99 no importer; 229 test-only |
| TODO/FIXME | 0 |

## 3. RetroBoard.jsx map

Concerns (lines in `RetroBoard.jsx`):

| Concern | Lines | Hooks (approx) | Owned state/refs | Couples with | Already delegated? |
|---|---|---|---|---|---|
| Setup, i18n, theme, identity | 213-229 | 3 | useLang/useTheme/useUserIdentity | none | yes (hooks) |
| Board mirror | 231-233 | 2 | board, boardRef (effect-synced) | everything | no |
| Viewport core, wheel, fit/zoom | 236-257, 477-489, 1204-1209, 1579-1634, 1713-1790, 1985-2035 | 35 | viewport, viewportRef, renderedViewportRef, wheel* refs, worldRef/gridRef/selectionLayerRef/cursorLayerRef | gestures, presence, follow, minimap | partly (viewport-framing, viewport-zoom, viewport-renderer, use-settled-viewport) |
| Presence broadcast | 347-353, 522-628 | 14 | 7 throttle refs | viewport | pure helpers only (player-cursors.js) |
| Remote presence + derived | 259-261, 391-460 | 20 | presence, remoteEditing/Selected | board, selection | helpers (editing-presence, selection-labels) |
| Selection, focus, clipboard | 264-272, 285-289, 319-335 | 20 | selectedIds(+Ref), focusedTextId(+Ref), creationMode | applyRemoteBoard, gestures | useDrawingMode delegated |
| Votes and comments | 274-284, 657-701, 1067-1111, 1408-1444, 1495-1569 | 25 | votesByItem, commentsByItem, flashes | sync effect | domain helpers |
| Vote session and admin timers | 1035-1054, 2993-3055 | 5 | timerSetupZoneId | recentlyMovedRef | vote-session-lifecycle.js |
| Load and remote sync | 703-754, 917-1033 | 5 | loaded | refs guards | board-reconciliation.js |
| Granular writes + geometry flush | 755-916 | 20 | pendingGeomRef, recentlyMovedRef, lastFlushRef, saveTimerRef | all callers | board-geometry, move-concealment |
| Toast and dialog flags | 291-318, 1113-1118 | 14 | toast, confirm* | all | no |
| Undo/redo wiring | 1120-1157 | 3 | undoState | dragItemsRef | no |
| Browser-zoom guard | 1159-1202 | 1 | none | none | no |
| Permissions and gates | 810-820, 1384-1407, 1446-1494 | 9 | none | writes, toast | useAdminRole, public-board-permissions |
| Item creation, image import | 1213-1383, 2867-2932 | 12 | fileDragPointRef | writes | image-drop/upload helpers |
| Z-order | 2127-2212 | 5 | none | permissions | z-order.js |
| Pointer gestures (pan, marquee, zone-create) | 1792-1983 | 3 (~190 lines closures) | finalizer refs | viewport | creation-mode.js |
| Minimap | 360-364, 491-520, 2036-2126, 3485-3495 | 10 | minimap refs | viewport (bidirectional) | minimap.js, MinimapPanel |
| Item/zone drag, resize | 2222-2716 | 4 (~495 lines) | dragItemsRef | writes, permissions | item-size-limits, move-reparenting |
| Duplicate, keyboard | 2718-2865, 3556-3560 | 2 | shortcutToolHandlersRef | almost all | board-shortcuts.js resolves keys |
| Text editing callbacks | 2933-2985 | 5 | none | focus, writes | security-boundaries |
| Follow and presenter | 293, 354-359, 373, 1636-1712 | 14 | followedUserId(+Ref), follow refs | viewport | usePresenterFollow, useFollowMotion |
| Admin actions | 2986-2992, 3056-3121 | 4 | none | writes | no |
| Export and import | 3120-3235 | 8 | pendingImport, importBusy | toast | useBoardExports, useActionItems, board-transfer.js |
| Templates | 795-802, 1985-1996, 3500-3505 | 3 | none | viewport | useBoardTemplates |
| Phase, mood | 3217-3228 | glue | none | admin | useRetroPhase, useMoodCheck |
| Render prep | 462-476, 629-656, 3236-3365 | 12 memos | none | all | partly |
| Floating UI helpers, mobile gestures | 3366-3591 | 2 effects | none | all | mobile-gestures.js |
| Refs block + unmount cleanup | 336-390 | 1 big effect | 31 refs | presence, follow, writes | no |

Writing timer and reactions are not in RetroBoard.jsx; they render inside ToolDock (`src/client/chrome/ToolDock.jsx:170-171`). Drawing is already fully delegated.

### Render sections (JSX 3608-3992)

| Section | Lines | Notes |
|---|---|---|
| Loading return | 3596-3606 | stateless |
| Root, grid, canvas, world shell | 3609-3783 | refs painted imperatively by paintViewport (:1582) |
| Items layer | 3657-3667 | measure ruler, renderedItems, LiveDrawingPreviews |
| Remote selection labels | 3669-3700 | |
| Remote editing indicators | 3702-3748 | uses size fallback at :3707 |
| Zone preview, empty hint | 3750-3781 | preview inside world, hint outside |
| Remote cursor layer | 3785-3835 | cursorLayerRef painted imperatively |
| Chrome wiring | 3837-3883 | TopBar, TopCenterStack, ToolDock, DrawingTool, ZoomControls, minimap, selection layer |
| Marquee | 3884-3900 | allowed blue literals |
| Dialog host | 3902-3989 | ~14 conditional dialogs, Toast :3990 |
| Render helpers | 3193-3532 | renderZone/Text/Image, renderedItems memo (:3288-3325, 30-entry dep list, eslint-disable :3300), renderResizeHandles (:3373-3471), renderActionToolbar, renderTopBar (:3473-3521) |

### Top-of-file constants (148-205)

TEXT_W/H, DRAG_THRESHOLD, MINIMAP_IDLE_MS, CURSOR_BROADCAST_MS (24), FOLLOW_VIEWPORT_COMMIT_MS, SCROLL_WHEEL_ZOOM_KEY, POLL_SAFETY (15000), DRAG_FLUSH_MS (60), DRAG_TRAILING_MS (80), RECENT_MOVE_WINDOW_MS (8000, :174), DENSE_CARD_THRESHOLD, COMMENT_PREVIEW_TEXT_LIMIT, EMPTY_COMMENTS (:180), HELP_SECTIONS (:183-190), uid (:193), clamp (:200, unused), readScrollWheelZoomEnabled (:202). Dead: SAVE_DEBOUNCE (:161), TEXT_SAVE_DEBOUNCE (:162), clamp (verified rg). Stale comment :149-154 (orphan of removed IMPORT_MAX_SNAPSHOT_BYTES).

## 4. Collaboration invariants

| # | Invariant | Upholding code | Guard (test / live) |
|---|---|---|---|
| 1 | Writes go storage first, then optimistic setBoard; failure skips local change | RetroBoard.jsx:771-807, 822-828 | none unit; ui-live-check two-user sync |
| 2 | Undo/redo overrides optimism guards: bridge flags `isUndoRedo`, component clears recentlyMovedRef, domain refuses to preserve pending creates | storage-bridge.js:517-531; RetroBoard.jsx:925; pending-local-items.js:8; board-reconciliation.js | Domain half only: board-reconciliation.test.js:33, pending-local-items.test.js:17. No test asserts bridge sets isUndoRedo (verified rg: tests hit only domain). Live: ui-live-check.mjs:335-350 |
| 3 | No undo/redo mid-drag or when locked | RetroBoard.jsx:1130-1152 | none |
| 4 | Local writes do not echo (except undo origin); only 'local' origin tracked | storage-bridge.js:508-531, 1385-1388 | storage-bridge.test.js:78, :116, :262, :361 |
| 5 | Drag/recent-move keeps local geometry; remote text still applied; 8000 ms windows | board-reconciliation.js:7-15; RetroBoard.jsx:174, 917-942; RECENT_LOCAL_ITEM_WINDOW_MS pending-local-items.js:1 | board-reconciliation.test.js:11-18; no live drag-with-peer check |
| 6 | commitGeometry single enforcement point (locked-zone rule, geometry validation, concealment); 60/80 ms flush | RetroBoard.jsx:844-915 | geometryErrorForPatch, move-concealment unit tests; locked-zone filter untested |
| 7 | Gesture exit paths clear dragItemsRef, busy claim, interactionRef, finalizer | RetroBoard.jsx:2255-2303, 2386-2440, 2552-2565, 375 | none (leak blocks undo permanently) |
| 8 | viewportRef is live truth during gestures; React viewport committed at end | RetroBoard.jsx:243-247, 1589-1592 | viewport-renderer.test.js (painter only) |
| 9 | followedUserIdRef set before state; stopFollowing on wheel/mousedown/fit/Escape | RetroBoard.jsx:1636-1663 | use-follow-motion.test.js only |
| 10 | Presence is awareness-only, 30 s freshness, per-connection slots; local busy cleared on unmount | storage-bridge.js:667-815; RetroBoard.jsx:372-381 | storage-bridge.test.js:407-440, editing-presence/player-cursors tests; no live presence check |
| 11 | Cursor/view throttled twice (24 ms component, 100 ms awareness-transport); must not be merged | RetroBoard.jsx:523-600; awareness-transport.js:19-52 | awareness-transport.test.js (100 ms layer only) |
| 12 | Votes read from live Yjs snapshot in toggleVote; removeItem deletes item+votes+comments in one transaction | RetroBoard.jsx:1213-1237, 1500-1520 | storage-bridge.test.js:343-420 |
| 13 | Export -> import round trip exact; import in one 'local' transaction; local echo suppressed so confirmImport must setBoard | storage-bridge.js:1114-1166; RetroBoard.jsx:3142-3178; board-transfer.js:73-82 | storage-bridge.test.js:286, board-backup.test.js:89-132, board-archive.test.js, image-upload.test.js; no UI file-import live check |
| 14 | adminClearBoard resets phase and moodCheck by name (hidden coupling to DEFAULT_BOARD fields) | RetroBoard.jsx:3056-3072 | none |
| 15 | applyRemoteBoard mutates recentlyMovedRef inside setBoard updater (must stay idempotent) | RetroBoard.jsx:938-939 | none |

### Past regressions

- c879817 (2026-09-01): Y.UndoManager applies undo with itself as origin; guards treated it as a stale echo, screen stuck; mid-drag undo overwritten by trailing flush. Guards: isUndoRedo flag, recentlyMovedRef.clear (:925), `!isUndoRedo` (pending-local-items.js:8), midDrag (:1135).
- 26bc4c5 (2026-09-01): legacy export with base64 images wrote one Yjs transaction above the relay frame cap (2,000,000 bytes, e2e-limits.js:5); relay dropped it silently, importer kept optimistic split-brain. Guards: sanitizeImportedImages (image-upload.js:149), bundle-size check IMPORT_MAX_BUNDLE_BYTES = 1 MiB (board-transfer.js:78-82, import-schema.js:37); test storage-bridge.test.js:745.

## 5. Session layer and storage-bridge.js

`src/client/session/storage-bridge.js` (1469 lines, zero exports): import-time singleton, loaded from `src/client/app/main.jsx:48`. Builds one Y.Doc (ymap 'kv', yItems, yMeta, :157-160), provider (:166), observers, then assigns a ~475-line `window.storage` literal (:893-1367, ~75 methods) and undo manager (:1368-1421, assigned late at :1385 while `let undoManager` is declared :229 and read by earlier observers).

| Area | Lines | Notes |
|---|---|---|
| Route gating, noop stub | 93-123 | stub omits many real methods |
| Local pref scoping, clientId | 143-153, 212-222 | |
| Public creation permit | 162, 179-208 | microtask flag |
| Item write validation | 235-259, 1115-1146 | inline type array at :1131 duplicates BOARD_ITEM_TYPES |
| Snapshot read/diff-write | 261-380 | |
| Granular writes | 382-428, 1048-1112 | origin 'local' vs 'system' decides undo |
| Migration/repairs | 430-496 | trigger duplicated (sync event and immediate) |
| Change fan-out | 498-558 | 5 ymap.observe handlers order-dependent (515, 598, 621, 651, 660) |
| Vote/comment key schema+index | 564-647 | key parsed also in canonical-votes.js:1, mood-check.js:24 |
| Awareness busy/editing/selection | 667-815, 936-1000 | 3 near-duplicate readers |
| User preference dual-write | 817-890 | |
| Images | 995-1033 | |
| importBundle | 1114-1168 | ~55 lines, est. CC ~30 |
| Votes/comments/moods/templates API | 1170-1350 | 6 copies of prefix-scan-delete |
| Undo | 1368-1421 | captureTimeout 500 magic number |
| E2E hook, reactions/timer (board route only) | 1423-1469 | |

Other: e2e-provider.js (681) is already a well-factored class (generation-fenced), leave alone. room-session.js (565): pure validators 1-176, HTTP 178-310, module-state session machine 330-500, roomFetch 502-545; state must stay in one module. Consumers: RetroBoard.jsx via `window.storage`, poker modules, hooks in transfer/templates/board/room-lock.

## 6. Relay: yjs-server.mjs + src/server

yjs-server.mjs is one top-level-await module (1445 lines) mixing bootstrap, composition and inline logic.

| Block | Lines | Complexity note |
|---|---|---|
| Env/config, client IP, Yjs CJS shim, origins | 62-157 | ip resolver 93-111 pure; origin parse 138-157 pure |
| Config destructure | 154-221 | 60 names, noise |
| Storage wiring, registry, failure latch | 221-300 | latch :286-300 |
| Upload usage reconcile | 303-326 | |
| Room byte accounting | 328-360 | shared `let` counters |
| Churn, block list, compaction scheduler | 361-520 | scheduleRoomCompaction ~100 lines, over CC15 |
| Store queue | 522-568 | |
| Vote expiry | 571-605 | source-sliced by test |
| bindState/writeState | 607-745 | listener before first await, roomReady sync |
| Rate buckets | 770-884 | pure given config+clock |
| Awareness ownership policy | 908-1022 | plan/commit |
| Route composition | 1024-1081 | |
| HTTP dispatcher | 1083-1156 | source-sliced |
| WS connection + per-message admission | 1193-1316 | ~124 lines, CC high |
| Upgrade handler | 1319-1393 | ~75 lines |
| Lifecycle, signals, listen | 1397-1445 | |

src/server already holds route handlers, stores, public wall, maintenance, uploads, lifecycle; each with a paired test. Constraints: forward references (markStorageFailure -> shutdown :1422; hasActiveRoomCapacity -> e2eRelay :1171; accountRooms -> roomDeletion :1184; HTTP handler -> roomLockRoutes :1179) need late-bound callbacks; shared mutable `let` counters (dbUsageBytes, pendingStoreOps/Bytes, activeDocumentBytes, storageFailure, shuttingDown); linear top-level await order (WIPE :238 before hydrate :277; setPersistence before migrateLegacyImages :747). `Dockerfile.yjs:31-47` lists every src/server and src/domain file; `src/server/relay-image-files.test.js:8-37` fails if an imported file is missing from COPY.

## 7. i18n and ui

`src/client/ui/i18n.js` (2504): `const dict = { th, en }` at :9-2410 (th 10-1216, ~148 KB; en 1217-2409, ~83 KB); LOCALE_LOADERS (nine dynamic imports) :2414-2425; LANGUAGE_OPTIONS :2427; setLang :2468 (synchronous in effect for loaded languages, last request wins, failed chunk keeps current language); languageReady :2483; t :2485 (current -> en -> key, `{param}` substitution); useLang :2496. `main.jsx:37,123` waits for languageReady before first render; prerender sets one language at a time (`prerender-entry.jsx:42-44, 63-64`).

Moving th/en to `locales/th.js` and `locales/en.js` via static import (low risk) requires:
- Rewrite `src/client/ui/i18n-keys.test.js:7-13` (it reads i18n.js text, slices from `const dict = ` to first `\n};` and evals).
- Fix `src/client/app/Landing.test.js:55` which greps i18n.js for "Retro Board" and would pass vacuously.
- Update AGENTS.md:31 text and plan docs naming i18n.js.
- Keep static (not lazy) so `setLang('th'); t(...)` stays synchronous in ~15 tests and live scripts (making th lazy is high risk, not recommended).
- No ceiling references i18n.js (rg of rule-ratchets: none).

theme.js: tokens 1-605 (defineTokens :30-39, TOKENS :472-604) split from runtime 606-678 (import-time apply, matchMedia listener); runtime has no test. Modals.jsx (354) and UiPrimitives.jsx (90) need no seams.

## 8. Safety net

Covered:
- Pure domain (69 test files), session with real Y.Doc (storage-bridge.test.js 36 tests), e2e-provider suites, relay (65 src/server tests + 7 root tests), presentational components via renderToStaticMarkup, ratchets.
- `src/rule-ratchets.test.js`: ceilings 3993/1446, colour literals in RetroBoard.jsx and src/**/*.jsx (8-entry allowlist), x-blob- header literal.
- `src/architecture.test.js:17-54`: layer direction (main.jsx only importer of RetroBoard.jsx, :26), domain host-free, acyclic graph.
- Live checks (manual, two-context Playwright): ui-live-check.mjs (sync, undo/redo, shortcuts), facilitation, retro-outcomes, writing-timer, board-reactions, account, room-lock, room-management, mobile, modal, pan, spacing, landing, public-tools, poker.

Gaps that block safe extraction:

| Gap | Blocks seam |
|---|---|
| RetroBoard.jsx has no test importing it; everything in-body is live-only | all |
| No test that bridge emits `isUndoRedo=true`; `recentlyMovedRef.clear()` at :925 lives in the component | useBoardSync, geometry writes |
| Mid-drag/locked undo refusal untested | undo hook |
| commitGeometry locked-zone filter, 60/80 ms flush, rollback untested | geometry writes |
| Drag/resize/marquee/zone-create closures untested; no live check drags a sticky, resizes, or drags with peer echo | gesture seams |
| 24 ms cursor/view throttle untested | presence broadcast |
| applyRemoteBoard focus-drop rule, resync, safetyTick untested | board sync |
| confirmImport paths and UI file import round trip untested | useBoardImport |
| Unmount cleanup (:374-390) untested | any split of refs/cleanup |
| Browser-zoom guard, theme runtime untested | trivial seams |
| renderedItems memo dependency list unguarded (no render-count test) | BoardItems extraction |
| No guard on window.storage method-name contract; observer registration order untested | storage-bridge split |
| Live checks not in npm test, no runner; `.test.jsx` would not be discovered (project-files.mjs:6) | CI trust |
| Source-scanning tests of RetroBoard.jsx: confirm-then-pin.test.js:6, theme.test.js:151, i18n-keys.test.js:27, rule-ratchets.test.js:58 | JSX moves |
| Source-slicing tests of yjs-server.mjs: resilience.test.mjs:12-24,32,48,65,103,114; relay-http.test.js:98-107,154; relay-local-files.test.mjs:39-41 | relay moves |

## 9. Hygiene

- Stale docs: AGENTS.md:28 says 4177/1836; ARCHITECTURE.md:39 says 4,177/1,881; actual 3993/1445 (ceilings 3993/1446). ARCHITECTURE.md:6-26 tree omits client dirs account, guide, maintainer, poker, reactions, room-lock, seo, workspace, writing-timer. AGENTS.md also still names `th`/`en` in i18n.js (:31). Main checkout has AGENTS.md modified in git status (coordinate).
- Root clutter: 7 root tests (public-wall.integration, relay-fatal-events, relay-heap-config, relay-maintenance, relay-room-registry, yjs-server.resilience, yjs-server.security); `retro_board_prompt.md` (16 KB, unreferenced, only commit bff8e7c). `maintainer/` and `public/google3da...html` are live, not clutter.
- Dead: SAVE_DEBOUNCE, TEXT_SAVE_DEBOUNCE, clamp (RetroBoard.jsx); never-used exports: router.js generateBoardCode/generateBoardToken, theme.js getThemePref, public-wall-config.js PUBLIC_RELAY_PORT; ~25 unused-but-exported helpers/components listed in hygiene reader (e.g. SignedOutControl, FontColorPicker, ResourceAlerts, EndAnnouncer); 99 no-importer, 229 test-only exports.
- Duplication: isPlainObject/isRecord x9 (variants differ on array handling: writing-timer.js:26 and board-reactions.js:12 do not exclude arrays); isBlobId x3; six local `HTTP` objects and repeated HTTP_* constants; time constants x8+; clamp x3; the default item size expression x8 in RetroBoard.jsx (variants differ, see seams); 6 prefix-scan-delete blocks in storage-bridge; 3 awareness readers; duplicated post-sync repair trigger (:478-496); startItemDrag vs startZoneDrag ~90% duplicate; live-check helpers (participant x6, activate x5, step x4).
- Complexity hotspots (inferred, not Sonar): RetroBoard.jsx key-handler effect :2760-2857, startItemResize :2464-2566, sync effect :944-1015, startPan, onCanvasWheel, startMinimapNavigation, renderResizeHandles; yjs-server scheduleRoomCompaction, wss connection :1193-1316, upgrade :1319-1393, planAwarenessUpdate; room-session exchangeSession :410; relay-uploads createRelayUploads; csv-import parseCsvRows; storage-bridge importBundle (~30) and writeBoardSnapshot (~22).
- scripts/README.md lacks entries for public-wall-restore.mjs, verify-backup-accounts.mjs, prerender-pages.mjs.
- `uid()` uses Math.random (7 sites); `session/random-id.js` createRandomId uses Web Crypto with different alphabet/length, so swapping is a behaviour change.

## 10. Candidate seams (deduplicated, sorted by risk then size)

Lines are estimates of lines removed from the source file. "Cov" = coverage today. IDs are for reference in section 11.

### RetroBoard.jsx

| ID | Seam | Moves | Target | Lines | Risk | Cov | Prerequisites |
|---|---|---|---|---|---|---|---|
| R1 | Delete dead constants/comment | SAVE_DEBOUNCE, TEXT_SAVE_DEBOUNCE, clamp, stale comment :149-154 | deletion | ~15 | low | ratchet, build | lower ceiling same commit |
| R2 | Browser-zoom guard hook | :1159-1202 | client/board/use-browser-zoom-guard.js | 44 | low | none | jsdom-free stub test |
| R3 | useToast | :297-300, 1113-1118 | client/ui/use-toast.js | 12 | low | none | keep setToast identity stable |
| R4 | Constants to leaf modules | drag/cursor/minimap/follow consts | drag-timing.js etc. | ~40 | low | none | keep uid as is |
| R5 | Loading screen | :3596-3606 | app/BoardLoading.jsx | 10 | low | none | |
| R6 | Remote selection labels + editing indicators | :3669-3748 | board/RemoteCollaborationLabels.jsx | ~79 | low | model tests only | markup characterization test |
| R7 | Canvas overlays (zone preview, hint, marquee) | :3750-3781, 3884-3900 | board/CanvasOverlays.jsx | ~48 | low | none | keep placement |
| R8 | useTopBarProps | :3473-3532 | chrome/use-topbar-props.js | ~50 | low | topbar-model.test | |
| R9 | Pure locked-zone filter | commitGeometry isAllowed :849-872 | domain/zone-move-lock.js | ~25 | low | none | tests first (cycle guard) |
| R10 | Pure item builders + defaultItemSize | :1238-1316, 2718 | domain/item-factory.js | ~75 | low | sizeForPlacement only | parameterise variants |
| R11 | useEditingPresence | :260-261, 415-460 | client/session/use-editing-presence.js | ~55 | low | model tests | two-browser check |
| R12 | useBoardImport | :3125-3178 | client/transfer/use-board-import.js | ~55 | low-medium | bridge round-trip only | hook test of 3 failure paths; useToast |
| R13 | useImageImport | :1316-1383, 2867-2932 | transfer/use-image-import.js | ~115 | low | helper tests | addImage injected |
| R14 | useUndoRedo + pure guard | :1119-1152 | board/use-undo-redo.js | ~35 | low | bridge undo tests | truth-table test, mid-drag |
| R15 | Latest-wins throttle + presence broadcast hook | :347-353, 522-628 | session/latest-throttle.js, use-presence-broadcast.js | 55-105 | low-medium | none (24 ms) | fake-timer tests; keep publishLocalView identity |
| R16 | Item footprint helper | 8 inline copies | domain/board-geometry.js | ~24 | medium | sizeForPlacement | characterization of 4 variants |
| R17 | RemoteCursorLayer | :3785-3835 | session/RemoteCursorLayer.jsx | 51 | medium | none | layerRef + viewportRef read at render |
| R18 | Dialog host | :3902-3989 | ui/BoardDialogs.jsx | ~95 | medium | source-regex test | repoint confirm-then-pin.test.js same commit |
| R19 | useSelection / useFocusedText | :264-272, 319-335, 2933-2985 | board/use-selection.js | ~90 | medium | none | keep ref mirrors, effect order |
| R20 | useVoteState | :274-283, 657-690, 1067-1111, 1408-1444 | board/use-vote-state.js | ~210 | medium | domain tests | split sync effect first |
| R21 | useAdminActions + useVoteSession | :1035-1054, 2986-3121 | board/use-admin-actions.js | ~180 | medium | lifecycle tests | geometry writes owner; hidden clearBoard coupling |
| R22 | Minimap hook | :360-364, 491-520, 2036-2126 | board/use-minimap.js | ~115 | medium | model/paint tests | direction vs viewport controller |
| R23 | Canvas pointer (marquee, zone create) | :1859-1983 | board/use-canvas-pointer.js | ~125 | medium | creation-mode tests | createGesture, viewport controller |
| R24 | Keyboard shortcuts + duplicate builder | :2718-2865 | board/use-board-shortcuts.js, domain/duplicate-items.js | ~150 | medium | resolveBoardShortcut | all action hooks done (last) |
| R25 | Container/view split | JSX + render helpers | board/BoardCanvasView.jsx, SelectionLayer | ~420 | medium-high | component tests only | all hooks first; memo identity |
| R26 | SelectionLayer (resize handles, toolbars) | :3249-3282, 3327-3471, 3877-3883 | board/SelectionLayer.jsx | ~175 | high | model tests | pure handle geometry first; data-selection-* attrs preserved |
| R27 | BoardItems (renderedItems) | :3193-3325 | board/BoardItems.jsx | ~135 | high | card tests | render-count test; stable handlers |
| R28 | Canvas shell | :3609-3783 | board/BoardCanvas.jsx | ~60 | high | cursor tests | last; refs bundled |
| R29 | useGeometryWrites | :755-916 | board/use-board-writes.js | 90-165 | high | pure fns only | R3, R9, timer characterization; recentMoves handle with forget(ids) |
| R30 | useBoardSync (load + reconcile) | :703-754, 917-1033 | session/use-board-sync.js | 100-175 | high | domain tests | R14, R20, R29; bridge isUndoRedo test; move :925 clear into reconcile |
| R31 | useViewportController | :236-257, 1579-1790, 1792-1850, 1985-2035 | board/use-viewport-controller.js | ~330 | high | pure helpers | break cull circularity (ref/getter); done with R32 |
| R32 | useFollowController | :293, 354-373, 397-407, 1636-1712 | board/use-follow-controller.js | ~120 | high | motion test | with or after R31 |
| R33 | Gesture lifecycle + drag/resize | :2221-2716 | board/pointer-gesture.js, use-drag-gestures.js, domain/resize-geometry.js | 400-420 | high | pure helpers only | R29; exit-path state-machine tests |

### storage-bridge.js

| ID | Seam | Lines | Risk | Cov | Prerequisites |
|---|---|---|---|---|---|
| S0 | Freeze ratchet at 1469 | 0 | low | none | add to rule-ratchets |
| S1 | Public-creation permit | ~35 | low | bridge :560-616 | keep microtask |
| S2 | Import-bundle plan (pure) | ~50 | low | success paths only | table tests per rejection; keep permit order |
| S3 | User-preference store | ~110 | low | local only | recovery tests |
| S4 | Awareness presence module | ~240 | low-medium | indirect | pure tests with fake Awareness |
| S5 | Vote/comment/mood key schema + index; one prefix-delete helper | ~150 | medium | domain tests | key byte-identical; parse agreement test |
| S6 | Board snapshot doc (read/diff-write) | ~190 | medium | bridge tests | bare Y.Doc tests |
| S7 | Undo controller | ~55 | medium | bridge undo tests | isUndoOrigin before first observer |
| S8 | Composition-root factory | ~1100 | high | bridge tests | all above; contract test of Object.keys(window.storage) |
| S9 | room-session split | ~200 | low | 4 test files | state stays in one module |
| S10 | E2E awareness collaborator | ~45 | medium | provider tests | defer |

### yjs-server.mjs

| ID | Seam | Lines | Risk | Cov | Prerequisites |
|---|---|---|---|---|---|
| Y1 | Client IP resolver | 18 | low | none | unit tests; relay-http.test.js injects it |
| Y2 | Origins parser | 19 | low | security :429 | byte-identical errors |
| Y3 | Admission rate limits | 115 | low | spawn tests | injected clock; shared bucket maps |
| Y4 | Config destructure removal | 55 | low | all | after Y3,Y5,Y6,Y9,Y11,Y12 |
| Y5 | Awareness policy | 114 | medium | indirect | fake awareness tests |
| Y6 | Room accounting + capacity | 70 | medium | spawn | getters not copies |
| Y7 | Vote expiry | 33 | medium | resilience slice | migrate resilience test first |
| Y8 | WS message admission | 75 | medium | partial | Y5, Y6 |
| Y9 | Upgrade admission | 73 | medium | spawn | Y1, Y3 |
| Y10 | HTTP dispatcher | 60 | medium | sliced test | rewrite relay-http.test.js:154 and resilience:48 first |
| Y11 | Yjs runtime shim, banner | 55 | medium | all spawn | resolve node_modules from repo root |
| Y12 | Persistence (churn, compaction, store queue) | 205 | high | none direct | Y6 + fake-timer characterization |
| Y13 | bindState/writeState | 139 | high | spawn | Y6, Y7, Y12 |
| Y14 | WS connection attach | 50 | high | spawn | Y8; keep one-listener check |

### i18n, theme, tests, hygiene

| ID | Seam | Lines | Risk | Cov | Prerequisites |
|---|---|---|---|---|---|
| U1 | th/en to locales files (static) | i18n.js -2400 | low | i18n tests | rewrite i18n-keys.test.js and Landing.test.js:55 |
| U2 | language-options.js | ~13 | low | tests | after U1 |
| U3 | theme-tokens.js split | ~560 | low | theme.test.js | add runtime test; check import cycles |
| U4 | th lazy | n/a | high | tests fail loudly | not recommended |
| T1 | Pure applyRemoteSnapshot reducer | ~40 | low | domain only | characterization tests |
| T2 | render-hook test helper | 0 | medium | 2 users | host stub limits |
| T3 | Live-check runner + common helpers | ~300 (scripts) | low | none | data volume rule |
| T4 | Lower ceilings each step | 0 | low | ratchet | |
| H1 | Fix stale docs | docs | low | none | owner approval for AGENTS.md |
| H2 | Move root relay tests into src/server | 0 | low | discovery | fix imports/URLs; do after Y-seam test migration |
| H3 | Remove retro_board_prompt.md | file | low | rg none | |
| H4 | Shared guards/http/time modules | many | medium | per-module | Dockerfile.yjs list; do not merge array-handling variants blindly |
| H5 | Remove dead exports | ~70 | low | build | rg each name |

Seams that overlap: R15/T-readers presence throttle; R29/R9; R30/T1; R12 vs S2 (UI hook vs bridge plan); R20 vs S5 (client hook vs key schema). Estimated RetroBoard.jsx reduction across all seams ~2300 (rb-state) but overlapping; render-tree-only ~700-800.

## 11. Open questions and contradictions

Resolved in this synthesis:
- Component start 212 vs 213: 213 (verified).
- storage-bridge test count 35 vs 36: 36 (verified by grep).
- rule-ratchets constant lines: ceilings at `rule-ratchets.test.js:8-9` (verified; relay reader's ":11-12" was off).
- Writing timer in RetroBoard: not present; ToolDock.

Unresolved:
1. Line-removal estimates overlap across readers (e.g. geometry 90 vs 165; presence 55 vs 105; item/gesture 400 vs 495). Treat as ranges.
2. Recommended order conflicts: rb-state puts useBoardSync after useVoteState; rb-collab puts geometry writes (S5) before sync (S6). Both agree geometry writes and sync are high risk and need a single owner of recentlyMovedRef/dragItemsRef/pendingGeomRef.
3. Root tests: hygiene says relocate relay-maintenance and relay-room-registry now; relay reader says migrate source-slicing tests before moving code and keep security/public-wall at root until the end. Compatible, but sequencing not settled.
4. Whether to unify `uid()` with createRandomId: they differ (Math.random vs Web Crypto, alphabet, length), so it is a behaviour change; excluded unless owner approves.
5. Duplicate default-size expressions: variants return 0 (:2580, :3262) vs 200 (:3429, :3707) vs 1200x1080 (sizeForPlacement). Equivalence for stored valid items is inferred, not proven.
6. Whether CI runs any live checks or `npm test` workflow details: `.github/workflows` not read; "not in CI" is inferred.
7. Effect-order, render-count and memo-identity claims for any component extraction are inferred; need a render-counter or live check.
8. Whether `updateFocusedText`, `t` deps in doUndo/doRedo/toggleVote lists matter for lint equivalence: no behaviour risk found, unverified by lint run.
9. Whether `bridge.isUndoRedo` is actually emitted for both undo and redo paths: read from code (storage-bridge.js:517-531), no test.
10. Complexity numbers (CC>15 candidates) are eyeballed; run Sonar/ESLint complexity before prioritising.
11. AGENTS.md line counts are stale; AGENTS.md is shared with Codex and is modified in the main checkout; edit requires coordination.
12. Hard-rule conflicts for new modules: AGENTS.md requires a paired colocated test for each new module, but no component test harness exists (T2); hook seams will need a render-hook helper or pure-core extraction.
