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
### RULE CONFORMANCE

- Code shape: PASS.
- Tests: PASS.
- Logging and disk writes: N/A — no new sinks.
- Data location: PASS.
- Karpathy guidelines: PASS.
- repo style: PASS.
- failure-path tests: PASS.
- Task 1 commit: `9d37497`; full gate **2829/2829**, build PASS.

## Task 2 — S3 user-prefs

- Files: `bridge/user-prefs.{js,test.js}`, bridge, ratchet, report.
- Before move: bridge/contract plus new dual-write/blocked-cache and shared sync-wait tests **52/52** (`p3-before-2.log`). Same tests green after extraction (`p3-after-2.log`). Cache hit seeds Yjs, blocked storage retains durable recovery, system origin stays off undo, one wait serves concurrent reads and removes its listener. Receiver observations are asserted outside swallowed storage exceptions.
- RED: `user-prefs.js:110` at mutation time (now :115 after named ID constants), replaced durable `ymap.set` with `ymap.delete`; `user-prefs.test.js:26` failed `undefined !== 'Bob'` (`p3-red-2.log`). Restored.
- Ceiling: 1452 → 1348. ESLint complexity ≤15 and unused-variable checks PASS.
- Full gate: `p3-gate-2.log`; build PASS (`p3-build-2.log`).
### RULE CONFORMANCE

- Code shape: PASS.
- Tests: PASS.
- Logging and disk writes: N/A — no new sinks.
- Data location: PASS.
- Karpathy guidelines: PASS.
- repo style: PASS.
- failure-path tests: PASS.
- Task 2 commit: `8d95af8`; full gate **2831/2831**, build PASS.

## Task 3 — S4 awareness-presence

- Files: `bridge/awareness-presence.{js,test.js}`, bridge, ratchet, report.
- Before move: bridge/contract and awareness characterization **52/52** (`p3-before-3.log`). Tests pin 30-second freshness, independent per-connection busy ownership, text/geometry claim merging, singular text editing, and real Awareness slot removal on document destroy. Same tests green through the new module; a fake Awareness also exercises readers and writes (`p3-after-3.log`).
- Three readers remain distinct: editing accepts a nonempty overlong ID while busy/selection reject it. Only the identical editing/selection signature formatting is shared (`p3-presence-signatures.log`, 3/3).
- RED: `awareness-presence.js:34`, replace the text `slice(0, 1)` branch with all normalized IDs. Tests failed because busy state included extra `d` (`p3-red-3.log`). Restored.
- Ceiling: 1348 → 1130. Full gate: `p3-gate-3.log`; build PASS (`p3-build-3.log`). ESLint complexity ≤15 and unused-variable checks PASS. A transient extraction-range syntax error was corrected before the passing post-move test and before the full gate; it is not claimed as a mutation proof.
### RULE CONFORMANCE

- Code shape: PASS.
- Tests: PASS.
- Logging and disk writes: N/A — no new sinks.
- Data location: PASS.
- Karpathy guidelines: PASS.
- repo style: PASS.
- failure-path tests: PASS.
- Task 3 commit: `e3b3d5f`; full gate **2836/2836**, build PASS.

## Task 4 — S6 snapshot-doc

- Files: `bridge/snapshot-doc.{js,test.js}`, bridge, ratchet, report.
- Before move: unchanged bridge/contract plus snapshot characterization **52/52** (`p3-before-4.log`). Same assertions then pass on the new module using a bare Y.Doc: text becomes Y.Text, internal metadata stays hidden, exact repeated writes make no document change, invalid geometry does not write, null metadata deletes, only `local` origin enters undo.
- Additional legacy-migration test also passed against the unmoved source restored temporarily from task 3 (`p3-maintenance-before-4.log`), then passed after restoration of the extraction (`p3-after-4.log`, 3/3). Sync maintenance retains migration → geometry repair → collaborative text → templates order, with repeated work named once.
- RED: `snapshot-doc.js:41`, make equal fields compare unequal; idempotence assertion failed on changed encoded Yjs state (`p3-red-4.log`). Restored.
- Ceiling: 1130 → 869. New-module ESLint complexity ≤15 and unused-variable checks PASS. The old bridge importBundle complexity remains for its owning task 6.
- Full gate: `p3-gate-4.log`; build PASS (`p3-build-4.log`).
### RULE CONFORMANCE

- Code shape: PASS.
- Tests: PASS.
- Logging and disk writes: N/A — no new sinks.
- Data location: PASS.
- Karpathy guidelines: PASS.
- repo style: PASS.
- failure-path tests: PASS.
- Task 4 commit: `a57dba4`; full gate **2859/2859**, build PASS.

## Task 5 — S7 undo-controller

- Files: `bridge/undo-controller.{js,test.js}`, bridge, ratchet, report.
- Before move: unchanged bridge/contract plus rapid-command grouping and silent-state survival characterization **51/51** (`p3-before-5.log`). Same behavior passes after the extraction; the bare-document test also verifies the configured 500 ms capture window, change notifications and unsubscribe (`p3-after-5.log`, 2/2).
- `undoManager` remains declared before all observers and assigned only at its original late point. Root observers read that live binding rather than a copied value. No module points back to the bridge.
- RED: `undo-controller.js:3`, change `UNDO_CAPTURE_TIMEOUT_MS` from 500 to 0. The rapid-command test fails because undo leaves an item, and the configuration assertion fails `0 !== 500` (`p3-red-5.log`). Restored.
- Ceiling: 869 → 846. New-module ESLint complexity ≤15 and unused-variable checks PASS.
- Full gate: `p3-gate-5.log`; build PASS (`p3-build-5.log`).
### RULE CONFORMANCE

- Code shape: PASS.
- Tests: PASS.
- Logging and disk writes: N/A — no new sinks.
- Data location: PASS.
- Karpathy guidelines: PASS.
- repo style: PASS.
- failure-path tests: PASS.
- Task 5 commit: `8d57d14`; full gate **2864/2864**, build PASS.

## Task 6 — S2 import-plan and deferred key wiring

- Files: `bridge/import-plan.{js,test.js}`, bridge, ratchet, report.
- Before move: unchanged bridge/contract, import characterization and original key-schema fixtures **77/77** (`p3-before-6.log`). Each rejection has its own subtest and asserts unchanged canonical bytes. Valid intake is one local update; permit-order characterization verifies invalid input consumes no permit and valid input yields permit → transaction → nested permit.
- After move: import/key tests **27/27** (`p3-after-6.log`). Existing export → import → export exact-round-trip tests remain unchanged and are included in every full gate. Validation returns a plan only; outer transaction, related-key deletion and nested snapshot transaction remain in the bridge, in original order.
- The bridge now imports key constructors, prefixes and `parseStoredVoteKey`/`parseStoredCommentKey` from domain `vote-comment-keys.js`. The permissive legacy stored parser is retained; canonical-vote parsing remains separate. This finishes the P2 deferred bridge wiring.
- RED: `import-plan.js:41`, remove duplicate-vote rejection; “duplicate vote” fails `true !== false` at `import-plan.test.js:36` (`p3-red-6.log`). Later unchanged-state assertions also catch that mutant's document writes. Restored.
- Ceiling: 846 → 794. Planning is split into named item/vote/comment validators with the shared board-item validator; new-module ESLint complexity ≤15 and unused-variable checks PASS.
- Full gate: `p3-gate-6.log`; build PASS (`p3-build-6.log`).
### RULE CONFORMANCE

- Code shape: PASS.
- Tests: PASS.
- Logging and disk writes: N/A — no new sinks.
- Data location: PASS.
- Karpathy guidelines: PASS.
- repo style: PASS.
- failure-path tests: PASS.
- Task 6 commit: `6a891b8`; full gate **2864/2864**, build PASS.

## Task 7 — S8 method maps and contribution composition

- Files: `bridge/{board-methods,contribution-store,storage-access,room-methods}.{js,test.js}`, `bridge/fixtures/storage-keys.json`, bridge, ratchet, report.
- Before move: unchanged bridge/contract plus four module characterizations **54/54** (`p3-before-7.log`). Key insertion order was captured from **6a891b8** for board/public/landing/locked routes, then asserted passing before the move (`p3-keys-before-7.log`, 5/5). Expected fixture values were captured from unmoved method assembly, never generated from the extraction. Canonical sticky/vote/comment deletion assertions also passed against the unmoved source restored temporarily (`p3-contributions-before-7.log`).
- After move: all eight new cases pass (`p3-after-7.log`). The bridge composes maps in the original property order. The contribution store registers vote → comment → template → mood observers after the bridge's change-dispatch observer; board deep/meta observers remain registered in the bridge in original order. No root callbacks are passed to modules; modules consume lower-owned document/store handles.
- RED proofs, all restored before the gate:
  - `board-methods.js:64`: force metadata origin to `local`; silent admin metadata disappears on undo instead of remaining Alice (`p3-red-7-board-methods.log`).
  - `contribution-store.js:122`: retain the deleted Y.Item; canonical deletion assertion fails `true !== false` (`p3-red-7-contribution-store.log`).
  - `storage-access.js:50`: write null instead of the shared value; read returns null instead of own (`p3-red-7-storage-access.log`).
  - `room-methods.js:68`: invoke sync subscriber on false; assertion fails `1 !== 0` (`p3-red-7-room-methods.log`).
- Ceiling: 794 → 368. New modules and remaining bridge functions satisfy ESLint complexity ≤15 / unused-variable checks. Only an inherited unused no-console suppression remains in the old diagnostics block, removed when that block moves in task 8.
- Full gate: `p3-gate-7.log`; build PASS (`p3-build-7.log`).
### RULE CONFORMANCE

- Code shape: PASS.
- Tests: PASS.
- Logging and disk writes: N/A — no new sinks.
- Data location: PASS.
- Karpathy guidelines: PASS.
- repo style: PASS.
- failure-path tests: PASS.
- Task 7 commit: `4442266`; full gate **2870/2870**, build PASS.

## Task 8 — finish S8 services, diagnostics and ratchet audit

- Files: `bridge/{bridge-diagnostics,room-services}.{js,test.js}`, bridge, ratchet, report; formatting/interface cleanup in the P3-owned permit/prefs/presence/snapshot/undo modules and their tests.
- Before move: unchanged bridge/contract plus diagnostics/services characterization **52/52** (`p3-before-8.log`). Additional dead-relay recovery, exact 29,999/30,000 ms presence boundaries, and service lifecycle checks passed against the original **576e3bd** bridge (`p3-original-audit-before-8.log`), then against the extraction (`p3-after-8.log`, 8/8).
- The original development-only condition stays in the bridge so production builds can eliminate debug handles. Encryption attachment, diagnostics, previews, reactions and writing timer retain their original construction order. The root now defines `isUndoOrigin` before observers and still assigns `undoManager` late. The three awareness readers stay distinct. Only newly introduced unused snapshot-return helpers were removed; no public storage member changed.
- Receiver audit: host calls use their real objects or direct global calls; no injectable host function is stored on a foreign object. localStorage calls retain the Storage receiver. Timer test wrappers use Reflect.apply with globalThis. All imports in the new modules/tests are at the top. The old diagnostics suppression was removed instead of adding one to a new module.
- RED proofs, all restored:
  - `bridge-diagnostics.js:30`, hard-code item count to 0; `bridge-diagnostics.test.js:15` fails `0 !== 1`.
  - `room-services.js:31` after ownership review, publish null instead of the reaction channel; `room-services.test.js:9` fails the channel-presence assertion.
  - `user-prefs.js:111`, call localStorage.setItem through a foreign `{setItem}` receiver; `user-prefs.test.js:33` fails the receiver observations asserted outside the swallowed exceptions.
  - `storage-bridge.js:152`, make isUndoOrigin always false; unchanged `storage-bridge.test.js:732` fails `false !== true`.
  - Evidence: `p3-red-8-{bridge-diagnostics,room-services,user-prefs,storage-bridge}.log`; final service-map proof: `p3-red-8-room-services-final.log`.
- Restored targeted gate **203/203** (`p3-final-targeted-8.log`), covering the complete unchanged bridge/contract tests, all new module tests, architecture and ratchets. ESLint complexity ≤15 and unused-variable checks pass for **all** P3 modules/tests and the remaining bridge, without suppressions.
- Ownership re-review caught services writing to the assembled storage object. Before commit this was corrected: services return member maps, only the bridge assigns public members, and image repair consumes the lower-owned image-method port. No whole parent storage handle or parent callback is retained. Construction and public insertion order remain green. Targeted checks passed **98/98** for the ownership change (`p3-owner-review-8.log`); final snapshot/service/key/unchanged-bridge checks passed **52/52** (`p3-owner-restored-8.log`). Duplicate snapshot item seeding now calls the existing `seedItem`, and equivalent migration flag-only branches share one condition. The first final full gate had passed **2871/2871** before this ownership review; a fresh complete test/build gate was therefore required on the reviewed source.
- Ceiling: 368 → **295**. It was lowered to the measured count in every task, never raised in a commit. One uncommitted extraction-range error in task 3 briefly produced an invalid generated source/measurement; both generated artifacts were discarded before successful characterization/gating, and the committed ceiling sequence remained strictly decreasing.

## Final review and open concerns

The unchanged bridge tests and P0 surface/arity contract are preserved byte-for-byte from 576e3bd. RetroBoard.jsx and yjs-server.mjs are also unchanged. No dependency, workflow, deployment/security configuration, credential, environment file, production data, or other worktree was touched. No push, deploy or browser check was run.

No unresolved implementation finding, new import cycle or avoidable duplication remains in the owned modules. Stored vote/comment parser wiring deferred by P2 is finished. Equal signature formatting is shared, while the three presence readers keep their distinct behavior. Module composition uses lower-owned handles and method maps; no module imports or calls back into the bridge.

Verification owed:

- Live `ui-live-check`: two contexts, bidirectional edits, undo/redo, th/en rendering.
- `board-import-ui-live-check`: real UI export/import exact round trip.
- `room-lock-live-check`: locked-room behavior, including undo reset and services.
- Pinned **Node 24** verification: this machine has **Node 26.5.0**, as in the P2 report. All recorded gates ran on that available runtime. No dependency/runtime upgrade was performed.
- R-B release verification still requires P4 and the complete release gate plus owner-approved deployment. This report makes no live/production release claim.

### RULE CONFORMANCE

- Code shape: PASS — focused plain-JS owners, shared schemas/helpers, downward dependencies, complexity ≤15; no new suppressions or raised ceilings.
- Tests: PASS — original-source characterizations, restored RED proofs, unchanged existing assertions; final full-gate result recorded below.
- Logging and disk writes: PASS — original debug log format/frequency retained; no new sinks or durable-write changes.
- Data location: PASS — explicitly authorized session TMPDIR for disposable evidence; small committed fixtures are test inputs, not logs/captures/bulk data.
- Karpathy guidelines: PASS — P3-only scope, stated task-8 interpretation, measured ceiling and concrete checks; live/runtime limitations explicit.
- repo style: PASS — colocated tests, architecture and ratchets green; no user-visible strings or UI changes added.
- failure-path tests: PASS — blocked/corrupt cache, bounded timeout/listener cleanup, invalid geometry/imports, duplicate contributions, public rejection, destroy cleanup and native receiver coverage.

Reviewed-source final gate: **2871/2871**, zero failures/cancellations/skips/todos; `npm run build` PASS (`p3-gate-8-final.log`, `p3-build-8-final.log`). Static complexity/unused checks and unchanged-file comparisons also PASS. Task-8 commit SHA is finalized in the report-only commit after the task commit, avoiding a self-referential SHA.
