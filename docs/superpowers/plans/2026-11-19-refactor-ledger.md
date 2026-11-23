# SDD ledger — plan: /Users/sakontheerasuwanajak/Documents/miro-wt-refactor/docs/superpowers/plans/2026-11-19-refactor-p0-safety-rails.md

Spec: docs/superpowers/specs/2026-11-19-codebase-refactor-design.md (binding). Branch refactor/codebase, worktree /Users/sakontheerasuwanajak/Documents/miro-wt-refactor. Plan commit 8a5c89f. Live outputs /Volumes/ssd-fluke/BaseData/retro-board/refactor-p0-20261119/<task>/.
Plan written by workflow wf_38d021c3-4bd (writer, 2 critics, patch; 0 rejected).

## Rulings
- Ruling (O1): owner question "locked variants not baselined" -> add board-reactions-locked and writing-timer-locked to the manifest (task 1, 17 existing + 5 new = 22) — P3 touches the E2E path and the recipe already worked on 5493a90 (main-live timer-locked 14/14) — if wrong, two extra manifest entries to drop.
- Ruling (O2): landing/modal publicRelay — a recipe change found in task 2 is a setup fix recorded in `reason`, not a check edit — as the plan already says.
- Ruling (L1): task 2 cannot run the whole suite in one Bash call (10 min cap): run the runner per entry (`--only <id>`) or small groups, each call under 600000 ms — the plan's one-command form exceeds the tool limit.
- Ruling (M1): models — opus for tasks 1, 1b.1, 3, 5 (capable); sonnet for 1b.2-1b.5, 2, 4, 6, 7, 8a-8c, 9; reviewers sonnet, opus for tasks 1, 3, 5.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| 1 -> 1b.1..1b.5 | board-live-helpers: boardItems, itemById, boxCenter, withinPx, stickyBox, dragBy | names consistent; 1b.x only consume |
| 1 -> 1b.x, 2, 9 | manifest file: 1 skeleton (17 unrun), 1b.x add one entry each, 2 fills baselines + requireRun test, 9 adds atEnd | sequential, consistent |
| 1 -> 1b.x | scripts/README.md entries | each task adds its own row; no overlap |
| 1 -> 2 | live-check-common.test.mjs: 2 adds manifest tests | consistent |
| 3 -> 4, 5 | bridge-harness withStorage/VALID_ITEM | 4/5 consume withStorage; task 5 installs spy before withStorage loads bridge — fine |
| 3, 4, 5 | storage-bridge.test.js modified by all three | sequential edits, no conflict |
| 6 -> 7 -> 9 | rule-ratchets.test.js: 6 adds entries + countLines; 7 lowers RETRO_BOARD_MAX_LINES; 9 reads ceilings | consistent |
| 2 before 7, 8 | baseline before production edits | enforced by strict order |
| 7 vs 8c | RetroBoard.jsx: 7 edits, 8c must not | consistent |
| Task 1 | tests vs interfaces | self-consistent (15 checks text + ruling O1 makes 17) |
| Task 1b.1-1b.5 | each break uses lines verified by critic (2322/2338/3168/459/1137/2500) | self-consistent; re-grep at run time |
| Task 2 | "one command" vs 10-min tool cap | Ruling L1 |
| Task 3 | harness exports incl. LOCKED_EPOCH, ROOM_KEY_CHANGED_EVENT | self-consistent after patch |
| Task 6 | I18N_MAX_LINES 2506 measured | matches wc -l today |
| Task 8a-8c | rg re-verify per name, skip on failure | self-consistent |
| Task 9 | patch only, never commit AGENTS.md | self-consistent |

## Execution
- Task 1: dispatched (implementer p0-task1, opus), BASE 8a5c89f, brief task-1-brief.md, report task-1-report.md
- Task 1: NEEDS_CONTEXT (7 brief-vs-code questions) answered:
  - Ruling (T1-1): writing-timer-locked relayEnv {} (script header :8-9: B clock +2 min vs 60 s TTL); board-reactions-locked keeps TTL 60 — plan step 6 overstated the room-lock recipe — if wrong, timer-locked fails on reopen.
  - Ruling (T1-2): manifest `oidcInCheck: true` for room-management (it starts its own fake OIDC, :887) — avoids EADDRINUSE.
  - Ruling (T1-3): judgeRun decides on passed = exitCode===0; known-red with null failedStep is ok only if recorded failingStep is null — scripts without `FAIL <step>` lines (mobile, modal, public-tools, landing, spacing, ui).
  - Ruling (T1-4..7): runner refuses off-volume --out-root (test); serverPlan 4th arg {maintainerKey} + pure checkEnv; IPv6 skip (one named reason) on 3 tests; viteHost/args/timeoutSec per implementer's list.
- HOLD: production bug workflow wf_00fa4fdd-325 (export/CSV import) owns the only Chromium slot until it finishes; do not dispatch Chromium tasks (1b.x, 2) before then.
- 2026-11-19T06:52:36Z Chromium HOLD for tasks 1b.x/2 moves to the image-fix workflow (fix/retired-origin-images); release when it reports.
- 2026-11-19 p0-task1 NEEDS_CONTEXT (defaults implemented, uncommitted): Q1-Q7 re-asked; answered = T1-1..7 as recorded.
  - Ruling (T1-D): approve all 6 deviations (vite.js direct launch; perl alarm timeoutSec+10; dragBy releases on throw; unrun judged strictly; runtime ENV-SKIP exits 1; Chromium own process group accepted, no new machinery) — each is stricter or equal to the brief — if wrong, task 2 sees orphan Chromium; task 2 brief must add an orphan-Chromium check after each runner call.
  - Told to run the full gate once and commit; no Chromium (held by the image-fix workflow).
- 2026-11-19 p0-task1 DONE_WITH_CONCERNS: f33b74b; gate 2599/2599 + build; EPERM group-signal race found and fixed (0/40). Review package review-8a5c89f..f33b74b.diff; task reviewer p0-task1-review (opus) dispatched -> task-1-review.md.
  - Carry to task 2: record known-red for scripts with no `FAIL <step>` as failingStep null; check for orphan Chromium after each runner call (esp. timed-out runs); `account` recipe needs dist-maintainer/.
  - Ruling (T1-3b): `passed` = exitCode===0 AND no FAIL line (ledger wording, fail-closed); committed f33b74b has exitCode===0 only. Apply in the task-1 fix round with a test (exit 0 + FAIL line -> not passed) — a check that exits 0 yet prints FAIL must not count as green — if wrong, one extra strict condition no current check triggers.
- Task 1 review (task-1-review.md): spec compliant; quality Needs fixes — 2 Important (SIGALRM not handled; perl via PATH, plan-mandated), 15 Minor. Trailers checked present on f33b74b.
  - Ruling (T1-4b): perl via absolute PERL_PATH '/usr/bin/perl', missing-perl test injects a path — plan's PATH-emptying test traded for no S4036 hotspot — if wrong, a host without /usr/bin/perl fails loudly with the same missing-perl message.
  - Ruling (T1-6b): Minor #6 (broad catch in IPv6 probe and pidFrom) enters fix round 1 — AGENTS.md hard rule "no broad catches" — cost: 2 narrowed catches.
  - Ruling (T1-L2): timeoutSec 900 > 600 s Bash cap — task 2 runs each runner call with Bash run_in_background and reads the output file on notification (no tool cut-off orphaning servers) — supersedes L1's "each call under 600000 ms".
  - Note: gate ran on Node v26.5.0; CI is Node 24 — final review / CI run must confirm on Node 24.
  - Task 1: minor (deferred): #2 per-attempt summary.json `judged` misleading; #3 group SIGKILL after close + stop() grandchild untested; #4 start-up error lost if stop() rejects; #5 resolve on 'exit' not 'close'; #7 killLeftovers pid-reuse risk; #8 stickyBox waits 30 s on absent sticky; #9 fake mouse ignores args; #10 live-check-common.mjs 479 lines, 4 concerns (split process lifecycle); #11 parseManifest accepts unknown keys; #12 failingStep null known-red matches timeouts too; plus #13-15 in task-1-review.md.
  - Task 1: fix round 1/5 dispatched to p0-task1 (SIGALRM, PERL_PATH, passed rule T1-3b, narrow catches).
  - Carry to task 2 / final review: Linux CI (ubuntu) not exercised — grandchild/stop() tests rely on zombie reaping (kill(-pgid,0) succeeds on a zombie); ::1 tests need IPv6 loopback. Check host port 1235 free before publicRelay entries (prod yjs-public is containerised).
  - Task 1: fix round 1/5 implemented c923049 (39/39 covering tests; 4 revert checks red, fix 4 N/A — no test reaches those helper catches). Scoped re-review dispatched to p0-task1-review -> task-1-rereview-1.md.
- Task 1: fix round 1/5 (4 addressed, 0 open; commits f33b74b..c923049). Re-review task-1-rereview-1.md. Closing gate (controller): 2602/2602, build 0.
- Task 1: complete (commits 8a5c89f..c923049, review clean after 1 round; minors deferred above). Out-of-scope note: signal tests' stand-in wires abort to stop() itself — real runCheck cleanup path proven only in task 2.
- 2026-11-19T07:40:52Z Chromium HOLD released to refactor. Task 1b.1 dispatched (p0-task1b1, opus, BASE c923049); it owns the Chromium slot. A pending APNG export fix (owner decision) does code+tests first and runs its browser check after 1b.1. p0-task1 and p0-task1-review stopped (finished).
- 2026-11-19 Owner: "ทยอยทำต่อให้เสร็จไวๆ".
  - Ruling (LANE): split into two lanes. Lane A, Chromium and sequential, in miro-wt-refactor on refactor/codebase: 1b.1..1b.5 then 2. Lane B, no browser and sequential, in miro-wt-refactor-b on refactor/p0-unit from c923049: 3, 4, 5, 6, 7, 8a, 8b+8c (batched, same shape). Lane B merges into refactor/codebase before task 9. — Why: tasks 3-8c touch src/ and their tests, lane A touches scripts/, and the pre-flight shows no shared files. — Cost if wrong: merge conflicts, or an 8b/8c un-export that a lane-A script imports; the merge gate catches it.
  - Lane B defers the live smokes of tasks 7 and 8b (orchestrator tier, they need task 2 baselines) to the controller after task 2 and the merge.
  - Lane B runs as workflows. A fix round there is a fresh implementer carrying the brief, the report and the findings (the harness cannot resume workflow agents).
  - Before refactor/codebase ever merges to main: merge main (by then holding the production fixes: RETIRED_APP_ORIGINS, mood resultShownAt, still-image export) and re-run 8b/8c's rg checks. 8b lists GIF_MAX_DIMENSION/GIF_MAX_PIXELS, and the still-image fix may import them.
- 2026-11-19T08:27:56Z Lane B workflow wf_ee68280e-15f started: tasks 3 (opus/opus), 4 (sonnet/sonnet), 5 (opus/opus) on refactor/p0-unit from c923049; reports task-{3,4,5}-report.md, reviews task-{3,4,5}-review.md. Next lane-B batch: 6, 7, 8a, 8b+8c.
- Task 1b.1: DONE_WITH_CONCERNS 1570b84 (gate 2602/2602; clean 7/7 x2 + committed-bytes OK; brief break red on step 2 with BETA_TYPING 72; isUndoRedo-forced-false red on step 5). Clean-1 failure was a check bug: creation and drag within the UndoManager 500 ms captureTimeout merge into one undo step (check now waits 1 s).
  - Owner-facing info (not a regression): in the app, a drag within 500 ms of creating or editing a card merges into the same undo step.
  - Concerns for review: INV-5 detection is not guaranteed per run (needs A steps faster than the 60 ms flush); a latent false red if B's typing lags by more than 0.5 s; INV-7 not shown red (its mutation is in RetroBoard.jsx); a foreign Chromium (explore2.cjs) overlapped once.
- Task 1b.1 review (task-1b.1-review.md): spec ✅; Needs fixes — 2 Important.
  - Important 1: INV-5 detection is probabilistic.
  - Important 2: latent false red from B's typing lag.
  - Ruling (T1b1-1): keep the plan-mandated per-step sampler and add an in-page rAF recorder; 3 recorded red runs required, all red — the sampler alone can let a broken build pass — cost: one more page-side recorder.
  - Task 1b.1: minor (deferred): pollUntil/caretAtEndOfEditor duplicate room-lock/mobile helpers; stickySelector repeats the data-sticky-id selector; a failed Promise.all leaves B typing; INV-7 not shown red here (owned by 1b.3).
  - Task 1b.1: fix round 1/5 dispatched to p0-task1b1 (rAF recorder + 3 red runs; typing barrier + harness-timing assert). It waits for the Chromium slot (the production stills check holds it).
- 2026-11-19T08:55:51Z Production now runs release/20261119c 83a7892 (web): retired-origin image fix, mood result on demand, legacy image export stills. Local main fast-forwarded to 83a7892 (not pushed). Before refactor/codebase merges anywhere: merge main into it and re-run the 8b/8c rg checks (GIF_MAX_*, RETIRED_APP_ORIGINS, isDecodeSafeLegacyImage).
- Task 1b.1 fix round 1 implemented, 4913543. The brief's break went red 3/3; the rAF recorder alone also catches the break (44/238 frames backwards); clean runs 4/4; gate 2602/2602.
  - Ruling (T1b1-2): ratify SAMPLE_INTERVAL_MS 55 (the brief said 25). At 25 ms every step fell inside the 60 ms flush and exposure was 1/72; at 55 ms it is 51-63/72 and the break is red 3/3. The spec intent (detect INV-5) outranks the plan's value. Cost if wrong: the check runs about 2x slower per step.
  - Ruling (T1b1-3): accept the narrow timing headroom (steps must stay at 80-140 ms). Out of band, the check fails loudly as a harness-timing red, which is fail-closed. Cost if wrong: occasional false reds under heavy load; task 2 records the rate.
  - Task 1b.1: minor (deferred): step 2's name still says "while B drags", but with the barrier B's drag ends before A's hold (only the typing overlaps). The harness-timing asserts have never been seen failing.
  - Scoped re-review dispatched to p0-task1b1-review -> task-1b.1-rereview-1.md.
- Lane B, workflow wf_ee68280e-15f (tasks 3-5): finished with 0 fix rounds.
  - Task 3: complete (commits c923049..2fcfbc2, review clean; opus impl and review; gate 2609/2609).
  - Task 3: minor (deferred): bridge-harness.js:41 repeats the board code and token from BOARD_URL ('TEST', 'Abcdefgh12345678').
  - Task 3: minor (deferred), plan-mandated: bridge-harness.js:23 exports unlockLockedRoom, but nothing imports it.
  - Task 3: minor (deferred): storage-contract.test.js:21 filters NOT_STORAGE_MEMBERS by name everywhere, so a stray window.storage.getItem would be hidden.
  - Task 3: minor (deferred): storage-contract.test.js:157 pins arity only on the plain board route.
  - Ruling (T3-D5): clearVotesForItems and editComment have no consumers. They stay frozen through P0 and are listed as dead-code candidates for P3 (storage-bridge decomposition) — removing them changes the frozen surface the design pins — cost if wrong: two dead members survive until P3.
  - Task 4: complete (commits 2fcfbc2..324841a, review clean; gate 2613/2613).
  - Task 4: minor (deferred): only the undo/redo test has a recorded mutation red proof.
  - Task 4: minor (deferred): storage-bridge.test.js:757 builds the peer item with `id: undefined`, and Boolean() hides null/undefined flags.
  - Task 5: complete (commits 324841a..3036dc5, review clean; opus; gate 2616/2616).
  - Task 5: minor (deferred), plan-mandated: test 3 pins registration order, not notification order. Yjs runs shallow observers before deep ones, so it is a refactor tripwire.
  - Ruling (T5-1): keep test 3 as a tripwire. A P3 task that moves the observer registrations must update it deliberately and say so in its report — the brief mandates it — cost if wrong: one test edit in P3.
  - Task 5: minor (deferred): the kvProbeEntries JSDoc wrongly says u| is the only kind forwarded (s| keys are forwarded too); the vote key template is copied from the task 4 test; BRIDGE_FRAME depends on the V8 stack layout and has only been seen on Node 26.5.
  - Cross-cutting: all lane-B gates ran on Node 26.5. The final review must re-run on Node 24 (CI).
- Task 1b.1: fix round 1/5 implemented (1570b84..4913543). The re-review is with p0-task1b1-review. The fix report has the commands, the red 3/3 and clean 4/4 table, and gate 2602/2602.
- Ultracode is OFF from here. The lane-B batch (6, 7, 8a, 8b+8c) continues as sequential Agent dispatches, not a Workflow.
- Lane B: merged main 83a7892 into refactor/p0-unit at c3dd01e (no conflicts). Gate 2645/2645, build ok.
  - Ruling (LANE-MAIN): merge production main into lane B before task 6. The merge adds 4 i18n lines, and the 8b/8c scans must see the deployed exports — merging after task 6 would push i18n.js over its new ceiling — cost if wrong: one merge commit on a local branch.
  - Lane A (refactor/codebase) picks main up when lane B merges into it before task 9.
- Task 6: dispatched to p0-task6 (sonnet), BASE c3dd01e. The brief's I18N_MAX_LINES 2506 is stale (main added 4 lines); told to re-measure.
- Task 1b.1: fix round 1/5 (2 addressed, 0 open — INV-5 rAF recorder plus 3/3 red runs; typing barrier plus harness-timing asserts; commits 1570b84..4913543).
- Task 1b.1: minor (deferred): step 2's name says "B drags", but only B's typing overlaps A's drag.
- Task 1b.1: minor (deferred): the recorder's listener and rAF loop are left running if step 2 throws before stop() (harmless, the page is discarded).
- Task 1b.1: minor (deferred): the two timing asserts have never been seen failing.
- Task 1b.1: minor (deferred): adds the test-only global window.__boardDragPeerRecorder.
- Task 1b.1: complete (commits c923049..4913543, review clean after 1 fix round)
- Task 1b.2: dispatched to p0-task1b2 (sonnet), BASE 4913543. It carries the 1b.1 lessons: 1 s gaps around undo for the 500 ms captureTimeout; break red first; slot-wait wrappers in the scratchpad (p0-live-run.sh / p0-live-show.sh). p0-task1b1 and p0-task1b1-review were stopped (work finished).
- Task 6: complete (commits c3dd01e..76c2934, review clean). Measured STORAGE_BRIDGE_MAX_LINES 1469 and I18N_MAX_LINES 2510 (the brief's 2506 was stale after the main merge); locales are 1178 lines. Gate 2649/2649.
- Task 6: minor (deferred): the guard test title says "above the unceilinged limit", where the brief wrote "above 1250 lines".
- Task 6: minor (deferred), plan-mandated: oversizeWithoutCeiling is exported but used only in its own file.
- Ruling (T6-trailer): the "Claude Opus 5.5" Co-Authored-By trailer is the session's required attribution line for every commit, whichever subagent model wrote it — the harness attribution rule — cost if wrong: none.
- Task 7: dispatched to p0-task7 (sonnet), BASE 76c2934. The ui live smoke is deferred to the controller, to run after lane A's task 2 or in a free slot.
- Task 7: complete (commits 76c2934..0ca0c5e, review clean). RetroBoard.jsx went from 3993 to 3983 lines, with the ceiling lowered to 3983. Gate 2649/2649. Pending: the controller still owes the `--only ui` live smoke.
- Task 7: minor (deferred): the report has no "before" test count, and its rg proof is prose rather than raw output.
- Ruling (T8-BATCH): 8a, 8b and 8c go to one implementer (p0-task8, sonnet) as three commits, with one reviewer giving a verdict per task — all three are small dead-code edits proved by rg and the build (batching.md) — cost if wrong: a larger single review diff. BASE 0ca0c5e.
- Deferred live smokes owed by the controller: 7 (ui), 8b (room-lock, room-management), 8c (ui, landing, room-lock). Run them once after lane B merges into lane A, together with task 2.
- Task 1b.2: DONE_WITH_CONCERNS d2eb745 (gate 2602/2602; clean 4/4 plus committed-bytes OK; brief break red 1/1 at step 1). Deviations: step 7 uses the nw handle; step 5 asserts the cap exactly (=== 1200); step 6 asserts the selection; pollUntil moved to board-live-helpers. Review dispatched.
- Task 1b.2: complete (commits 4913543..d2eb745, review clean).
- Task 1b.2: minor (deferred): steps 3-7 had no mutation run (the reviewer judged each assertion would catch a plausible regression); only the sticky cap is exercised (not the zone cap or zone minimum); the lock check covers zones only.
- Task 1b.2: minor (deferred): errorsStep in the shared helper fails only on pageErrors. The 4 environmental console errors (404 /api/account, 502 /yjs-public/api/snapshot) are counted but ignored, so a real console error would also go unnoticed.
- Task 1b.2: minor (deferred): 1b.1 keeps its own pollUntil copy; the helper now exports one.
- Task 1b.3: dispatched to p0-task1b3 (sonnet), BASE d2eb745.
- Tasks 8a/8b/8c: DONE_WITH_CONCERNS d1d3589, b6767dd, e8c57f3. 8b un-exported 45 of 47 (GIF_MAX_DIMENSION and TEMPLATE_PREFIX skipped: test importers). 8c un-exported 46 of 46. Concern: 8 names sit in modules with namespace or dynamic imports but were un-exported anyway, against the brief's skip rule. Review dispatched.
- Tasks 8a/8b/8c: complete (commits 0ca0c5e..e8c57f3, review clean; 8a d1d3589, 8b b6767dd, 8c e8c57f3). 91 names un-exported. Gates 2649/2649, plus build and maintainer:build.
  - Ruling (T8-NS): accept that 8 names were un-exported in modules that have namespace imports, against the brief's skip rule: LEGACY_TEMPLATE_KEY, MINIMAP_ZOOM_GAP_PX, TOAST_DOCK_GAP_PX, ZOOM_CONTROLS_H_PX, POKER_ORIGIN, validateLockedResponse, validateLockGrant, DOCK_TILE_NAME. Why: the spec's intent is to remove dead exports safely; the reviewer independently confirmed that no namespace property, computed or Object.keys access reaches any of them; and the skip rule exists only as a proxy for that safety. Cost if wrong: one re-export, which the task 2 live baseline would surface.
  - Tasks 8: minor (deferred): GIF_MAX_PIXELS could have stayed un-exported (it was un-exported correctly); the namespace-deviation reason lives only in the report, not in the commit body; yjs-server.resilience.test.mjs injects relay-* exports through a regex-built specifier, which the import scan cannot see (safe here); there is no per-name table (the reviewer rebuilt it: all clean).
- Lane B done: tasks 3, 4, 5, 6, 7, 8a, 8b, 8c on refactor/p0-unit (c923049..e8c57f3, plus the main merge c3dd01e).
  - Ruling (LANE-MERGE): merge refactor/p0-unit into refactor/codebase only after lane A finishes 1b.5. Then task 2 records the baseline on the merged tree, so its full run also covers the deferred smokes for 7 (ui), 8b (room-lock, room-management) and 8c (ui, landing, room-lock). Why: merging now would shift RetroBoard.jsx line numbers under the live 1b.3 agent. Cost if wrong: the merge is slightly later.
- Task 9: steps 1-3 (doc patch) dispatched to p0-task9 (sonnet) on lane B, BASE e8c57f3. Step 4 (atEnd unit-test baseline) is held for the controller until after LANE-MERGE and task 2. The patch then goes to the owner for approval (STOP).
- Task 1b.3: DONE b125efe (gate 2602/2602; clean 3/3; break a red at step 2; break b red at step 4 with steps 2-3 green). Deviation: the unlock button is found by its accessible label, because its title reads 'Editing locked' while locked. Review dispatched.
- Task 1b.3: complete (commits d2eb745..b125efe, review clean).
- Task 1b.3: minor (deferred): step 5 would miss a late removal after the toast. waitForTextOn 'visible' resolves immediately; a bounded boardItems poll on both pages would fix it.
- Task 1b.3: minor (deferred): whileHeld could become a shared helper.
- Task 1b.3: minor (deferred): step 6 does not prove the undo came from B's stack.
- Task 1b.3: minor (deferred): consoleErrors are not asserted (same as the sibling checks).
- Task 1b.4: dispatched to p0-task1b4 (sonnet), BASE b125efe.
- Task 9 steps 1-3: DONE 26eb56a. Patch docs/superpowers/plans/2026-11-19-p0-doc-corrections.patch; apply --check passes in the worktree and in the main checkout (read-only); tests 2649/2649. Review dispatched (p0-task9-review).
- Task 9 review: Needs fixes, with 2 Important findings on the AGENTS.md bullet. (1) It contradicts the th/en rule now that i18n.js sits at its ceiling. (2) The ceilings sentence is duplicated and the generic guard is missing. ARCHITECTURE.md was approved.
  - Ruling (T9-1): replace the bullet with merged wording. It names all four frozen files, says "never grow past ceilings, add no logic", keeps "only wire" for the two coordinators, and gives a single ceilings sentence that includes the shared-limit guard. The th/en sentence stays untouched, per the brief. Cost if wrong: one more wording round.
  - Ruling (I18N-SEQ), owner-facing: the i18n.js ceiling equals the current size, so any new UI string fails the ratchet until P2 task 1 (U1) splits th/en into locale files. Every future main→refactor merge that adds keys would also need a raised ceiling, which AGENTS.md forbids. Plan: P2 task 1 (U1) is the next task after P0, and the refactor branch does not merge into main, nor take further main merges with new keys, before U1 lands. Tell the owner, because their feature work (e.g. feat/retro-outcomes) adds keys. Cost if wrong: a merge is delayed until U1.
- Task 9: fix round 1 sent to p0-task9 (resumed).
- Task 9 steps 1-3: fix round 1/5 (2 addressed, 0 open; commits 26eb56a..bee8308). Complete (commits e8c57f3..bee8308, review clean after 1 round). Minor (deferred): the ARCHITECTURE.md line wrap runs a little long.
  - The patch is ready for owner approval: docs/superpowers/plans/2026-11-19-p0-doc-corrections.patch on refactor/p0-unit. STOP point: the owner approves, and then it is applied.
  - Step 4 (atEnd baseline) is still pending: it runs after LANE-MERGE and task 2.
- Task 1b.4: DONE_WITH_CONCERNS 6fb41eb (gate 2602/2602; clean 3/3; clear-on-leave 8/123/111 ms against the 45000 ms bound; break red at step 3). Shared helpers changed: pollUntil gained timeoutMs; init script skips rb_lang on opaque origins. Review dispatched.
- Task 1b.4: complete (commits b125efe..6fb41eb, review clean).
- Task 1b.4: minor (deferred), plan-mandated: about:blank is a clean leave (cleared in 8-123 ms), so the PLAYER_PRESENCE_STALE_MS timeout path is never exercised.
  - Ruling (T1b4-1): keep the brief's clean leave and fix the header/README wording to "clean leave" in the final-review fix wave. A non-clean leave (setOffline plus context close) is a P5 candidate. Why: the brief mandates about:blank, and the stale path has unit coverage in awareness-liveness. Cost if wrong: a crash-leave regression is caught only by unit tests.
- Task 1b.4: minor (deferred): step 6's selection/editing "gone" checks are vacuous at the moment of leaving (steps 3-4 cover them); pollUntil's timeoutMs and the opaque-origin init guard have no helper tests; the README pollUntil description is stale.
- Task 1b.5: dispatched to p0-task1b5 (sonnet), BASE 6fb41eb.
- Task 1b.5: DONE_WITH_CONCERNS df28b06 (gate 2602/2602; clean 4/4; break red at step 1 on the imp-2 DOM assertion). Deviations: LOCAL_ECHO_TIMEOUT_MS 3000, because the brief's 15 s wait stayed green under the break (a resync shows imp-2 after about 11.8 s); failure 3 asserts the disabled entry and that no file chooser opens, because the adminOnly toast is unreachable (the button is disabled). Review dispatched.
- Task 1b.5: complete (commits 6fb41eb..df28b06, review clean). The LOCAL_ECHO_TIMEOUT_MS 3000 deviation is accepted (clean 1-2 ms, broken 11841 ms). Failure 3 asserts the disabled entry (the adminOnly toast is unreachable).
- Task 1b.5: minor (deferred): bound imp2ShownMs at about 1000 ms with a named constant, so a faster resync cannot make the break green.
- Task 1b.5: minor (deferred): `chooser.catch(() => {})` at :96 is an empty catch handler; it violates AGENTS.md no-broad-catch, so it must be fixed in the final-review fix wave.
- Task 1b.5: minor (deferred): B's menu opening duplicates part of openMenu; only the setBoard break has red evidence.
- Lane A done: 1b.1-1b.5 on refactor/codebase (c923049..df28b06).
- LANE-MERGE done: refactor/p0-unit merged into refactor/codebase at 8cfdecd, no conflicts. Every src import used by scripts/*.mjs still resolves (115 names checked, 0 missing). Gate 2649/2649, build, maintainer:build ok.
- Task 2: dispatched to p0-task2 (sonnet), BASE 8cfdecd.
  - Ruling (T2-1): unitTests.atBaseline = {commit c923049, 2602/2602/0}, taken from the task 1 closing gate. atEnd is left to task 9 step 4. Bundle baseline comes from 8cfdecd, the measured tree. Why: the brief defines atBaseline as the pre-3-8 count, and the merged tree is what later phases build on. Cost if wrong: the bundle comparison includes the production fixes that came in with main.
  - Ruling (T2-2): the deferred smokes from tasks 7, 8b and 8c (ui, landing, room-lock, room-management) are judged in this run. Any non-pass among them is re-run on a detached worktree at c923049; if it does not reproduce there, it is a P0 regression and the task is BLOCKED, not recorded as known-red.
- Task 2: DONE_WITH_CONCERNS b53e28c. Result: 15 pass, 7 known-red (facilitation, poker, modal, mobile, spacing, pan, public-tools), 0 flaky, 0 env-skip. The deferred smokes ui, landing, room-lock and room-management all passed twice, so no regression from tasks 7/8b/8c. Gate 2652/2652. Runner time about 17 min.
  - Concern: none of the known-red failures has been checked at c923049. Facilitation's ZIP import "Average 4.5 / 5" may be the deployed mood-on-demand change (an import closes the round and drops resultShownAt).
  - Ruling (M1-T2): review on opus, not sonnet. Why: every later phase gates on this baseline, and 7 known-red need classification (runner setup / stale check / app bug). Cost if wrong: higher review cost.
- Task 2 review (opus, task-2-review.md): spec PASS. Needs fixes. No class D (app bug) and no class E.
  - Classes: facilitation B (68032f6, mood on demand), modal B (0b8e164), mobile B (e1f7f51, a7505a9), spacing B (d40741b), public-tools B (a7505a9), pan B (the 2d698a1 Public creation limit; its recorded reason was wrong), poker C plus a partial A (no Public relay; the /api/account 404 policy).
  - Important 1: pan's reason is wrong.
  - Important 2: poker needs publicRelay:true and a correct reason.
  - Important 3 (controller): judgeKnownRed accepts any failure that prints no FAIL line when failingStep is null, so the six null entries are unguarded.
  - Ruling (T2-REPAIR): add a P0 follow-up, task 2b. It repairs the six class-B stale checks to the current intended UI, and poker's console-error policy, before any P1/P2 code moves. Each repaired check must be shown red on a deliberate break and then re-baselined to pass. Until then, each reason is marked "unguarded until repaired". Why: the spec's P0 purpose is a live safety net over every existing check, and stale checks guard nothing. Updating a stale expectation to intended behaviour, proven by a red break, is not "editing a check to make it pass". Cost if wrong: roughly six sequential check repairs before P1.
  - Task 2: minor (deferred): the baselines block has no decoder or test; PROJECT_DIR and committedManifestJson duplicate existing names; the script-exists test is subsumed by parseManifest; the bundle shape deviates from the brief (disclosed).
- Task 2: fix round 1 sent to p0-task2 (resumed).
- Task 2: fix round 1/5 (5 addressed, 0 open — pan reason; poker publicRelay + reason; cause-based reasons + T2-REPAIR suffix; README no-FAIL list; bundle-shape disclosure; commits b53e28c..05a8ee9). poker now passes 12/12 steps and stays known-red only on the designed 3×404 /api/account.
- Task 2: complete (commits 8cfdecd..05a8ee9, review clean after 1 round). Baseline: 15 pass, 7 known-red (all T2-REPAIR), 0 flaky, 0 env-skip.
- Task 2: minor (deferred): the live-check-common.mjs:465 comment lists only some no-FAIL scripts (2b updates it); facilitation logs a 502/404 without failing (2b gives it publicRelay).
- p0-task2-review (opus) stays alive to review task 2b, since it holds the 7 classifications.
- Task 2b: brief task-2b-brief.md written by the controller. Batch 1 (facilitation, modal, public-tools, poker) dispatched to p0-task2b1 (sonnet), BASE 05a8ee9. Batch 2 (mobile, spacing, pan, plus the :465 comment) follows. Reviewer: p0-task2-review (opus, kept alive).
- Task 2b batch 1: p0-task2b1 DONE_WITH_CONCERNS, 05a8ee9..9b05707 (4 commits). Concerns are observations: a caret race fixed by the new shared helper waitForEditorCaretAtEnd; modal's opaque-popup expectation follows b471dc2. Sent to review (p0-task2-review).
- Task 2b batch 2 (mobile, spacing, pan, plus the :465 comment) dispatched to p0-task2b2 (sonnet), BASE 9b05707, while batch 1 is still in review. Ruling T2b-PAR: batch 2 runs during the batch 1 review. Any batch 1 fix round waits until batch 2 has committed, so two agents never commit in the worktree at once. Why: it saves the review's wall-clock time on the owner's 'finish fast' request. Cost if wrong: batch 1 fixes are delayed, and the manifest/README may need a small manual merge.
- Task 2b batch 1: complete (commits 05a8ee9..9b05707, review clean, task-2b1-review.md).
  - Reviewer agrees on two calls: the caret race is a check race, not class D; modal is opaque per b471dc2.
  - Deferred minors for the final review:
    - (m1) waitForEditorCaretAtEnd never disposes its ElementHandle (board-live-helpers.mjs:425).
    - (m2) the modal step name "Thai desktop: guest skip, …" still names a removed control.
    - (m3) poker prints no PASS lines, so passLines = 0 when green.
  - Residual risk: mobile focuses the editor at mount (MobileEditingControls.jsx:38), so the caret predicate could pass early there. The batch 2 mobile repair must exercise tap-away-to-finish.
- Task 2b batch 2: p0-task2b2 NEEDS_CONTEXT, 9b05707..ef6ccf2 (3 commits).
  - pan: pass. The seed runs in 10/10/4 chunks, adding 130 s; the check takes about 160 s against the 900 s limit.
  - mobile and spacing: known-red at real steps.
  - Sent to review (p0-task2-review). p0-task2b2 stays alive to continue mobile and spacing.
- Ruling T2b-CLOSE: the clipped mobile Draw Close is class D, a real defect.
  - Evidence: at 360 px Close sits at x 353-397, cut off. The toolbar source is identical to live 83a7892 (verified with `git diff --stat`). drawing-close.js:1-4 says Close is the control that stops a failed save trapping the user.
  - The fix goes on its own branch: fix/mobile-draw-toolbar-fit, worktree miro-wt-fix-draw, from main 83a7892, agent fix-draw-close (sonnet).
  - It then merges into refactor/codebase. Allowed: CSS only, no i18n keys.
  - Reverting the fix serves as the mobile check's deliberate break.
  - Deploying it needs fresh owner approval.
  - Why: an app bug must not be adapted around in a check.
  - Cost if wrong: one small CSS branch.
- Ruling T2b-TOUCH: on mobile, tool and action buttons keep the 44 px `--modal-touch-target`. Draw swatch/size options take their floor from the `--draw-mobile-option-size` theme token (34 px).
  - Why: e1f7f51 gave the options their own token on purpose, in the same media block that gives the tools 44 px.
  - Cost if wrong: if the owner wants 44 px options, the app changes, not the check.
  - The owner was told and can override.
- Spacing: OWNER CALL pending. At 360/390, `.rb-landing__card` is 16 px (c53c0fd, landing.css:540), while its role-mate `.rb-modal__content` is 20 px (`--modal-padding`). Only the landing cards deviate, so the check is not adapted until the owner decides. The default proposed to the owner is to keep the 16 px design.
- Deferred gap: pan's `cards` profile would need about 100 creation windows, and the manifest does not run it.
- p0-task2b2 note: mobile already ends every edit by tap-away (tapAway()). So far only checkTextHighZoom has run it. The sticky flows (addMobileCard, checkEditing) run after the Draw step, and that step stays red until the T2b-CLOSE fix is merged. Mobile does not use waitForEditorCaretAtEnd; it fills only fresh, empty editors.
- T2b-CLOSE fix round 1: fix-draw-close 2e1c7db made Close visible, but Eraser is fully scrolled out at 360 (and Arrow and Eraser at 320), with no cue. Ruling T2b-CLOSE-LAYOUT: at widths of 320 px and up, the top row shows all 5 tools plus Close with no scrolling; Undo/Redo are pinned at the start of row 2; only the options scroll; every button is at least 44 px. Why: the round-1 fix only swapped one hidden control for another. Cost if wrong: e1f7f51's 'tools and history on top' arrangement changes on mobile. The owner sees screenshots before any deploy.
- Task 2b batch 2 review (task-2b2-review.md):
  - pan: approved.
  - spec PASS, 2 Important findings:
    - I1: the mobile reason is misattributed; the stale assertion is the options-row bounds check.
    - I2: rule 4 was not run for mobile and spacing.
- Ruling T2b-SPACING: landing-card inset is 16 px (--space-4) below 600 px and 20 px at 600 px and above. Source: c53c0fd, landing.css:532-540. The same block also sets the hero padding to 16 px.
  - Why: the reviewer found the mobile density is deliberate.
  - Cost if wrong: the owner overrides and the landing CSS goes back to 20 px.
  - This supersedes the "owner call pending" above. The owner was told, and the default is kept.
- Task 2b batch 2: fix round 1/5 dispatched to p0-task2b2. Scope: I1, I2 and T2b-SPACING, plus 3 unrun mobile points that rule 1 covers (checkHiddenCard settle, checkDrawingPinch zoom reset, Done/Edit step names). FIX_BASE ef6ccf2.
- Task 2b: minor (deferred):
  - pan-live-check.mjs:144 waitForFunction is given an async predicate, so it never polls. The same no-op appears at pan:453 and modal:446/458.
  - pan:151 is the fifth local copy of step().
  - Commits 5285982 and 9d48f82 each judge REGRESSION on their own, because the manifest edits landed in ef6ccf2.
  - Spacing has one failingStep for every finding. This is moot once it passes.
- T2b-CLOSE fix round 2: fix-draw-close 739821f. The top row is 5 tools + Close at 320/360/390/412 px with no scrolling; Undo/Redo sit at the start of row 2; desktop is identical. Two-context save works 6/6. drawing-toolbar-layout.test.js: 4 tests, 3 fail on main and on 2e1c7db, all 4 pass after the fix. Gate 2599/2599 plus build. Review dispatched to fix-draw-review (sonnet). Package: review-fix-draw-main..739821f.diff.
- T2b-CLOSE fix review (fix-draw-review.md): spec PASS on all 8 measured runs. Needs fixes, 1 Important: the retry Button is auto-placed into an `auto` column 1, which stretches Undo; the failed-load state was never probed. Fix round 3 sent to fix-draw-close. FIX_BASE 739821f.
- fix-draw minors (deferred):
  - On coarse-pointer tablets (768-1024 px), Close sits far right of the tools.
  - Disabled and loading states were not measured.
  - On mobile the visual order differs from the DOM order (tools, options, undo, redo, close). Accepted for now; follow-up.
  - The CSS-text tests cannot catch real layout overflow. The live mobile check is the browser guard.
- T2b-CLOSE fix round 3 (4e1ea80): the retry button now spans its own row; the failed-state probe confirms the earlier finding and the fix. While viewing after3-failed-en-360.png the controller saw that the mobile .rb-drawing-status (fixed position at a constant offset) overlaps the options row. This is probably already on main. Sent as fix round 4 to fix-draw-close: reproduce on main, then anchor the status to the toolbar. Ruling: fix it in this branch. Why: the overlap sits on the same anti-trap failed-load path (Retry or close) and is a 1-rule CSS change. Cost: one extra round.
- Task 2b batch 2 fix round 1 (ef6ccf2..85c9d18):
  - spacing: pass with T2b-SPACING. The break (mobile card padding 24 px) judged REGRESSION.
  - mobile: I1 is repaired; the options row passes at 360. The I2 break (tap-to-edit never edits) judged REGRESSION. Known-red now names only the pending T2b-CLOSE.
  - Scoped re-review sent to p0-task2-review.
- Ruling T2b-RECENTS: the recents card (.rb-landing__card--recents, --landing-recents-padding, from adc23bc 2026-10-12) stays at 20 px on mobile, while the other landing cards are 16 px.
  - Cause: c53c0fd added the mobile override for the card padding but left out recents. Treated as an app oversight, not a design choice, because the owner default is "cards on phones are 16 px".
  - Fix: add `--landing-recents-padding: var(--space-4)` to the 599px block, as its own commit on the fix branch after the draw round 4.
  - spacing keeps a recents exception for now, documented as pending, and is tightened after the merge.
  - Cost if wrong: one CSS line, and recents gets 4 px less padding on phones.
- Mobile after the merge: two deliberate breaks, (1) the pre-fix toolbar CSS and (2) a canvas tap that no longer closes the editor, to guard tap-away directly.
- T2b-CLOSE fix round 4 (a32bb4a): the mobile status is now anchored above the toolbar. On main it overlapped the toolbar in 8/8 loading and failed cases; after the fix 0/8 overlap. Layout tests 6/6. Gate 2601/2601 plus build. Next: the T2b-RECENTS commit on the same branch (fix-draw-close), then a scoped re-review by fix-draw-review over 739821f..HEAD.
- Task 2b batch 2: fix round 1/5 (I2 addressed, I1 open: the options row is never checked against the viewport; commits ef6ccf2..85c9d18). Fix round 2 sent to p0-task2b2. Ruling: minors N1 (assertInside duplicates assertWithinViewport), N2 (recents comment) and N3 (gate rerun) are folded into round 2. Why: they sit in the edited lines. Cost: none. Note: the spacing isRecents exception must be removed in the same change that merges T2b-RECENTS, or spacing judges REGRESSION.
- T2b-RECENTS fix: a1be1a3 on the fix branch. Recents goes from 20 to 16 px at 360/390 and is unchanged at 768/1440. The contract test fails before the fix and passes after. Gate 2602/2602 plus build. The fix branch is now 5 commits (2e1c7db..a1be1a3) with 0 i18n lines. Scoped re-review 739821f..a1be1a3 sent to fix-draw-review.
- Fix branch re-review: APPROVED (739821f..a1be1a3, retry ADDRESSED). New minor: a32bb4a made the status start at the toolbar edge instead of clearing the left rail, so it can overlap on short viewports (about 630 px tall or less). Ruling: fix before merge (one line, and it is a regression this branch introduced). Sent to fix-draw-close.
- Task 2b batch 2: fix round 2 (ec5e138). The options row is now checked inside the viewport. N1, N2 and N3 are done; the gate is 2652/2652 plus build. Scoped re-review sent to p0-task2-review.
- Task 2b batch 2: fix round 2/5 (4 addressed, 0 open; commits 85c9d18..ec5e138). pan and spacing are complete. Mobile waits for the fix-branch merge (rail tweak still in progress), then the post-merge completion round.
- Fix rail tweak 3235754: the status clears the rail. Before the fix, 8 of 16 combinations overlapped; after, 0. Gate 2602/2602 + build. A scoped re-review went to fix-draw-review, running in parallel with the merge.
- Merged fix/mobile-draw-toolbar-fit (2e1c7db..3235754) into refactor/codebase as 1ed4852 (--no-ff). It adds no i18n lines. Targeted tests 119/119.
- p0-task2b2 has started the post-merge completion round:
  - remove the spacing isRecents exception;
  - finish mobile past Draw;
  - two mobile breaks: (a) pre-fix toolbar CSS, (b) tap-away no longer closes the editor;
  - re-baseline mobile to pass.
- Deferred observation for the owner: on short or landscape phones (e.g. 568x320) the Draw toolbar covers the lower part of the tool rail. This was already on main 83a7892, so it was not introduced by this branch.
- Deploy note: fix/mobile-draw-toolbar-fit should go to production through a release branch from main. That needs fresh owner approval.
- Fix branch final re-review: ADDRESSED, no new breakage. fix/mobile-draw-toolbar-fit is complete at 3235754 (5 fix commits + rail tweak; review clean). fix-draw-close and fix-draw-review stopped. Release prep (release d = main + this branch) is deferred until the mobile live runs finish, so CPU contention cannot make them flaky.

## 2026-11-19 post-merge round
- p0-task2b2 post-merge: e511968 (spacing exception dropped), bf5df9e (mobile past Draw, re-baselined pass; breaks a/b judged REGRESSION; npm test 2659/2659).
- Re-review 2 (task-2b2-rereview-2.md): Spec PASS, Quality Approved, 4 Minor. The minors were sent back to p0-task2b2 as a tidy commit, with no live runs because the release build is loading the CPU. One mobile confirmation run is still owed in the final review.
- Task 2b: complete (commits 05a8ee9..bf5df9e, review clean; tidy-minors commit pending)
- Release d prep was delegated to the release-d-prep agent: release/20261119d = 83a7892 + fix/mobile-draw-toolbar-fit, in folder release-20261119d/. It stops before deploy.
- Release d DEPLOYED 2026-11-19 (owner "deploy"): web miro-release-web:drawfit-ded9583 (release/20261119d ded9583). Smoke ok; record in release-20261119d/RECORD.txt.
- ec9326c tidy minors; mobile confirm run mobile-tidy1: 35 PASS, 0 FAIL, exit 0.
- Task 9 step 4: 732718c, atEnd = ec9326c 2659/2659 (controller npm test run).
- Ruling (OWNER-CODEX, owner 2026-11-19 "ใช้ codex refactor งานนี้รอตรวจ step สุดท้ายพอ"): from here, Codex gpt-6.1-sol medium implements P1+ from the design doc with no per-task reviews. The P0 final whole-branch review is folded into ONE final review at the end of the refactor, which must cover every P0 deferred minor listed above. The controller still runs the gate and live manifest between phases.
- P0: all tasks complete. Doc patch (task 9) still awaits owner approval.
- P1 (Codex, OWNER-CODEX): e58bcba..85844dc, DONE_WITH_CONCERNS (extra existing source scans inventoried, not removed). Controller gate: npm test 2660/2660, build ok. No live checks (test-only).
- P2A (Codex): abcf9da..2b172a1 + fix 12b0e94 (live found 'Illegal invocation' from detached setTimeout in use-toast.js; unit tests missed it). Controller gate 2721/2721; live ui, landing, drag-peer, undo-middrag OK (refactor-gates/p2a-fix1).
- P2B (Codex): 37c11e9..576e3bd. Gate: first run 1 fail (security 32-provider compaction under load avg ~21), security suite alone 40/40, full rerun 2828/2828, build ok. FULL live manifest at 576e3bd: 22/22 OK (refactor-gates/p2-full). P2 complete -> R-A release point (owner decision pending).
- P3 (Codex): 9d37497..a308318, storage-bridge.js 295 lines. Controller gate 2871/2871, build ok; live 9/9 OK (ui, import-ui, room-lock, drag-peer, undo-middrag, presence, reactions, timer, public-tools; refactor-gates/p3). Note for final review: a308318 commits an SDD report file.
- P4 (Codex): 2cc63c5..607cf25, yjs-server.mjs 441 lines. Controller gate 2909/2909, build ok; FULL live manifest 22/22 OK (refactor-gates/p4-full). Relay image not built (owner-approved step).
- P5A (Codex): e709228..43c81d3, RetroBoard.jsx 3366. Controller gate 2932/2932, build ok; live 9/9 OK (refactor-gates/p5a).
- P5B (Codex): f2e09e1..a7baeaf, RetroBoard.jsx 2895. Controller gate 2976/2976, build ok; FULL live manifest 22/22 OK (refactor-gates/p5-full) — note: slot wait hit its 1800 s cap with another session's Chromium still running, so this run overlapped one foreign Chromium. P5 complete -> R-C point. P6 needs owner opt-in (asked).
- Final-review relay I1 resolved by controller: Dockerfile.yjs built from git archive of a7baeaf (miro-refactor-yjs:a7baeaf), booted on Node 24.20 with tmpfs DB: 'listening on ws://0.0.0.0:1234', bad-origin config rejected with the exact error, /api/account 404 (sign-in off). Evidence refactor-gates/relay-image-a7baeaf/.
- Final review (4 reviewers, 83a7892..a7baeaf): harness C0/I2/M6, bridge C0/I1/M7, relay C0/I1/M11, react C0/I2/M10. Relay I1 closed by controller image build+boot.
- Ruling: react I2 (wrapper hooks rebuild controllers per render, manual dep lists; D-HOOK contract §5.4) is deferred to P6 or the owner. Why: every dep list matches base, so there is no defect today, and reshaping all wrappers in a fix wave risks hook-order changes. Cost if wrong: a future option added to a wrapper may go stale unnoticed until P6.
- Ruling: bridge M4/M5/M6, relay M8/M9, and the harness step() copies and common split are deferred. Why: no runtime effect; M6 (locale size cap) and M8 (docs patch) are owner decisions. Cost if wrong: M5's golden master blocks the first wording fix until it is retired.
- Fix wave dispatched to Codex (one wave) with every other finding.
- Owner 2026-11-20 answered '2 3': prepare a release after the fix wave (deploy still needs approval); 18 worktrees removed. P6 not chosen -> not started (default: stop at P5).
- Fix wave a4c1a83..e067c5b (Codex): 2979/2979, build ok. Scoped re-review (final-rereview.md): 28/28 ADDRESSED, no new C/I, 7 new minors (N1 INV-14 stray-key, N2 activeelementType typo worth fixing).
- N1/N2 fixed by controller (test-only); N1 red-proof: stray key in replaceBoardLocal -> 'clear adds or drops no board field'. Note: that src mutation lived ~2 s during the fix-full live run.
- fix-full live: 19 OK, ui/landing/poker REGRESSION with exit 0 = false positives from the a4c1a83 zero-PASS guard (missed by re-review). Fixed by controller with a stepLines:false opt-out (commit above), red-proven, npm test 2981/2981.
- Release e DEPLOYED 2026-11-20 (owner 'deploy'): yjs+web refactor-6e9a01f; rooms equal 242/5; prod drag-peer 7/7. Record release-20261120e/RECORD.txt.

## 2026-11-23 final-review follow-up

The owner selected the review backlog. The [follow-up report](../reviews/2026-11-23-refactor-followup.md) records the finding dispositions, red proofs, 3,002 passing unit tests and 22 passing live checks. React I2 and hook-order note N5 remain with P6.
