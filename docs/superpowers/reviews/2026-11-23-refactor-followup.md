# Refactor review follow-up, 23 November 2026

The owner selected the outstanding final-review findings for this round. The comparison starts at `cc2644c` on local `main`. React I2, the lifecycle of the extracted controller hooks, and re-review note N5, the hook-order fixture for the coupled owners, remain with P6.

| Finding | Resolution |
| --- | --- |
| Bridge M4 and M5 | The picker codes must match the eager dictionaries and lazy loaders. Each loader must resolve to its own locale. The two migration snapshot tests and their fixture were retired. Runtime fallback, interpolation, placeholder parity, nonempty translations and per-area assembly still have independent coverage. |
| Bridge M6 and relay M8 | The locale area split and the documentation pointing to the ratchets had already landed in `a665f8f` and `705ce38`. |
| Relay M9 | The test harness reserves the process-wide y-websocket persistence slot before opening an entrypoint. A second entrypoint is rejected until test teardown. Existing HTTP cases that opened multiple fixtures now give each fixture its own test lifetime. |
| Harness | The process lifecycle and its tests have a dedicated module. The step reporter preserves errors, prints PASS or FAIL immediately and returns successful action results. Poker now requires a PASS line. The spacing check uses the same reporter for its final assertion. |
| Browser console errors | Checks using `errorsStep` start the Public relay for the landing snapshot. They reject unexpected console errors. Manifest runs match the expected private relay origin, resource path and status for the fixture. Poker uses the same rule for its account probe. |
| Timeout verdicts | A child exiting successfully during timeout cleanup fails its attempt. A timeout also cannot stand in for a known failed assertion with no FAIL line. |
| Re-review N3, N4, N6 and N7 | Import positions, the storage producer prefix and the cited test formatting were corrected. The wait guard covers multiline inline predicates and locally declared named async callbacks in the live scripts and shared browser helper. |
| Bridge test follow-ups | The consumer scan distinguishes explicit board storage from the four modules using injected Web Storage. The arity contract covers the public, locked, plain and landing routes. The remote-update fixture uses canonical Yjs item fields and checks the boolean undo flag directly. |

## Verification

- Compared the final runtime against the retired fixture from Git. All 12,925 translations in 11 languages matched. Thai and English also preserved their captured key order.
- Removed the Vietnamese loader and then mapped it to the wrong dictionary in separate checks. Both changes failed the new picker test. An ordinary English wording edit passed the area tests.
- Reproduced the silent second relay entrypoint, the missed browser console error, the hidden explicit storage call and both timeout verdict errors before their fixes. A real child that printed PASS and exited zero on SIGTERM was subsequently judged a timeout regression.
- Changed the landing stub arity and removed the undo flag in separate scratch copies. Each mutation failed its targeted storage test.
- Node 24.20.0 passed all 3,002 unit tests. The application build, SEO prerender and maintainer build completed.
- Compared the changed JavaScript and JSX against the base with ESLint and the recommended SonarJS rules, including a cognitive complexity limit of 15. There were no additional diagnostics by rule, message and trimmed source line.

- All 22 live manifest entries passed on the final tree on their first attempt. The two-context UI check passed 19 steps, including English and Thai rendering, edits in both directions, and undo and redo in both contexts.
- The standalone UI check recorded 14 disabled-account 404 responses and 11 landing snapshot 502 responses in its fixture without a Public relay. It recorded zero page errors. The stricter board checks run with the Public relay and passed their console assertions.

Evidence is under `/Volumes/ssd-fluke/BaseData/retro-board/refactor-followup-20261123`. The final runs are `unit-final.log`, `build-final.log`, `maintainer-final.log`, `lint-committed.log` and `live-final/<check>/run-1/summary.json`.

## RULE CONFORMANCE

- Code shape — PASS. The changed files passed the differential SonarJS check, and the architecture tests cover dependency direction and cycles.
- Tests — PASS. Regression tests failed on the defects or targeted mutations and passed on the final tree.
- Logging and disk writes — PASS. The live runner keeps its existing per-run report files and emits a single console verdict per completed step in the updated scripts.
- Data location — PASS. Dependency caches, build output, browser captures and run logs stayed on the mounted task volume.
- Karpathy guidelines — PASS. The changes follow the deferred findings and the existing fixture and runner contracts.
- Repo style — PASS. The full suite includes file ceilings, i18n parity and both language renderings.
- Failure-path tests — PASS. Coverage includes overlapping relay fixtures, missing loaders, unexpected console errors, rejected steps and timeouts that exit zero.
