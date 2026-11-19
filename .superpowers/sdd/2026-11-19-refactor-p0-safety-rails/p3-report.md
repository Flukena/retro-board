# P3 storage-bridge decomposition

Baseline: `576e3bd`, branch `refactor/codebase`. No CodeGraph index exists.
Task 8 is interpreted conservatively as the final composition/ratchet audit after the seven seams listed in the P3 table. Each task retains the singleton and lowers the measured ceiling. Existing bridge tests are not edited. Logs are small throwaway gate evidence under the session `$TMPDIR`, explicitly authorized by the task.

Browser checks are intentionally not run, as requested. Owed before release: `ui-live-check` undo/redo in two contexts (including bidirectional sync and th/en), `board-import-ui` export/import exact round trip, and `room-lock`. P3 alone does not satisfy the R-B release gate.

## Task 1 — S1 public-permit

- Files: `src/client/session/bridge/public-permit.{js,test.js}`, bridge, ratchet.
- Characterization against unmoved bridge: 51/51 bridge+contract+new test passing (`p3-before-1.log`). Rejection is consumable once, expires at the next microtask, and remains false after consumption. Same test passes through the extracted module (`p3-after-1.log`).
- RED proof: `public-permit.js:7`, changed `publicCreationFailure = true` to `false`; `public-permit.test.js:10` failed `false !== true` (`p3-red-1.log`). Restored before gate.
- Ceiling: 1469 → 1452.
- Full gate: see `p3-gate-1.log`; build passed (`p3-build-1.log`).
- RULE CONFORMANCE: Code shape PASS; Tests PASS; Logging and disk writes N/A (no new sinks); Data location PASS; Karpathy guidelines PASS; repo style PASS; failure-path tests PASS.
