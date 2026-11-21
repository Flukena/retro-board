# Final review: relay and domain layer (83a7892..a7baeaf)

Scope: `yjs-server.mjs`, `src/server/` (new relay-* modules, un-exports, relocated tests), `src/domain/`, `Dockerfile.yjs`, relay tests and the relay test harness `src/test-support/relay-entrypoint.js` / `relay-persistence-fixture.js`. Read-only review; no live, browser or docker runs.

Method (what I checked myself, not taken from phase reports):
- Read the base relay root (`git show 83a7892:yjs-server.mjs`, 1445 lines) end to end and compared every moved block against the 14 new relay modules at HEAD line by line: room accounting, late bindings, storage-failure latch, persistence/compaction, vote expiry, room policy/state (bindState listener order, hydration, writeState), admission limits, awareness policy, ws-admission, ws-connection, upgrade, HTTP dispatch, runtime shim and banner, client IP, origins.
- Top-level await / init order in the new root vs base: utils import before origin parsing, WIPE before hydrate, `setPersistence` before `migrateLegacyImages`, public-wall `roomReady` await before `rejectionCounters`, recovery and orphan reconcile before `listen`. Unchanged.
- Literal diff of every `console.*` first argument, `close(code, reason)`, `new Error('...')`, `rejectUpgrade(socket, ...)`, `writeHead(...)` and `blockRoom(..., reason)` in base root vs HEAD root + new modules: identical multiset; the only difference is the two origin error strings now held in named constants (`src/server/relay-origins.js:1-2`, byte-identical). `rejectionCounters.*` call sites identical (only the accounting getter receiver changed).
- Independent import-closure script over `yjs-server.mjs` + `scripts/public-wall-restore.mjs` (static `import`, `export ... from`, literal dynamic imports) vs the `Dockerfile.yjs` COPY lists: 0 missing files. Only dynamic import is `relay-runtime.js:25` (`node_modules/y-websocket/bin/utils.js`, resolves to `/app/node_modules` in the image; `createRequire` anchor `../../package.json` resolves to `/app/package.json`, which the image copies).
- Import-cycle and layering scan over non-test `src/server` + `src/domain` + root: no cycles, no domain-to-client/server import.
- Every un-exported name in `src/server` and `src/domain` grepped repo-wide (incl. `scripts/`, `maintainer/`, docs): no remaining importer; every name still used in its own file.
- Domain moves compared against base `RetroBoard.jsx`: `filterLockedZoneMoves` (base :855-880), `create*Item` (base :1238-1345), `resizeGeometry` (base :2481-2502), `sizeForResize/GroupBounds/StickySignature` (base :1413, :2469-2470, :2580-2581, :3262-3263, :3429-3430, :3707), `undoBlockReason` (base :1136-1150), `applyRemoteSnapshot` (base :920-945), vote/comment/mood keys (base `storage-bridge.js:225,564-589`, `mood-check.js`). All preserve behaviour except one narrow undo/redo timing window in `applyRemoteSnapshot` (M11).
- Maintainer UI stage of `Dockerfile.yjs` (:1-9 copies only `maintainer/`, `src/client`, `src/domain`): closure from `maintainer/index.html` → `src/client/maintainer/main.jsx` is 35 files, all inside those three directories.
- Relocated/rewritten relay tests diffed with rename detection: the six moved files change only import paths, repo-root URLs and `cwd`; no assertion dropped. The resilience, relay-http and local-files source-slice tests were replaced by tests that import the real entrypoint through `relay-entrypoint.js`; all prior assertions survive, several are strengthened.
- Read every new relay test and fixture: `relay-{admission-limits,awareness-policy,client-ip,origins,room-accounting,vote-expiry,persistence,room-state,ws-admission,ws-connection,upgrade,http-dispatch,runtime,late-bindings}.test.js`, `relay-connection-fixture.js`, `relay-persistence-fixture.js`, `relay-entrypoint.js`. The harness replaces boundaries only (y-websocket utils, `ws`, `RelayProtocol.inspect`, LevelDB, lifecycle, timers), never the module under test. Expected values come from config constants or stated contracts (close codes, error strings, 60 s retry), not from new-code output.
- No `.only`, `skip`, `todo`, `NOSONAR`, `eslint-disable` in the area.

## Critical

None.

## Important

### I1. Spec-required local relay image build smoke never ran (Dockerfile.yjs)
- Where: design spec `docs/superpowers/specs/2026-11-19-codebase-refactor-design.md:179` (P4 safety net: "local image build smoke (no deploy, no compose change)") and `:280` (mitigation for "Dockerfile.yjs COPY forgotten"); ledger `progress.md:270` "Relay image not built".
- What breaks, for whom: the production relay image (`Dockerfile.yjs`) gained 14 COPY entries (`Dockerfile.yjs:34,49,59-69`) and the relay now resolves `y-websocket/bin/utils.js` and `package.json` through `src/server/relay-runtime.js:16,24` relative to `src/server/` instead of the root. Unit and spawn tests run from the repo checkout, never from the image layout. A miss would take the production relay down at R-B (crash on boot).
- Evidence: my static closure check found 0 missing relay files, and both relative anchors land on `/app/...` paths the image provides. The maintainer-ui stage closure (35 files) stays inside its three copied directories. So I expect the build to pass. But that is static reasoning: the spec demands the build itself, `relay-image-files.test.js` cannot see `export ... from` edges (see M4), and the image runs pinned Node 24 while P4 ran on Node 26.5 (`p4-report.md`, "Final verification and limitations").
- Fix: before the R-B release (not necessarily before merge), build `Dockerfile.yjs` locally and boot the image once with a temp DB (`scripts/scan-production-images.sh` covers the scan half). Building an image is not a deploy, but check that the owner-approval note in `progress.md:270` does not cover it.

## Minor

### M1. New relay modules keep bare protocol literals (magic numbers)
- Where: `src/server/relay-upgrade.js:18,23,34,40,45,50,81,89` (403/404/401/429/503), `src/server/relay-ws-connection.js:12,16,22,28,34,61` (1008/1011), `src/server/relay-room-state.js:21` (1009), `src/server/relay-http-dispatch.js:23,50,87,91` (400/200/503/404), `src/server/relay-ws-admission.js:24,28` (1009).
- Impact: none at runtime. They were copied unchanged on purpose (spec anti-goal: status and close codes must not change). But they now sit in new files, so they count as new Sonar code under AGENTS.md "no magic numbers regardless of existing ones". The repo already names these elsewhere (`relay-http-slots.js:1-2`, `room-deletion.js` `DELETE_STATUS`).
- Fix: add named constants, e.g. `WS_CLOSE_POLICY = 1008`, `WS_CLOSE_TOO_LARGE = 1009`, `WS_CLOSE_SETUP_ERROR = 1011`, and HTTP status names, in one shared relay module. The literal-diff check above proves the values stay the same.

### M2. 16 new imports were put above the file's header comment
- Where: `yjs-server.mjs:1-18`. The header "Yjs WebSocket relay with LevelDB persistence. Single source of truth..." now sits at :17-18, in the middle of the import block.
- Impact: readability only.
- Fix: move the header comment to line 1.

### M3. The readiness comment was dropped in the move
- Where: `src/server/relay-http-dispatch.js:47-55`. The base had a 4-line comment explaining why `/readyz` is separate from liveness (base `yjs-server.mjs:1119-1122`). Every other moved block kept its comments.
- Impact: lost context for the next maintainer, which is exactly the place where someone might "simplify" readiness into liveness.
- Fix: restore the comment above `handleReady`.

### M4. The image-contract test cannot see `export ... from` edges
- Where: `src/server/relay-image-files.test.js:9` (`STATIC_RELATIVE_IMPORT_PATTERN` matches only `import`).
- Impact: the relay closure has re-export edges (`src/server/relay-uploads.js:15`, `src/server/room-lock.js:6`, `src/domain/vote-results.js:8`). Task 12 added a new one (`src/domain/mood-check.js:3`, which is not in the relay closure). Today every re-export target is also imported statically somewhere, so nothing is missing (my closure script handles both forms and agrees). A future module reached only through a re-export would pass this test, and the production relay would fail at boot. This test is the spec's named guard (`spec:38`). The file predates the branch, but the branch leans on it for 15 new files.
- Fix: extend the pattern to `(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]`. No real file today is reachable only through a re-export (`room-lock-record.js` is also imported statically at `yjs-server.mjs:53` and `relay-upgrade.js:3`), so prove the gap on a synthetic source. Extract the scanner into a function, assert that the old pattern returns no edge for `export { X } from './only-reexported.js'`, and assert that the new pattern returns it.

### M5. Vacuous consumer case and a domain test that imports client code
- Where: `src/domain/vote-comment-keys.test.js:39-45` and its import at `:5`.
- Impact: the "remote board decoding keeps the mood round addressed by built and legacy keys" case parses the key in the test itself, then passes `{ id: roundId }` to `decodeRemoteBoard`. `decodeRemoteBoard` never sees a key, so the case would still pass if the decoder dropped key support. The spec asked that "a key built by the schema is parsed by each consumer" (`spec:157`). P2B states the decoder does not parse keys at this HEAD, so the case should be deleted or moved, not kept as coverage. The `../client/` import from a domain test has precedent (`move-concealment.test.js`, `template-store.test.js`) and is not a runtime layering break.
- Fix: delete this case, or move a real decoder-level check to `src/client/board/remote-board-decoder.test.js`.

### M6. Speculative third parameter on `undoBlockReason`
- Where: `src/domain/undo-guard.js:1,4`. Callers: `RetroBoard.jsx:847,852`.
- Impact: production never passes `hasUndo`. The empty-stack toast stays at the call site (RetroBoard.jsx:849,854), as the P2B report says. Only tests use the `'topbar.nothingToUndo'` branch (`undo-guard.test.js:10-13`). The same function also guards redo, where that branch would show the wrong message (`topbar.nothingToRedo` is the redo key). The spec truth table names "nothing to undo", but the implementation deliberately does not route it through the guard. This conflicts with AGENTS.md Karpathy 2 (no speculative API).
- Fix: drop the parameter and its four test rows, or pass a redo-aware key. Keep the call-site behaviour as is.

### M7. New relay tests use `.test.js`; AGENTS.md says relay tests use `*.test.mjs`
- Where: 14 new files, e.g. `src/server/relay-upgrade.test.js`, `relay-persistence.test.js`, `relay-room-state.test.js`, `relay-late-bindings.test.js`. Rule: AGENTS.md:28. Before the branch, `src/server` had 51 `.test.mjs` and 14 `.test.js` files.
- Impact: repo style only. The runner discovers both extensions.
- Fix: rename to `.test.mjs`, or have the owner relax the AGENTS.md wording.

### M8. Ceiling numbers in the docs are stale
- Where: `AGENTS.md:28` says RetroBoard 4177 and relay 1836; `ARCHITECTURE.md:39` says 4,177 and 1,881. The ratchet constants are 2895 and 441 (`src/rule-ratchets.test.js:8-9`).
- Impact: agents read the wrong size budget. The spec already plans this correction after owner approval (`spec:301`, `progress.md:143,265`).
- Fix: fold it into the pending owner-approved doc patch.

### M9. The relay test harness shares process-wide y-websocket state between entrypoint instances
- Where: `src/test-support/relay-entrypoint.js:101-107` and `relay-persistence-fixture.js:63`. The `docs` Map and `setPersistence` from y-websocket's cached CJS `bin/utils.js` are global, so a second `relayEntrypoint()` call in the same test file replaces the first one's persistence.
- Impact: test isolation only. Current tests compensate (one entrypoint per test; `t.after` deletes the docs entries). A future test that builds two entrypoints and drives the first would silently exercise the second's persistence.
- Fix: state this limit in the harness header comment, or assert in `relayEntrypoint` that no other session is live.

### M10. `handleConnection` may exceed cognitive complexity 15 under Sonar
- Where: `src/server/relay-ws-connection.js:25-91`.
- My hand count, by the cognitive-complexity whitepaper rules (+1 per `if`/`catch`, +nesting level, +1 per `||`/`&&`/`??` sequence; inline callbacks raise nesting):
  - outer body: 6 (`if` :27, `if` :33, `if` :49, `if &&` :50 = 2, `if` :59);
  - `error` callback: 2 (`catch` :41 at nesting 1);
  - `message` callback: 17 (`if ||` :67 = 3, `??` :68 = 1, `if ||` :69-71 = 3, `catch` :81 = 2, `if` :80 inside `try` at nesting 2 = 3, `if &&` :87 = 3, `if` :88 = 2).
  - Total if inline callbacks count toward the enclosing function: about 25. Total if Sonar scores the `message` callback separately: about 11. P4's "maximum 14" is a conservative AST audit, not a Sonar run (`p4-report.md`: "no Sonar scan was run").
- Impact: none at runtime. The same body was the module-level `wss.on('connection', ...)` callback in base (`:1193-1317`), so this is not a regression. But it now lives in a new file, and AGENTS.md CC ≤ 15 is a hard rule.
- Fix: run SonarLint on this file. If it reports more than 15, move the message callback into a named `createMessageHandler({ doc, docName, conn, context, meter, clientIp, req, parseYjsMessage })` in the same module, keeping statement order.

### M11. `applyRemoteSnapshot` drops recent-move protection a little more broadly on undo/redo than base
- Where: `src/domain/apply-remote-snapshot.js:14,18`, called at `RetroBoard.jsx:682-691`.
- Base: the call site cleared `recentlyMovedRef` (base RetroBoard.jsx:925). The updater then reconciled against the live ref (base :936-940), so a move recorded after the clear but before the updater ran (React runs updaters lazily) was still protected and kept.
- Now: on `isUndoRedo` the reducer reconciles against `new Map()` and returns every key present at updater time in `forgetMoveIds`. The call site deletes them, so such a late move loses its protection for that snapshot and is forgotten.
- Impact: a very narrow window (a local drag finishing between the undo/redo event and React's next render). The visible effect at worst is one peer-echo snap-back on that item. The spec mandated the reducer shape and the test pins the new behaviour (`apply-remote-snapshot.test.js:73-77`), so this is a disclosed drift, not a bug in the spec's terms.
- Fix: none required. To restore exact parity, drop the `isUndoRedo ? new Map()` override at :14 and rely on the call-site `clear()`, as base did. The test at :73-77 would then pass a cleared map, mirroring the call site.

## Deferred-minor triage (ledger items in this area)

| Ledger item | Status at a7baeaf | Verdict |
|---|---|---|
| Tasks 8 (`progress.md:126`): `yjs-server.resilience.test.mjs` injects relay-* exports through a regex-built specifier the import scan cannot see | Resolved. The test now imports the real entrypoint through `relayEntrypoint` (`src/server/yjs-server.resilience.test.mjs:4-10`); the regex loop (base :12-16) and `runInNewContext` are gone | closed |
| P2B and P4: Node 24 verification owed (local runtime Node 26.5; the harness uses `module.registerHooks`) | Unverified here. From memory, `registerHooks` landed in 23.5 and was backported to 22.15, so Node 24 should have it. The CI/release gate on Node 24 settles it | must pass before R-B (the release gate runs Node 24) |
| P4 live-owed "two-client yjs:dev smoke" | Covered by the controller's full 22/22 manifest at 607cf25 and a7baeaf (brief) | closed |
| P4 open concern: transient failure of the live-vote deadline test (350 ms deadline, 650 ms wait) under a loaded full run; isolated 41/41 | Timing-sensitive spawn test in `src/server/yjs-server.security.test.mjs`, unchanged by this branch. Watch it on the release candidate; do not loosen its timing | can wait |
| `progress.md:270` and P4 "owed to owner": relay image not built or run | See I1 | must-fix before R-B release |

## RULE CONFORMANCE

- Code shape: FAIL → M1 (magic numbers in new modules), M6 (speculative parameter), M10 (possible CC > 15, needs a Sonar run). Otherwise PASS: one-way dependencies, no cycles (scanned), late bindings fail fast instead of back-references, shared usage fallback consolidated into `relay-room-accounting.js:10-14`, imports at top.
- Tests: FAIL → M5 (vacuous consumer case). Otherwise PASS, from reading every new relay and domain test: the moved tests keep every assertion; source-slice tests were replaced with real-entrypoint tests; the harness injects boundaries, not the unit under test; expectations come from constants and contracts; the key fixture matches the base builders by code reading (`keyOf` at base `storage-bridge.js:225`); no skip or only.
- Logging and disk writes: PASS. Log lines, levels and payload keys are byte-identical (literal diff); no new sinks or per-message lines.
- Data location: N/A. No data-writing code added; test temp dirs use `os.tmpdir()` as before.
- Karpathy guidelines: FAIL → M6. Otherwise PASS (surgical moves; the only behaviour drift found is M11, which the spec mandated).
- Repo style: FAIL → M2 (header comment placement), M3 (dropped comment), M7 (`.test.js` vs `.test.mjs`), M8 (stale doc numbers).
- Failure-path tests: PASS, with I1 as a verification gap. Storage-failure latch, early-binding rejection, hydrate failure, store failure, upgrade 401/403/404/429/503 counters, readiness 503, invalid target 400 and slot exhaustion are covered. The image boot path is unverified (I1, M4).

## Unverified / residual risk

- No Docker build or image boot (I1). No Sonar or ESLint run (ESLint is not in `node_modules`; P4 says a Sonar scanner exists but was never run). The CC figures are my hand count (M10) and P4's AST audit.
- The Node 24 `registerHooks` availability is from memory, not checked.
- Behaviour equivalence was checked by reading code, plus literal and closure scripts. The live manifest and spawn suites (run by the orchestrator) are the runtime evidence.
