# Public Wall implementation evidence — 2026-10-20

Base HEAD: `288efb3af7655210fcd35860f368d64ea1db6619` on `feat/public-wall`. Changes remain uncommitted.
The pre-existing `scripts/ui-live-check.mjs` edit and tier-system draft were not changed.
No owner-gated deployment file, backup script, credential or production data was modified.
No browser, production deployment, production restore or commit was attempted.

> Current review fixes and validation are recorded under **Fix round 1** below.
> The initial test/RED sections retain the original run as historical evidence.

## Plan adjustments

- Added a public-only Vite proxy: private development uses a direct relay port and
  had no `/yjs` proxy. Public HTTP and WebSocket traffic consistently uses the
  same-origin `/yjs-public` prefix.
- Added authenticated `POST /rooms/<handle>/public-session` renewal within the
  existing room cookie path. Applying new-writer admission to renewal would
  otherwise prevent all 32 connected writers from refreshing their cookies.
  Both exchanges retain the existing Origin check and shared exchange buckets.
- Kept the public document resident using a local snapshot subscriber. The
  pinned y-websocket implementation destroys a persisted document when its last
  connection leaves; snapshots and maintenance must also work with no writers.
  The local subscriber uses neither a socket nor a writer-admission slot.
- Added a public-directory ownership marker and required an explicit dedicated
  directory. A nonempty unmarked directory is refused, preventing accidental
  adoption of private-room data. Restore takes LevelDB's exclusive lock and
  publishes recovery into a fresh document/handle through RoomRegistry, then
  retires the old identity so stale replicas cannot reconnect.
- Hid templates and sticky privacy toggles in public chrome, and made newly
  created public stickies visible. Templates can contain images or private
  content; this keeps the supported creation flow to cards, text and zones.

## Files changed

- `Dockerfile.yjs`
- `RetroBoard.jsx`
- `SECURITY.md`
- `docs/plans/2026-10-20-public-wall-deploy.md`
- `docs/plans/2026-10-20-public-wall-evidence.md`
- `package.json`
- `public-wall.integration.test.mjs`
- `relay-maintenance.test.mjs`
- `scripts/README.md`
- `scripts/public-wall-restore.mjs`
- `scripts/public-wall-restore.sh`
- `src/Landing.jsx`
- `src/PublicWallPreview.jsx`
- `src/PublicWallPreview.test.js`
- `src/SelectionToolbar.jsx`
- `src/ToolDock.jsx`
- `src/TopBar.jsx`
- `src/TopBarPopovers.jsx`
- `src/ZoneCard.jsx`
- `src/ZoneToolStrip.jsx`
- `src/client-sync.js`
- `src/i18n.js`
- `src/main.jsx`
- `src/public-room-session.js`
- `src/public-room-session.test.js`
- `src/public-wall-config.js`
- `src/public-wall-config.test.mjs`
- `src/public-wall-contract.js`
- `src/public-wall-contract.test.js`
- `src/public-wall-history.js`
- `src/public-wall-history.test.mjs`
- `src/public-wall-round1.test.js`
- `src/public-wall-prune.js`
- `src/public-wall-prune.test.mjs`
- `src/public-wall-restore.js`
- `src/public-wall-restore.test.mjs`
- `src/public-wall-snapshot.js`
- `src/public-wall-snapshot.test.mjs`
- `src/public-wall-ui.test.js`
- `src/public-wall-view.js`
- `src/public-wall-view.test.js`
- `src/public-wall.css`
- `src/relay-http.js`
- `src/relay-http.test.js`
- `src/relay-local-files.js`
- `src/relay-local-files.test.mjs`
- `src/relay-maintenance.js`
- `src/relay-room-registry.js`
- `src/relay-public-wall.js`
- `src/relay-public-wall.test.mjs`
- `src/room-session.js`
- `src/router.js`
- `src/rule-ratchets.test.js`
- `src/storage-bridge.js`
- `src/vote-ownership.js`
- `src/vote-ownership.test.js`
- `vite.config.js`
- `yjs-server.mjs`

## Literals ledger

Runtime policy values and labels introduced for this feature:

| Literal | Constant / unit / source |
| --- | --- |
| 10,000 | PUBLIC_SNAPSHOT_INTERVAL_MS; milliseconds, task polling/cache contract |
| 1,500 | PUBLIC_MAX_ITEMS; live items after maintenance, task |
| 32 | PUBLIC_WRITER_CAP; concurrent writer connections, tested capacity profile/task |
| 1 | PUBLIC_ROOM_COUNT; registered room count, task |
| 3,600,000 | PUBLIC_BACKUP_INTERVAL_MS = existing MILLISECONDS_PER_HOUR; task |
| 48 | PUBLIC_BACKUP_RETENTION_COUNT; files, task |
| 268,435,456 | PUBLIC_MAX_DATABASE_BYTES; bytes (256 MiB), approved-plan default |
| 1235 | PUBLIC_RELAY_PORT; local TCP port, distinct from private relay 1234 |
| `/yjs-public` | PUBLIC_RELAY_PREFIX; public relay URL prefix, task |
| `/public` | PUBLIC_PATH; public board pathname, task |
| `/api/public-session` | PUBLIC_SESSION_ROUTE; initial anonymous exchange, task |
| `/api/snapshot` | PUBLIC_SNAPSHOT_ROUTE; unauthenticated preview, task |
| `/public-session` | PUBLIC_ROOM_SESSION_SUFFIX; cookie-scoped renewal suffix |
| `public`, `private` | BOARD_MODE; client mode enum |
| `sticky`, `text`, `zone` | PUBLIC_ITEM_TYPES; supported non-image canonical item types |
| 2,000 | PUBLIC_TEXT_MAX_CHARACTERS; characters/item in compact preview, implementation bound |
| `.public-wall-v1` | PUBLIC_DIRECTORY_MARKER; public data ownership marker filename |
| `retro-public-wall-v1` + newline | PUBLIC_MARKER_CONTENT; marker format/version |
| `snapshots` | PUBLIC_SNAPSHOT_DIRECTORY; public-directory recovery subdirectory |
| `wall-<13-digit epoch-ms>.bin` | PUBLIC_BACKUP_FILE_PATTERN; UTC epoch-millisecond encoded-state filename format |
| `public-prune` | PUBLIC_PRUNE_ORIGIN; Yjs transaction origin, task |
| `./yjs-db` | MAIN_DEFAULT_DB_DIRECTORY; existing private default, explicitly forbidden for public mode |
| `disabled-uploads` | DISABLED_UPLOAD_DIRECTORY; unused upload directory within public data |
| 0600, 0700 | PRIVATE_FILE_MODE, PRIVATE_DIRECTORY_MODE; POSIX owner-only file/directory modes |
| 1 | COMMITTED_REGISTRATION_VERSION; existing RoomRegistry v1 commit marker format |
| 1 | WEBSOCKET_OPEN_STATE; WebSocket OPEN enum used by the local snapshot subscriber |
| 1 | EMPTY_EXTENT_PX; nonzero empty SVG view extent, pixels |
| 12 | PREVIEW_TEXT_PADDING_PX; preview text inset, pixels |
| `x`, `y`, `w`, `h` | SNAPSHOT_GEOMETRY_FIELDS; existing canonical geometry keys |
| `/api/rooms`, `/api/room-session` | DISABLED_API_ROUTES; existing private API paths disabled in public mode |
| `public, max-age=10` | SNAPSHOT_CACHE_CONTROL; derived from polling interval and existing MILLISECONDS_PER_SECOND |
| 280px / 16px | `.rb-public-wall__preview` height / margin and paragraph padding; CSS layout dimensions |
| `public.*` copy | src/i18n.js `th` and `en` entries; title, description, join, watch, full, empty, unavailable, loading |
| 4368 / 2001 | RETRO_BOARD_MAX_LINES / YJS_SERVER_MAX_LINES; lowered to actual final source lengths |

The local npm script repeats the public port/prefix/storage flags because npm
scripts cannot import JS constants. Its dedicated development root is
`/Volumes/ssd-fluke/BaseData/retro-board/public-wall-dev/db`; the command refuses
an absent BaseData root. Existing schema keys (`items`, `meta`, `createdAt`,
`type`, `text`, `title`, `private`), HTTP status/method/media values and Yjs
`update`/`destroy` events retain their existing protocol meanings. Existing
security-boundaries and geometry bounds, HTTP retry/preflight constants, session
expiry/signing rules and theme tokens are reused.

Test-only values are explicit fixtures or contract expectations. The integration
harness names START_TIMEOUT_MS and SHUTDOWN_TIMEOUT_MS (5,000 ms), WRITER_COUNT
(32), ORIGIN (synthetic HTTPS origin), SYNC_MESSAGE_TYPE (0) and SYNC_UPDATE_TYPE
(2), and reads config/room-capacity.env. Recovery fixtures use temporary synthetic
databases and encoded states, not production data. The proposed deployment diff
retains the existing 768 MiB/1.5 CPU, read-only root, dropped capabilities, health
check and rotating local-log limits for the new isolated service.

## RED evidence

Every command below used base HEAD `288efb3af7655210fcd35860f368d64ea1db6619`.
Logs are small throwaway test output under `$TMPDIR`.

- Before new modules existed, seven configuration/pruning/snapshot/view/session
  tests failed importing their missing implementation (`public-wall-red.log`).
  Six public relay/history tests also failed before implementation
  (`public-wall-relay-red.log`); preview/chrome and restore had their own initial
  RED logs. These establish pre-implementation failures but are supplemented by
  the assertion-level mutations below.
- `public-wall-mutation-red.log`: 23 behavior tests, **0 passed / 23 failed**.
  Temporarily replaced configuration with pass-through defaults, admitted images
  in the contract, disabled pruning/history/restore/provisioning/retention,
  returned empty snapshots/views, removed session/route checks, changed public
  request bodies, revealed private chrome, removed preview text, changed key
  reload behavior and disabled active-vote ancestry. All original sources were
  restored in a Python `finally` block. `public-wall-mutation-green.log` then
  recorded **23 passed / 0 failed**. The configuration test was subsequently
  renamed to `.test.mjs`; npm's expanded glob runs it.
- `public-wall-wiring-red.log`: disabled public maintenance, public HTTP dispatch
  and public opaque-path parsing. **0 passed / 3 failed**. Restored the original
  sources in `finally`; `public-wall-wiring-green.log`: **3 passed / 0 failed**.
- Dedicated renewal RED: unsigned room-scoped refresh originally returned no
  response instead of 401 (`public-wall-renewal-red.log`); authenticated renewal
  at writer capacity and unsigned rejection now pass.
- Dedicated malformed-item RED: `item?.get` threw on an untrusted plain object
  and prevented pruning (`public-wall-malformed-red.log`). The guarded getter
  now prunes malformed values and passes (`public-wall-malformed-green.log`).
- All **26 non-socket new behavior tests** also ran and passed within `npm test`.
  No existing negative assertion was removed or weakened.
- Four new real-socket integration tests exist and are included in `npm test`.
  Their attempted RED/green runs were blocked by the environment's localhost
  listener EPERM, so those failures are **not claimed as valid feature RED**.

## Initial implementation test/build results

Local runtime: Node **26.5.0**; production Node 24 container checks remain pending.

Final `npm test`: **655 tests; 611 passed, 44 failed, 0 skipped, 0 cancelled**.
The 44 failures are the four new socket integration tests and 40 existing socket
security/lifecycle tests. All fail because this sandbox rejects localhost listen
with EPERM. A temporary uncaught-exception monitor prints error codes only:
39 startup failures contain standalone EPERM; the remaining five fatal-lifecycle
assertions contain EPERM inside their captured child stderr. No test was skipped
or gate suppressed. Final output: `$TMPDIR/public-wall-npm-test-final.log`.

`npm run build`: **PASS**, one production build; existing Vite chunk-size advisory
at approximately 508 kB. Output: `$TMPDIR/public-wall-build-final.log`.
`git diff --check`, shell syntax and server/restore CLI syntax checks pass.
Line ratchets and all JSX color-token checks pass. The relay image's transitive
local-import check passes with explicit new runtime COPY entries.

## Assumptions and remaining verification

- Oldest uses the existing client-supplied `createdAt` field, invalid/missing
  timestamps first and lexical item ID for ties. Dates are forgeable.
- Snapshots are changed-only recovery points, written at most hourly, retaining
  at most 48 files, additionally bounded by the separate 256 MiB history budget.
  The database measurement excludes root snapshots only; large states may
  yield fewer than 48 recovery points. This is documented in the deployment proposal.
- Anonymous writers may edit/delete others' content. UI hiding is not an ACL.
  Existing private sticky text is redacted from the unauthenticated preview.
- Chromium was not launched, per instruction. Two-context sync, undo/redo,
  live preview cadence and rendered Thai/English layouts need orchestrator checks.
- Socket admission/restart/isolation and sustained 32-provider testing under
  production container limits need an environment that permits listeners.
- Production build/scan/deploy/backup changes are proposed only. No production
  data or snapshot was restored. A synthetic temporary-database cross-process
  restore-lock test passed.
- SonarQube/SonarLint was not available; no formal analyzer result is claimed.

## Fix round 1

Source under test: the orchestrator-reviewed uncommitted feature worktree on
HEAD `288efb3af7655210fcd35860f368d64ea1db6619`. The orchestrator reported the
previous outside-sandbox run as 655 tests / 654 pass / one F3 failure.

| Finding | Status / changed files | Regression / RED evidence |
| --- | --- | --- |
| F1 | FIXED: public-wall-restore.js, relay-room-registry.js, room-session.js, client-sync.js and paired tests; restore CLI/catalog/security documentation | Real Yjs/LevelDB test snapshots a card, persists a vandal replica's deletion, restores into a new document/handle and hydrates the real registry. The old handle cannot deliver its delete state; restored content survives. 401/404 public renewal re-enters and reloads without rebinding the stale provider. Socket-error event recovery and failed re-entry health are also tested. |
| F2 | FIXED: public-wall-history.js, public-wall-config.js, relay-local-files.js, yjs-server.mjs and paired tests; deployment/security docs | Independent 256 MiB history budget; oldest-file eviction before and after publication, 48-file ceiling and oversized-state rejection. Only root snapshots are excluded at all three database measurement sites; nested directories still count. Actual server measurement wiring is evaluated without sockets. |
| F3 | FIXED: public-wall.integration.test.mjs | Main-room POST now sends application/json and JSON.stringify({}), matching apiPost. Socket-only RED and green: **orchestrator to run**. |
| F4 | FIXED: public-wall-prune.js, public-wall-config.js and prune test | Far-future createdAt is invalid/oldest; the exact +60-second boundary remains valid. |
| F5 | FIXED: deployment proposal and public-wall-round1.test.js | Owner Cache Rule for the exact extensionless snapshot path, eligibility plus origin TTL, and serialized in-memory fallback are explicit. No Cloudflare settings were changed. |
| F6 | FIXED: deployment proposal and public-wall-round1.test.js | Verifier diff contains only public-volume verification; unrelated scratch setup diff removed. Existing TMPDIR operations guidance is a separate optional note. |
| F7 | FIXED: package.json and public-wall-round1.test.js | Missing-volume command exits 1 and prints the unavailable path to stderr before launching any relay. |

### Round 1 RED evidence

All logs below are small throwaway files under `$TMPDIR`; no production state or
external-volume captures were generated. Base HEAD is the hash above throughout.

- `public-wall-round1-red.log`: six runnable regressions failed before fixes:
  restore identity, public renewal 401, public renewal 404, history byte cap,
  database/history overlap and future timestamps. Eight pre-existing checks passed.
- `public-wall-round1-docs-red.log`: three runnable regressions failed before
  changes: missing Cache Rule, unrelated verifier diff and silent volume failure.
- `public-wall-round1-socket-event-red.log`: removing the public socket-error
  listener reproduced failure to re-enter; the event is emitted by a fake
  transport without opening any socket. Source restored afterwards.
- `public-wall-round1-reentry-red.log`: failed recovery originally left session
  health active; the test failed before moving session-loss publication ahead
  of the recovery exchange.
- `public-wall-round1-oversize-red.log`: removing oversized-state admission
  reproduced missing rejection and loss of the usable prior state. Source restored.
- All **12** above runnable behavior checks pass after fixes. Their files also
  run under npm test. The combined regression files report **20/20 passed**
  including eight pre-existing checks (`public-wall-round1-regressions.log`).
- F3's socket-only RED/green is **orchestrator to run**; the reported pre-fix 400
  is accepted as the initial reproduction. No socket failure is claimed as valid
  local feature RED.
- The obsolete positive expectation that restoration preserves a handle was
  replaced with the reviewed rotation contract. No existing negative assertion
  was removed or weakened.

### Round 1 final checks

- Non-socket file suite: **618/618 passed**, zero failed/skipped/cancelled.
  `$TMPDIR/public-wall-round1-nonsocket-final.log`.
- Full required npm test: **666 tests, 622 passed, 44 localhost socket startup
  failures, zero skipped/cancelled**. These are the same 40 existing plus four
  public integration tests blocked by sandbox EPERM.
  `$TMPDIR/public-wall-round1-npm-test-final.log`.
- Required npm run build: **PASS**; Vite retains its approximately 508 kB chunk
  advisory. `$TMPDIR/public-wall-round1-build-final.log`.
- Whitespace/syntax checks, line ceilings and color-token checks pass. Frozen
  sources remain RetroBoard 4368 and relay 2001 lines; ceilings were not raised.
- No gated files, production backup scripts, live-check edits, credentials or
  production data were changed. No browser or commit was attempted.
- Node 24 container/browser/live socket validation remains for the orchestrator.
  Local runtime remains Node 26.5.0; formal Sonar analysis was unavailable.

### Round 1 literals ledger

| New literal | Constant / unit / source |
| --- | --- |
| 268435456 | PUBLIC_BACKUP_MAX_TOTAL_BYTES; independent history byte budget, 256 MiB |
| 60000 | PUBLIC_CREATED_AT_CLOCK_SKEW_MS = existing MILLISECONDS_PER_MINUTE; milliseconds, F4 allowance |
| 2 | PUBLIC_RESTORE_ROOM_SLOTS; temporary offline registry room slots during publish-before-retire |
| 0 | QUARANTINED_REGISTRATION_VERSION; deliberately not the existing committed v1 marker |
| 401, 404 | ROOM_SESSION_REJECTED_STATUSES; existing HTTP authentication/retirement statuses reused across recovery and roomFetch |
| room-replaced | ROOM_SESSION_HEALTH.REPLACED; internal session event requiring fresh-document reload |
| wall-<13-digit epoch-ms>.bin.tmp | PUBLIC_BACKUP_TEMP_FILE_PATTERN; interrupted-write cleanup format |
| 1000 | RECOVERY_TEST_TIMEOUT_MS; test deadline, milliseconds |
| 500 | RECOVERY_EVENT_TIMEOUT_MS; test event deadline, milliseconds |

History and database budgets do not overlap; retained states may be fewer than
48 under the byte ceiling. Restore publication precedes old-room retirement:
if interrupted in that narrow offline interval, startup refuses two committed
rooms rather than exposing a stale room. This fail-closed interruption path is
documented; production crash injection was not performed.

## RULE CONFORMANCE

- Code shape / new issues: PASS manual review of new modules; formal Sonar result unverified.
- Types/invariants: PASS stateful cache/history/relay owners encapsulate their state.
- Shared layer: PASS shared protocol constants, HTTP serialization and existing session lifecycle reused.
- Named helpers: PASS focused geometry/view/prune/history/session helpers; no duplicated business implementation identified.
- Named policy literals: PASS runtime ledger above; existing wire/schema meanings reused.
- One-way dependencies: PASS new imports point to shared contracts/domain helpers; per-call peer ports follow existing maintenance convention.
- Imports at top: PASS.
- Unresolved owned duplication/cycles: PASS none identified in new modules.
- No suppressed gates: PASS no new suppressions, skips or raised thresholds; 44 environment failures reported.
- Reuse tooling: PASS existing npm gate/build and script catalog used; new restore CLI cataloged; production backup edits proposed only.
- Tests meaningful: PASS real Yjs state, files, cross-process database lock and rendered React output; unit under test is not mocked.
- RED evidence: PASS initial 26 and round-1 12 non-socket behavior checks; real-socket RED remains orchestrator to run.
- Source reproduction: N/A new feature; feature-introduced malformed item and renewal defects reproduced before their fixes.
- Logging batching: N/A no new production diagnostic sink or hot-path logs.
- Durable writes: PASS existing LevelDB persistence unchanged; snapshot/recovery writes retain explicit atomic/commit ordering.
- Write volume: PASS changed-only, throttled snapshot generation/history; bounded retained file count.
- Append-only logs: N/A no new log files.
- Rotation/retention: PASS proposed container local logs retain max-size/max-file; recovery retains 48 files.
- Storage location: PASS dedicated public volume/dev BaseData; only explicitly allowed small test output/fixtures in TMPDIR.
- Secret logging: PASS capability never returned or logged by new public paths; diagnostic monitor emits error codes only.
- Log format: N/A new logging sink; existing relay error style preserved.
- Think first: PASS approved plan checked against storage, session, geometry, router and provider lifecycle.
- Minimum solution: PASS one room and isolated process; no identity/ACL expansion.
- Surgical edits: PASS frozen sources shrink, prohibited files/pre-existing edits preserved.
- Verifiable success: PASS checks and concrete environment limitations recorded above.
- Repo style: PASS theme tokens/i18n and test discovery preserved.
- Failure paths: PASS invalid geometry, malformed map values, hostile Origin, capacity/rate denial, unsigned refresh, history retry, corrupt restore and private-directory rejection covered.
