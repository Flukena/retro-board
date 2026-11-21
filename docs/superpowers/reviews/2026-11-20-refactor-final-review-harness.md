# Final review: live-check harness (scripts/), P0/P1 infra

Scope read: live-check-common.mjs (summarizeRun/judgeRun/runLiveCheck path), board-live-helpers.mjs (runLiveCheck, step), live-check-manifest.json, board-import-ui / pan / modal / spacing checks. Read-only; no browser runs. Reviewed tree: worktree at a7baeaf. Full diff (4954 lines) was not read line by line; findings come from targeted reads of the paths below.

## Critical

None.

## Important

### I1. Async `waitForFunction` predicates pass vacuously (confirms ledger items pan:144/:453, modal:446/458)
Evidence, Playwright source in /opt/homebrew/lib/node_modules/playwright/node_modules/playwright-core/lib/coreBundle.js:25704-25709: the poll loop does `const success = predicate(); if (success) { fulfill(success); return; }`. An `async` predicate returns a Promise, which is always truthy. The loop therefore stops after the first poll and never re-polls. `fulfill(promise)` then adopts the promise's value once, and a resolved `false` is returned as a successful wait. Net effect: `waitForFunction(async ...)` never waits and never fails.

- `scripts/pan-live-check.mjs:453-457` (`expectText`, called at :459, :461, :463): the check "edit, undo, redo through the native editor" asserts the item text after each step. A broken undo or redo still passes, because nothing is awaited or asserted. **Must fix before merge.** This is a live-check pass while the app is broken, on the INV undo/redo path.
- `scripts/pan-live-check.mjs:144-148` (`addChunk`): it is meant to wait until the chunk is present. It does not wait, so the fixture may be unsettled when measuring starts. Flake and wrong-measurement risk, not a false green. Fix together with :453.
- `scripts/modal-live-check.mjs:446` and `:458` (lock and unlock sync): no false green, because the next line asserts the effect (`textarea` count 0) or auto-waits (`added.dblclick()`). The failure mode is a flake or a race at :446-448: if the lock has not propagated yet, `dblclick` opens a textarea and the check fails spuriously. **Fix before merge**, since it is the same pattern and a one-line change.
- Suggested fix: use the shared `pollUntil(read, accept, msg)` (board-live-helpers.mjs:408), or a synchronous predicate over a value the page already holds. Another option is `expect.poll` semantics: `await pollUntil(() => page.evaluate(...), v => v === x, msg)`. Add a guard test or lint that rejects `waitForFunction(async` in `scripts/`; a one-line regex test is enough.

### I2. A run with zero PASS lines passes
`live-check-common.mjs:454-460` (`summarizeRun`): `passed = exitCode === 0 && failed.length === 0`. `passLines` is computed but nothing reads it (`grep passLines` shows only this definition). If a check exits 0 without running its steps (for example an early return, or a scenario that registers no steps), the runner judges it OK. The failure mode is silent coverage loss after a refactor. Suggested fix: add an optional `minPassSteps` per manifest entry, or fail any `pass`-baseline run with `passLines === 0`. This is low cost and needs a test with a no-step script. **Fix before merge, or record as an accepted risk.** It is not a regression today, since all 22 entries are green.

## Minor

- `scripts/board-import-ui-live-check.mjs:96` `chooser.catch(() => {});` is an empty catch handler. It violates the AGENTS.md "no broad catches" rule. It is harmless at runtime: the later `await chooser` re-throws, so a missing chooser still fails the step. Replace with `const [fileChooser] = await Promise.all([page.waitForEvent(...), openMenu(...)])`, which keeps the failure visible and removes the swallow. **Must fix: the ledger already ruled it into the final-review fix wave, and the fix is one line.**
- `scripts/pan-live-check.mjs:151` is the fifth copy of `step()` (also modal:52, mobile:111, poker:75, public-tools:57; ui-live-check.mjs:128 is a variant). Duplication under the Sonar-clean rule. **Can wait**, but a shared `consoleStep` in board-live-helpers.mjs would be the right home. Do it in the follow-up tidy; it only touches test scripts and risks nothing.
- `board-live-helpers.mjs` `errorsStep` fails only on `pageErrors`; console errors are counted but ignored (ledger task 1b.2/1b.3). Can wait. A real console error would still pass a check, but pageErrors catch uncaught exceptions such as the "Illegal invocation" regression class.
- Spacing single `failingStep`: **moot**. Every manifest entry now has `baseline: "pass"` (no known-red or flaky entries remain), so `judgeKnownRed` is unused in the shipped manifest. The logic is still covered by unit tests. No action.
- Commit split (live-check-common.mjs 4-concern file, ledger item T1-10): **can wait**. It is a style and size matter, not a correctness one.
- `spacing-live-check.mjs:256-257` prints `FAIL ...` then asserts (the same condition twice). Not a false green; exit code and FAIL line agree. Cosmetic.

## Deferred-minor triage (scripts/ items the brief listed)

| Item | Verdict |
|---|---|
| pan:144 / pan:453 async waitForFunction | MUST FIX (see I1; :453 is a false green) |
| modal:446 / modal:458 async waitForFunction | MUST FIX (flake risk, same one-line fix) |
| pan:151 fifth `step()` copy | Can wait |
| 1b.5 `chooser.catch(() => {})` | MUST FIX (ledger ruling, one line) |
| spacing single failingStep | Moot; no known-red entries remain |
| commit split / live-check-common.mjs size | Can wait |

## Other ways a check can pass while the app is broken

- The runner is fail-closed on exit code, FAIL lines and timeouts. That part is sound.
- Remaining risks: I1 (async predicates), I2 (zero steps), and the ledger note that only some steps have recorded mutation red proofs. This cannot be verified without browser runs, which the brief forbids.

## RULE CONFORMANCE

- Code shape: FAIL, the empty catch handler at board-import-ui-live-check.mjs:96 and the duplicated `step()` helper (pan:151 and four siblings).
- Tests: FAIL, pan `expectText` asserts nothing (vacuous), so the undo/redo live check cannot fail on a broken undo. No red proof is possible for it as written.
- Logging and disk writes: PASS, outputs go to a data-volume `out` dir through `prepareDataVolumeOutput`; report.json is written once.
- Data location: PASS (SSD_ROOT assertions in the spacing check; the data-volume helper in the others).
- Karpathy guidelines: PASS, scoped helpers; no speculative features found in the paths read.
- repo style: N/A for the scripts reviewed, apart from the duplication noted above.
- failure-path tests: PASS for the runner (`summarizeRun`, `judgeRun`, signal handling covered in live-check-common.test.mjs). Gap noted at I2: no test for a zero-step exit-0 run.
