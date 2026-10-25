# Public Wall deployment proposal — 2026-10-20

Owner review required. These are proposed changes only; no production configuration,
backup scripts, tunnel credentials or services were changed. No deploy was run.

The existing Node 24 relay image includes both modes and the restore CLI. The
public relay uses the same Dockerfile with its own process, named data volume,
traffic budgets and 768 MiB memory limit. There are no published host ports.
Uploads remain disabled; their unused directory is inside the public data volume.
The anonymous preview and writer session routes remain same-origin, so the
existing CSP does not need a change. Put the public tunnel route before the web
catch-all. The private `/yjs` regex does not match `/yjs-public`.

The database quota and history budget do not overlap. Public database measurement
excludes only the root `snapshots/` directory. `YJS_MAX_DB_BYTES` defaults to
256 MiB for database/other relay data; `PUBLIC_BACKUP_MAX_TOTAL_BYTES` separately
caps retained encoded history at 256 MiB. History removes the oldest files before
writing to reserve incoming bytes and again after publication; both the 48-file
ceiling and byte ceiling apply. A large wall may retain fewer than 48 recovery
points. Interrupted snapshot temp files are removed before the next write. Budget
at least 512 MiB plus filesystem/LevelDB overhead for the public volume; history
cannot trip the database quota by accumulating snapshots.

## Owner action: Cloudflare Cache Rule

Before exposing the preview, configure a **Cloudflare Cache Rule** matching:

```text
(http.host eq "retro.sagonzis.space" and http.request.uri.path eq "/yjs-public/api/snapshot")
```

Set cache eligibility to **Eligible for cache**. Respect the origin cache TTL:
choose Edge TTL **Use cache-control header if present, use default Cloudflare
caching behavior if not** (`respect_origin`), and leave Browser TTL respecting
existing headers. The relay emits `Cache-Control: public, max-age=10`. Do not
apply this rule to session, room or upload routes. Verify a MISS followed by HIT
and an Age no greater than the origin TTL through the public hostname.

Cloudflare does not cache this extensionless JSON route by default; the public
header alone is insufficient. Without the rule, the relay still serves the
snapshot from its **in-memory serialized cache**, rebuilding only on changed
document state at most every ten seconds, but viewer requests still reach it.
See [default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
and [Cache Rules settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).
This owner action is documented only; no Cloudflare settings were changed.

Apply the following unified diffs only after owner approval. Tunnel diff line
numbers are relative to its `ingress:` block to exclude unrelated tunnel identity.

## docker-compose.prod.yml

```diff
--- a/docker-compose.prod.yml
+++ b/docker-compose.prod.yml
@@ -10,10 +10,11 @@
       context: .
       dockerfile: Dockerfile.volume-init
     user: "0:0"
-    command: ["sh", "-c", "chown -R 1000:1000 /data /uploads"]
+    command: ["sh", "-c", "chown -R 1000:1000 /data /uploads /public-data"]
     volumes:
       - yjs_data:/data
       - yjs_uploads:/uploads
+      - yjs_public_data:/public-data
     read_only: true
     cap_drop: [ALL]
     cap_add: [CHOWN]
@@ -89,6 +90,56 @@
       timeout: 3s
       retries: 3
 
+  yjs-public:
+    env_file:
+      - ./config/room-capacity.env
+    build:
+      context: .
+      dockerfile: Dockerfile.yjs
+    expose:
+      - "1234"
+    volumes:
+      - yjs_public_data:/data
+    environment:
+      - YJS_PUBLIC_WALL=true
+      - YJS_HOST=0.0.0.0
+      - YJS_DB_DIR=/data
+      - YJS_ALLOWED_ORIGINS=https://retro.sagonzis.space
+      - YJS_TRUST_PROXY=true
+      - YJS_MAX_REGISTERED_ROOMS=1
+      - YJS_MAX_CONNECTIONS_PER_ROOM=32
+      - YJS_MAX_DB_BYTES=268435456
+      - YJS_MAX_DOCUMENT_BYTES=33554432
+      - YJS_MAX_ACTIVE_DOCUMENT_BYTES=100663296
+      - YJS_ROOM_COMPACTION_MIN_INTERVAL_MS=60000
+      - YJS_DOCUMENT_REMEASURE_MIN_INTERVAL_MS=60000
+    depends_on:
+      volume-init:
+        condition: service_completed_successfully
+    restart: unless-stopped
+    stop_grace_period: 25s
+    read_only: true
+    tmpfs:
+      - /tmp:rw,noexec,nosuid,nodev,size=32m
+    cap_drop: [ALL]
+    security_opt:
+      - no-new-privileges:true
+    pids_limit: 200
+    mem_limit: 768m
+    cpus: 1.5
+    logging:
+      driver: local
+      options:
+        max-size: "10m"
+        max-file: "3"
+    networks:
+      - app_internal
+    healthcheck:
+      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:1234/readyz"]
+      interval: 30s
+      timeout: 3s
+      retries: 3
+
   web:
     build:
       context: .
@@ -134,6 +185,8 @@
         condition: service_started
       yjs:
         condition: service_healthy
+      yjs-public:
+        condition: service_healthy
     restart: unless-stopped
     read_only: true
     cap_drop: [ALL]
@@ -154,6 +207,7 @@
 volumes:
   yjs_data:
   yjs_uploads:
+  yjs_public_data:
 
 networks:
   app_internal:
```

## cloudflared.prod.yml

```diff
--- a/cloudflared.prod.yml
+++ b/cloudflared.prod.yml
@@ -1,4 +1,9 @@
 ingress:
+  - hostname: retro.sagonzis.space
+    path: ^/yjs-public(/.*)?$
+    service: http://yjs-public:1234
+    originRequest:
+      connectTimeout: 30s
   - hostname: retro.sagonzis.space
     path: ^/yjs(/.*)?$
     service: http://yjs:1234
```

## scripts/backup-production.sh

```diff
--- a/scripts/backup-production.sh
+++ b/scripts/backup-production.sh
@@ -21,10 +21,16 @@
 [[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true ]] || {
   echo 'Yjs must be running before backup' >&2; exit 2;
 }
+public_container_id="$("${compose[@]}" ps -q yjs-public)"
+[[ -n "$public_container_id" && "$(docker inspect --format '{{.State.Running}}' "$public_container_id")" = true ]] || {
+  echo 'Public relay must be running before backup' >&2; exit 2;
+}
+public_volume="$(docker inspect "$public_container_id" | jq -r '.[0].Mounts[] | select(.Destination == "/data") | .Name')"
+[[ -n "$public_volume" ]] || { echo 'Public relay volume not found' >&2; exit 2; }
 data_volume="$(docker inspect "$container_id" | jq -r '.[0].Mounts[] | select(.Destination == "/data") | .Name')"
 uploads_volume="$(docker inspect "$container_id" | jq -r '.[0].Mounts[] | select(.Destination == "/uploads") | .Name')"
 [[ -n "$data_volume" && -n "$uploads_volume" ]] || { echo 'Yjs volumes not found' >&2; exit 2; }
-docker volume inspect "$data_volume" "$uploads_volume" >/dev/null
+docker volume inspect "$data_volume" "$uploads_volume" "$public_volume" >/dev/null
 
 stamp="$(date -u +%Y%m%dT%H%M%SZ)"
 target="$backup_dir/retro-board-$stamp.tar.gpg"
@@ -33,23 +39,23 @@
 stopped=false
 cleanup() {
   if [[ "$stopped" = true ]]; then
-    "${compose[@]}" start yjs >/dev/null || echo 'WARNING: restart Yjs manually' >&2
+    "${compose[@]}" start yjs yjs-public >/dev/null || echo 'WARNING: restart Yjs manually' >&2
   fi
   [[ ! -e "$temp_file" ]] || rm -f -- "$temp_file"
 }
 trap cleanup EXIT
 
-"${compose[@]}" stop yjs
+"${compose[@]}" stop yjs yjs-public
 stopped=true
 docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
-  --user 1000:1000 -v "$data_volume:/data:ro" -v "$uploads_volume:/uploads:ro" \
-  miro-volume-init:latest tar -czf - -C / data uploads |
+  --user 1000:1000 -v "$data_volume:/data:ro" -v "$uploads_volume:/uploads:ro" -v "$public_volume:/public-data:ro" \
+  miro-volume-init:latest tar -czf - -C / data uploads public-data |
   gpg --batch --yes --symmetric --cipher-algo AES256 --compress-algo none \
     --pinentry-mode loopback --passphrase-file "$key_file" --output "$temp_file"
 gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-file "$key_file" "$temp_file" |
   tar -tzf - >/dev/null
 mv -- "$temp_file" "$target"
-"${compose[@]}" start yjs >/dev/null
+"${compose[@]}" start yjs yjs-public >/dev/null
 stopped=false
 trap - EXIT
 echo "$target"
```

## scripts/verify-production-backup.sh

```diff
--- a/scripts/verify-production-backup.sh
+++ b/scripts/verify-production-backup.sh
@@ -12,6 +12,9 @@
   tar -xzf - -C "$scratch"
 [[ -f "$scratch/data/.room-session-key" && -d "$scratch/uploads" ]] || {
   echo 'archive is missing a volume or the session key' >&2; exit 1;
+}
+[[ -f "$scratch/public-data/.public-wall-v1" && -f "$scratch/public-data/.room-session-key" ]] || {
+  echo 'archive is missing public relay data or session key' >&2; exit 1;
 }
 cd "$repo_dir"
 BACKUP_VERIFY_DB_DIR="$scratch/data" node --input-type=module -e '
@@ -28,4 +31,22 @@
     console.log(`restored LevelDB opens; ${names.length} documents decoded`);
   } finally { await persistence.destroy(); }
 '
-echo 'backup restores both volumes and the session key'
+BACKUP_VERIFY_DB_DIR="$scratch/public-data" node --input-type=module -e '
+  import { LeveldbPersistence } from "y-leveldb";
+  const persistence = new LeveldbPersistence(process.env.BACKUP_VERIFY_DB_DIR);
+  try {
+    const names = await persistence.getAllDocNames();
+    if (!Array.isArray(names)) throw new Error("public LevelDB cannot list rooms");
+    let committed = 0;
+    for (const name of names) {
+      if (await persistence.getMeta(name, "retro-room-registration-v1") !== 1) continue;
+      committed += 1;
+      const doc = await persistence.getYDoc(name);
+      if (!doc) throw new Error("public room cannot be decoded");
+      doc.destroy();
+    }
+    if (committed !== 1) throw new Error("public backup must contain one registered room");
+    console.log("public LevelDB opens; one committed room decoded");
+  } finally { await persistence.destroy(); }
+'
+echo 'backup restores private data, uploads, public data and both session keys' 
```

## Release and recovery checks

Run the DEPLOYMENT.md release gate from a clean checkout, including production
image scans and the two-context browser checks in both languages. Add
`yjs-public` to the explicit production build service list; image scanning already
resolves all Compose images. Exercise 32 simultaneous application providers
under the public container limits before release. The new integration suite
also verifies actual socket admission, snapshot continuity, restart identity and
process budget isolation, but does not replace the sustained container load test.

Confirm encrypted backup verification includes all three volumes before exposing
the tunnel route. Use the existing backup workflow with the proposed additions;
never restore into the main relay volume.

After approval, restore by stopping only `yjs-public`, running the included CLI
against the public volume in a one-off container, and restarting only that service.
For example, with a chosen existing snapshot name:

```sh
docker compose -f docker-compose.prod.yml stop yjs-public
docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint node yjs-public /app/scripts/public-wall-restore.mjs /data /data/snapshots/wall-<UTC-epoch-ms>.bin
docker compose -f docker-compose.prod.yml start yjs-public
```

The helper validates the public marker and snapshot location, relies on LevelDB's
exclusive database lock to refuse an active relay, and provisions the complete
restored state into a fresh document/handle through RoomRegistry's marker-last
publication. It quarantines/removes the old room, so its handles and cookies
receive 401/404. Public clients re-establish their session and reload a fresh
Y.Doc after that rejection; they never attach their stale replica to the new
handle. A crash between fresh publication and old-room retirement leaves two
committed rooms and public startup fails closed for operator recovery. Keep an off-volume encrypted
backup before any restore; hourly snapshots live on the same volume.

Optional separate operations note: the existing verifier uses `mktemp -d`.
Before a production verification, point its existing TMPDIR at approved external
scratch storage. No scratch-location edits are included in this Public Wall diff.
