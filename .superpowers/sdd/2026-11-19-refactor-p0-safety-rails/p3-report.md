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
- Task 1 commit: `9d37497`; full gate **2829/2829**, build PASS.

## Task 2 — S3 user-prefs

- Files: `bridge/user-prefs.{js,test.js}`, bridge, ratchet, report.
- Before move: bridge/contract plus new dual-write/blocked-cache and shared sync-wait tests **52/52** (`p3-before-2.log`). Same tests green after extraction (`p3-after-2.log`). Cache hit seeds Yjs, blocked storage retains durable recovery, system origin stays off undo, one wait serves concurrent reads and removes its listener. Receiver observations are asserted outside swallowed storage exceptions.
- RED: `user-prefs.js:110` at mutation time (now :115 after named ID constants), replaced durable `ymap.set` with `ymap.delete`; `user-prefs.test.js:26` failed `undefined !== 'Bob'` (`p3-red-2.log`). Restored.
- Ceiling: 1452 → 1348. ESLint complexity ≤15 and unused-variable checks PASS.
- Full gate: `p3-gate-2.log`; build PASS (`p3-build-2.log`).
- RULE CONFORMANCE: Code shape PASS; Tests PASS; Logging and disk writes N/A; Data location PASS; Karpathy guidelines PASS; repo style PASS; failure-path tests PASS.
- Task 2 commit: `8d95af8`; full gate **2831/2831**, build PASS.

## Task 3 — S4 awareness-presence

- Files: `bridge/awareness-presence.{js,test.js}`, bridge, ratchet, report.
- Before move: bridge/contract and awareness characterization **52/52** (`p3-before-3.log`). Tests pin 30-second freshness, independent per-connection busy ownership, text/geometry claim merging, singular text editing, and real Awareness slot removal on document destroy. Same tests green through the new module; a fake Awareness also exercises readers and writes (`p3-after-3.log`).
- Three readers remain distinct: editing accepts a nonempty overlong ID while busy/selection reject it. Only the identical editing/selection signature formatting is shared (`p3-presence-signatures.log`, 3/3).
- RED: `awareness-presence.js:34`, replace the text `slice(0, 1)` branch with all normalized IDs. Tests failed because busy state included extra `d` (`p3-red-3.log`). Restored.
- Ceiling: 1348 → 1130. Full gate: `p3-gate-3.log`; build PASS (`p3-build-3.log`). ESLint complexity ≤15 and unused-variable checks PASS. A transient extraction-range syntax error was corrected before the passing post-move test and before the full gate; it is not claimed as a mutation proof.
- RULE CONFORMANCE: Code shape PASS; Tests PASS; Logging and disk writes N/A; Data location PASS; Karpathy guidelines PASS; repo style PASS; failure-path tests PASS.
- Task 3 commit: `e3b3d5f`; full gate **2836/2836**, build PASS.

## Task 4 — S6 snapshot-doc

- Files: `bridge/snapshot-doc.{js,test.js}`, bridge, ratchet, report.
- Before move: unchanged bridge/contract plus snapshot characterization **52/52** (`p3-before-4.log`). Same assertions then pass on the new module using a bare Y.Doc: text becomes Y.Text, internal metadata stays hidden, exact repeated writes make no document change, invalid geometry does not write, null metadata deletes, only `local` origin enters undo.
- Additional legacy-migration test also passed against the unmoved source restored temporarily from task 3 (`p3-maintenance-before-4.log`), then passed after restoration of the extraction (`p3-after-4.log`, 3/3). Sync maintenance retains migration → geometry repair → collaborative text → templates order, with repeated work named once.
- RED: `snapshot-doc.js:41`, make equal fields compare unequal; idempotence assertion failed on changed encoded Yjs state (`p3-red-4.log`). Restored.
- Ceiling: 1130 → 869. New-module ESLint complexity ≤15 and unused-variable checks PASS. The old bridge importBundle complexity remains for its owning task 6.
- Full gate: `p3-gate-4.log`; build PASS (`p3-build-4.log`).
- RULE CONFORMANCE: Code shape PASS; Tests PASS; Logging and disk writes N/A; Data location PASS; Karpathy guidelines PASS; repo style PASS; failure-path tests PASS.
- Task 4 commit: `a57dba4`; full gate **2859/2859**, build PASS.

## Task 5 — S7 undo-controller

- Files: `bridge/undo-controller.{js,test.js}`, bridge, ratchet, report.
- Before move: unchanged bridge/contract plus rapid-command grouping and silent-state survival characterization **51/51** (`p3-before-5.log`). Same behavior passes after the extraction; the bare-document test also verifies the configured 500 ms capture window, change notifications and unsubscribe (`p3-after-5.log`, 2/2).
- `undoManager` remains declared before all observers and assigned only at its original late point. Root observers read that live binding rather than a copied value. No module points back to the bridge.
- RED: `undo-controller.js:3`, change `UNDO_CAPTURE_TIMEOUT_MS` from 500 to 0. The rapid-command test fails because undo leaves an item, and the configuration assertion fails `0 !== 500` (`p3-red-5.log`). Restored.
- Ceiling: 869 → 846. New-module ESLint complexity ≤15 and unused-variable checks PASS.
- Full gate: `p3-gate-5.log`; build PASS (`p3-build-5.log`).
- RULE CONFORMANCE: Code shape PASS; Tests PASS; Logging and disk writes N/A; Data location PASS; Karpathy guidelines PASS; repo style PASS; failure-path tests PASS.
