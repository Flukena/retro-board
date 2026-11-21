# Final fix wave

Scope: `refactor/codebase`, base `a7baeaf`. No browser, Docker, production, environment-file, or push operations. The explicit request to put gate output under `$TMPDIR` overrides the repository's default log-location rule for this run.

Conservative assumptions: the review's accepted independent toast-dismiss effect move stays accepted; the hook fixture is derived from production base `83a7892`, with that move documented in the fixture. Image preparation and board import preparation/read remain injectable asynchronous browser/I/O boundaries; constants and pure policies are imported directly. React M10 was a small behavior-free replacement of flags with named viewport methods. D-HOOK owner redesign remains deferred.

## Finding disposition

- harness I1: fixed (`a4c1a83`); four async Playwright predicates now use `pollUntil` around `page.evaluate`. RED: new async-predicate guard failed on the original modal/pan scripts; GREEN after replacement. No browser execution claimed.
- harness I2: fixed (`a4c1a83`); zero PASS lines fail. RED: exit-zero/no-step test observed `passed: true`; GREEN after fail-closed condition, including runner verdict assertion.
- harness chooser catch: fixed (`a4c1a83`); `Promise.all` observes chooser and menu failures, with no silent catch; syntax checks GREEN. No unit/browser test existed for this inline chooser operation.
- harness step copies: not fixed (explicitly deferred).
- harness live-check-common split: not fixed (explicitly deferred).
- harness console-error handling / spacing cosmetic assertion: not fixed (outside authorized wave; review says deferred/cosmetic).
- bridge I1: fixed (`ef8092b`); source-text test replaced by behavior tests through `createRemoteSnapshotController`, the actual `applyRemoteBoard` owner. RED mutations: moving clear into updater fails pre-focus/pre-schedule assertions; removing updater forget fails scoped cleanup assertion. GREEN restored; ordinary and absent snapshot cases remain covered.
- bridge M1: fixed (`ef8092b`); repair and legacy-board comments moved beside the constants they describe; comment-only, RED not applicable.
- bridge M2: fixed (`ef8092b`); `kv-keys.js` owns builder, user prefix and parser; all four production consumers use it. RED mutation: pipe-to-colon key encoding fails byte-format test; GREEN restored.
- bridge M3: fixed (`ef8092b`); producer exclusion includes `session/bridge/`. RED: producer-exclusion test failed with original single-file filter; GREEN after prefix exclusion.
- bridge M4: not fixed (explicitly deferred).
- bridge M5: not fixed (explicitly deferred).
- bridge M6: not fixed (explicitly deferred).
- bridge M7: fixed (`ef8092b`); cursor dimensions/styles named and indentation corrected. RED: changing icon size 23 to 24 fails added markup contract; GREEN restored. Markup assertions also pin stroke, transition, label dimensions and font values.
- relay I1: not fixed (image build/boot prohibited by this task; remains release verification owed).
- relay M1: fixed (`c68b089`); shared HTTP/WS constants preserve wire values and are included in the image COPY list. RED: setup-error close code 1011→1012 fails connection tests; GREEN restored. Existing admission/upgrade/HTTP/room-state tests GREEN.
- relay M2: fixed (`c68b089`); root header moved above imports; comment-only, RED not applicable.
- relay M3: fixed (`c68b089`); exact base readiness explanation restored; comment-only, RED not applicable.
- relay M4: fixed (`c68b089`); closure scanner follows import and export-from edges. RED: old regex misses synthetic re-export-only leaf and returns no dependencies; GREEN after regex extension, including real image closure.
- relay M5: fixed (`c68b089`); removed vacuous decoder/key consumer case and client import, as requested. Existing real canonical-vote, mood-key and summary consumer assertions retained and GREEN; RED not applicable to deletion of false coverage.
- relay M6: fixed (`c68b089`); removed unused hasUndo parameter/branch and its four speculative test rows; production call sites unchanged. RED mutation: reversing the locked-policy guard fails the remaining truth table; GREEN restored. Removing the unused branch itself has no production behavior.
- relay M7: fixed (`c68b089`); all 14 added relay tests renamed `.test.mjs`; full npm discovery verifies them. Extension-only, RED not applicable.
- relay M8: not fixed (explicitly deferred; owner docs patch pending).
- relay M9: not fixed (explicitly deferred).
- relay M10: fixed (`c68b089`, `784150f`); named message-handler factory keeps setup and listener order. Manual Sonar-style count: onMessage 11, handleConnection below 15, error callback 2; no analyzer claim. RED: omitting upstream parser fails exactly-one-parser behavior test; GREEN restored.
- relay M11: fixed (`c68b089`); removed undo/redo empty-map override. Test mirrors call-site clear and adds a move before lazy updater. RED against original override: x=1 instead of protected x=90; GREEN after fix. Clear-only case still accepts authoritative remote geometry.
- react I1: fixed (`24581cf`); both owners share one `forget(ids)` adapter; finalizer forgets the scoped ID array once. RED against original controller: real array-shaped handle throws `ids.forEach is not a function`; RED with single-ID stand-in: scoped move-set assertion fails; GREEN with real shape.
- react I2: not fixed (explicitly deferred to P6).
- react M1: fixed (`24581cf`); production-base fixture includes identity/templates/admin and P5A wrapper expansion; `6d646cc` removes redundant unused constants. RED mutation: former line matcher fails multiline-hook inclusion test; negative removal/reorder cases reject all three hooks. GREEN restored.
- react M2: fixed (`24581cf`); unchanged flash map preserves outer state identity. RED: older superseded timer produced a fresh outer object; GREEN after identity-preserving updater.
- react M3: fixed (`24581cf`); every RESET_FIELDS key must start dirty and equal its cleared default; every PRESERVED_FIELDS key retains its prior value. RED: omitting phase clear fails per-field assertion; GREEN restored.
- react M4: fixed (`24581cf`); non-shadowing host handles, imported pure policies/constants, asynchronous I/O seams retained. RED mutations: swapped image world coordinates, omitted import board commit, inverted shortcut zoom all fail paired tests; GREEN restored, including receiver checks.
- react M5: fixed (`24581cf`); descriptive controller exports, six no-op disposals removed, unused navigation disposal removed, root and visibility owner share timer cleanup. RED mutations: wrong timer cancellation and omitted selection mirror fail paired tests; GREEN restored. Navigation unmount test uses the same stored finalizer as root cleanup.
- react M6: fixed (`24581cf`); `topBarProps` runs through render-site builder after loading. RED: undo wired to redo fails command-identity assertion; GREEN restored. Hook-order guard also no longer treats this plain function as a hook.
- react M7: fixed (`24581cf`); Landing uses shared browser-zoom guard with its existing gesture behavior. RED: gesture-mode test failed before shared gesture support; GREEN after, including listener removal. Follow-up `8029036` repoints the pre-existing mobile-layout guard to both Landing wiring and the extracted owner; its exact viewport-content test fails on wrong metadata (RED) and passes restored (GREEN).
- react M8: fixed (`24581cf`); two-space formatting, wrapped signatures, spaced return handles. Paired controller tests GREEN after the behavioral mutations above; formatting-only RED not applicable.
- react M9: fixed (`24581cf`); recent-author comment identifies domain/pending-local-items.js; comment-only, RED not applicable.
- react M10: fixed (`24581cf`); three named viewport commits replace root flag dispatch; `e067c5b` explicitly asserts the preview port. RED: substituting commitViewport for previewViewport fails the pointer contract. GREEN restored (6/6 minimap tests), including pointer/keyboard/finalizer and host-receiver cases.

## Verification

Commits (in order): `a4c1a83`, `ef8092b`, `c68b089`, `784150f`, `24581cf`, `8029036`, `6d646cc`, `e067c5b`. Every commit uses `fix(review):`; no `.superpowers/` file is committed.

First full gate: one blocking `npm test -- --test-concurrency=4`, 2,978/2,979 passed; sole failure was the pre-existing mobile-layout source assertion that still looked for the moved viewport code inside Landing. It was repointed without dropping its metadata assertion (`8029036`); the 19-test mobile/zoom group passed, and wrong metadata was shown RED.

Full rerun: one blocking `npm test -- --test-concurrency=4`, exit 0, **2,979 tests passed, 0 failed, 0 skipped**, 152.6 seconds. The load-sensitive relay/deadline/capacity suites passed; no isolated load-sensitive failure required a rerun. Final test-only strengthening/cleanup also passed its targeted minimap (6/6) and hook/undo checks. Then `npm run build` exited 0, including prerendering.

Gate logs: `/var/folders/c7/9d0v8clj7tb2tvc7wndn75wh0000gn/T/retroboard-final-fix-tests.log` (initial RED), `/var/folders/c7/9d0v8clj7tb2tvc7wndn75wh0000gn/T/retroboard-final-fix-tests-green.log` (full GREEN), `/var/folders/c7/9d0v8clj7tb2tvc7wndn75wh0000gn/T/retroboard-final-fix-build.log`, `/var/folders/c7/9d0v8clj7tb2tvc7wndn75wh0000gn/T/retroboard-final-fix-layout.log` (19/19 GREEN). Standard pre-existing Node localStorage experimental warnings remain.

`git diff a7baeaf --check` passed. The tracked worktree is clean. Final ceilings only decreased: RetroBoard 2,895→2,877; storage bridge 295→289; relay stays 441. No protected infrastructure, credentials, environment files or deferred implementation areas were changed. Browser and image build/boot verification were deliberately not run.

## RULE CONFORMANCE

Code shape: PASS for this wave by targeted inspection; no new suppressions, cycles, duplicated format logic, or host receiver detachment. No Sonar analyzer run claimed; existing deferred findings remain listed above.
Tests: PASS — 2,979/2,979 full suite; targeted checks and RED/GREEN evidence listed per finding; no assertion weakening, skip/only or raised ratchet.
Logging and disk writes: N/A; no production sink changes.
Data location: PASS; gate logs use explicitly requested `$TMPDIR`; no captures/bulk data created.
Karpathy guidelines: PASS; authorized scope, preserved behavior except specified M11 base restoration, async I/O seams retained.
Repo style: PASS for touched code; relay extension rule restored; frozen ceilings lowered to measured sizes.
Failure-path tests: PASS — full suite and targeted failure propagation, denied writes/imports, timer cleanup and listener cleanup; image smoke remains explicitly unverified.
