# Security review of the refactor follow-up, 23 November 2026

**Release decision on 23 November — hold `09b7ef7`.** The production image scanner detected one High vulnerability in the locally rebuilt tunnel image. The dependency pin predates the refactor. The source review also found two risks in the browser test tools.

The comparison covers `cc2644c...09b7ef7` on local `main`. Production client changes in that range were import ordering and whitespace. Relay runtime code, dependency pins and deployment configuration were unchanged. The deployment running at `retroroom.party` was outside the scope of this check.

## Release image finding

| Local production image (linux/arm64) | High | Critical |
| --- | ---: | ---: |
| cloudflared | 1 | 0 |
| yjs | 0 | 0 |
| web | 0 | 0 |
| volume-init | 0 | 0 |

`Dockerfile.cloudflared` pins `golang.org/x/net` to `v0.60.0` at line 34 and checks that version at line 44. Trivy found **CVE-2026-78661** in the compiled binary. The Go advisory identifies excessive resource use in the HTML parser and lists the first fixed version as `v0.62.0`. The scanner establishes the affected module version. Whether public tunnel traffic reaches the affected parser remains unverified. Update the pin, module-file checksums and version assertion, then rebuild and rescan the candidate images. [Go vulnerability advisory](https://pkg.go.dev/vuln/GO-2026-6860)

## Standards

1. **High potential impact on local data.** The live runner merges the shell environment into each child at `scripts/live-check-process.mjs:104`. The public relay sets a disposable database but inherits `YJS_UPLOADS_DIR` when it is exported. A custom, writable upload directory outside the database can pass the public relay's path checks. At startup the relay reconciles that directory against the new database. Old encrypted uploads absent from the disposable database can be deleted. Both relay recipes also inherit `YJS_HOST`, so the insecure test relay can listen beyond loopback. Pin both relay bind addresses to loopback and give the public relay an explicit run-owned uploads directory. See `scripts/live-check-common.mjs:162–181`, `src/server/public-wall-config.js:30`, `yjs-server.mjs:72,437`, `src/server/e2e-blobs.js:225` and `src/server/e2e-blob-store.js:153`.
2. **Low risk of local credential disclosure.** Two browser reporters save the complete board URL, including its bearer capability, in `report.json`. Someone with the report and access to the corresponding running relay can use the link to enter the room, subject to any additional room controls. Keep the full URL in memory for browser joins and redact fragments from saved step, error and report data. See `scripts/board-live-helpers.mjs:386,501`, `scripts/ui-live-check.mjs:271,469` and the [room capability model](../../../SECURITY.md).

## Spec

1. The isolation promised for disposable browser checks depends on the invoking shell. The manifest expanded use of the existing public-relay recipe from 7 to 16 checks. A configuration-only check with synthetic parent values confirmed the effective public relay selected both the external upload path and the inherited bind address. This check started no listener and wrote no uploads. In the previous full browser run, all 16 public relay logs recorded zero files removed, and all 16 runs created their own default upload directories.
2. The documented room capability is sufficient to establish a room session. Persisting it in a diagnostic file extends possession to anyone who can read the report. Both reporting paths predate the refactor. A regression test should exercise serialization of successful steps and errors with a synthetic room fragment.

## Checks and evidence

- 104 focused tests passed with zero skips, covering origin checks, sessions, room crypto, ownership, storage contracts and relay security boundaries.
- The lockfile audit of 114 npm dependencies, including development dependencies, reported zero known vulnerabilities across all severities.
- Compose configuration validation passed. The four images were rebuilt from the tracked source with `--pull --no-cache` under audit-only tags. The resolved Compose configuration differed only in image names. The repository's pinned Trivy scanner passed the source-secret and High/Critical container-configuration checks. Its image gate stopped at the tunnel finding. Separate invocations of the same script completed scans of the three remaining image IDs.
- Build output, immutable image IDs, test results, the npm audit and all scanner logs are in [the local evidence directory](/Volumes/ssd-fluke/BaseData/retro-board/security-followup-20261123-73jzea).

The Standards and Spec reviews each identified two findings. In both reviews, the most serious is the live runner's ability to select external upload storage.

## Baseline rule conformance

- Code shape — FAIL → the public fixture leaves storage and listener configuration to its parent environment.
- Tests — PASS for the focused suite executed against the reviewed commit.
- Logging and disk writes — FAIL → browser reports persist a room bearer capability.
- Data location — FAIL → an inherited uploads directory can direct a disposable run outside its task folder.
- Karpathy guidelines — PASS for the scope of the reviewed follow-up.
- Repo style — FAIL → the cloudflared candidate fails the documented production image gate.
- Failure-path tests — FAIL → the harness lacks regression coverage for inherited storage or bind settings and capability redaction.

## Remediation on 24 November

The [implementation plan](../plans/2026-11-23-refactor-security-fixes.md) resulted in three changes, verified on candidate `74a514d`.

| Original finding | Change | Before and after |
| --- | --- | --- |
| High finding in the tunnel image | `974696c` updates `x/net` to `v0.62.0` and `x/crypto` to `v0.58.0`. The reviewed module graph also advances `x/sync`, `x/sys`, `x/term` and `x/text`. | The old image had one High finding. The rebuilt image passed the module hash checks, printed its version and had zero High or Critical findings. All four candidate images passed the repo scanner. |
| Test relays could use external storage or listen beyond loopback | `bd77b46` pins both relay bind addresses and their separate data directories after per-test overrides. | Both regression cases failed with conflicting settings on the old recipe and passed after the change. |
| Live diagnostics persisted room capabilities | `74a514d` uses a shared redactor for browser reports, failure messages and captured console output. | The old two-participant runner wrote a synthetic invite in a successful nested step and a failure message. After the change both diagnostics kept the room path and the token stayed in memory. The three diagnostics regression tests passed. |

Node 24.20.0 passed all 3,007 unit tests with zero skips. The client, prerender and maintainer builds succeeded. The npm audit covered 114 dependencies and reported zero known vulnerabilities. The recommended SonarJS rules produced no new diagnostics in the 14 changed JavaScript files. The source-secret and container configuration checks passed.

The Linux/arm64 images used isolated local tags. Their immutable IDs and the scan output are in [the verification directory](/Volumes/ssd-fluke/BaseData/retro-board/security-fixes-20261124-36yGbT).

All 22 browser checks passed on the same candidate. The first run passed 17. Five standalone checks rejected a directory supplied as the optional Playwright module override. An overlapping retry also found the shared fixture port occupied. All five passed with the default module lookup after the first runner exited. The successful runs are under `live/` and `live-default/`.

All checks ran with conflicting synthetic shell settings. The external directory was never created. All 16 public relays created private run-owned storage and logged zero orphan removals. None of the 88 newly generated report, summary or captured console files from successful runs contained a token-bearing board or poker URL. Historical artifacts remain as originally recorded.

The two-context UI check passed all 19 steps, including room creation and joining, sync in both directions, independent undo and redo, and Thai and English rendering. It recorded zero page errors. Its standalone fixture, which disables accounts and runs without a public relay, recorded 14 account HTTP 404s and seven public-snapshot HTTP 502s. The fixtures with a public relay passed their checks. Verification covered the local candidate and its images. Production rollout remains an owner action.

## Production rollout on 24 November

At 13:50 Bangkok time the operator began deploying `37d5ecd` to `retroroom.party`. The application and image inputs match the tested commit `74a514d`. Immediately before rollout the repository scanner passed again on the exact image IDs. The official backup and verification scripts confirmed that both databases and their uploads could be restored from the encrypted archive.

The existing Compose project `miro` switched the public relay, private relay, web and both cloudflared connectors one service at a time to the `security-37d5ecd` image tags. Both relays passed their health checks, and each connector registered four tunnel connections. One edge request returned HTTP 530 during the final connector switch and its retry succeeded. The pre- and post-rollout room counts matched at 237 private and one public, measured before creating the smoke-test room. The Public Wall snapshot checksum matched. The observed storage mounts, network configuration and container restrictions matched their previous values.

Through the public hostname, two fresh browser contexts created and joined a private guest room, synchronized edits both ways, observed undo and redo, and uploaded and decoded a PNG on the peer. An invalid invite to that room received HTTP 404 and opened zero board sockets. The public site served the JavaScript bytes from the expected web image. The browser reported zero page errors. Its console recorded signed-out HTTP 401 responses and third-party script loads blocked by the existing content security policy.

The [deployment evidence](/Volumes/ssd-fluke/BaseData/retro-board/release-20261124-security-pjaxD4) includes the signed-off image IDs, service state, HTTP and browser results, verified backup log and the previous image mapping in `rollback.yml`. The one-shot volume initializer and the separate gateway containers retained their container IDs.

## RULE CONFORMANCE

- Code shape — PASS. Both fixture recipes set their own storage and host. Report writers share one redaction function.
- Tests — PASS. The five new regression cases failed before the fixes and passed afterward. All 3,007 unit tests and 22 browser checks passed.
- Logging and disk writes — PASS. The saved diagnostics preserve the room path and failure context. The synthetic token was absent from the saved success and failure cases.
- Data location — PASS. The verified child relays used their run directories on the mounted fast data volume.
- Karpathy guidelines — PASS. Changes cover the three agreed findings against the audited baseline.
- Repo style — PASS. The pinned repo scanner passed the source, container configuration and four image checks.
- Failure-path tests — PASS. Conflicting fixture settings, nested results, standalone CLI errors and embedded room URLs are covered.
