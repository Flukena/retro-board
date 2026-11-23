# Fix the three security findings on RetroBoard main

Baseline: `09b7ef7`. The [security review](../reviews/2026-11-23-refactor-security-review.md) records one failed release gate and two live-check findings. Implement the following as three independently verifiable changes. The tunnel build can run alongside the harness work. Run the browser suite after both harness fixes land.

## 1. Update the dependency compiled into cloudflared

- Use the baseline image scan showing CVE-2026-78661 as the failing check. In `Dockerfile.cloudflared`, pin `golang.org/x/net` to `v0.62.0`. Its module manifest requires `golang.org/x/crypto v0.58.0`, above the Dockerfile's current exact `v0.57.0` assertion. Review the resolved graph and align both pins and version assertions. The pinned Go 1.26.10 builder satisfies the module's Go 1.26.0 minimum. [Go advisory](https://pkg.go.dev/vuln/GO-2026-6860) · [Upstream module manifest](https://proxy.golang.org/golang.org/x/net/@v/v0.62.0.mod)
- Resolve dependencies from the pinned upstream cloudflared source in the existing builder. Inspect the changes to `go.mod` and `go.sum`, run `go mod verify`, and update their two SHA-256 checks in the Dockerfile from those reviewed files. Advance the local OCI security revision from `security.5` to `security.6`.
- **Pass when** a clean build verifies the hashes and versions, the resulting binary starts with `cloudflared version`, and the repo scanner reports zero High or Critical findings for that image ID.

## 2. Isolate both relays before running browser checks

- Add a failing configuration test in `scripts/live-check-common.test.mjs` using synthetic parent values for `YJS_HOST`, `YJS_DB_DIR` and `YJS_UPLOADS_DIR`. Exercise the effective child settings with the production merge order in `scripts/live-check-process.mjs`. This test only needs the service recipes and environment merge.
- In `scripts/live-check-common.mjs`, set both relay listeners to `127.0.0.1` and give the public relay an explicit uploads path. Use the current per-run names `db`, `uploads`, `public-db` and `public-db-uploads`. Make these three settings take precedence over inherited values and the manifest's optional relay settings. Preserve the existing test-specific TTL, rate-limit and OIDC settings.
- **Pass when** both relays resolve to loopback and their own distinct database and uploads directories inside the run folder, even with conflicting synthetic settings. Exercise the public-wall and room-management recipes to confirm their expected configuration still works.

## 3. Keep room capabilities out of live-check diagnostics

- Test both reporting paths, `scripts/board-live-helpers.mjs` and `scripts/ui-live-check.mjs`, with the same synthetic room URL. Cover a successful join, a nested step result, and an error containing the URL. On the baseline, show the synthetic token reaches a saved report. Assert against the final serialized output and captured console errors.
- Keep the full URL in memory for participant B's navigation. Give both reporters a shared fragment-redaction function at the point where diagnostics are written or printed. Apply it to report values and error messages that reach `check-stdout.log` or `check-stderr.log`. Preserve the room path, step name, verdict and diagnostic context. Update the stale header in `scripts/ui-live-check.mjs`.
- **Pass when** the second participant can still join, and the synthetic capability is absent from both reporters' saved JSON and captured output on success and failure. Include an ordinary URL and unrelated text as controls.

## Release verification and handoff

1. From a clean candidate checkout, run the [release gate](../../../DEPLOYMENT.md#release-gate) with Node 24. Install from the lockfile, run the full tests, build the client, run the npm audit, validate Compose, rebuild all four images with `--pull --no-cache` and run `scripts/scan-production-images.sh`. Use isolated candidate image tags and record the scanned IDs.
2. Run all 22 manifest checks with `scripts/live-check-all.mjs` in a fresh task folder on the mounted fast data volume. Verify the two-browser flow covers joins, edits in both directions, undo/redo, and Thai and English. Check newly generated report and console artifacts locally and record verdicts without copying room capabilities.
3. Close each review finding with the before/after test or scan and its evidence path. Release acceptance requires a passing test suite, successful live checks, and zero High or Critical findings across cloudflared, yjs, web and volume-init. Production rollout is a separate owner decision under the repository rules.
