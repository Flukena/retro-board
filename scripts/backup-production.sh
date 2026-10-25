#!/usr/bin/env bash
set -euo pipefail

# Usage: BACKUP_KEY_FILE=/absolute/path/to/key ./scripts/backup-production.sh /absolute/backup/dir
# All databases and uploads are captured while both relays are stopped so they
# represent the same point in time. The original Yjs container is restarted
# even if archiving or encryption fails.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
backup_dir="${1:?pass an absolute backup directory}"
key_file="${BACKUP_KEY_FILE:?set BACKUP_KEY_FILE to an existing passphrase file}"
[[ "$backup_dir" = /* && "$key_file" = /* ]] || { echo 'paths must be absolute' >&2; exit 2; }
[[ -f "$key_file" && -r "$key_file" ]] || { echo 'backup key is not readable' >&2; exit 2; }
[[ "$(stat -f %Lp "$key_file")" = 600 ]] || { echo 'backup key must have mode 600' >&2; exit 2; }
mkdir -p "$backup_dir"
backup_dir="$(cd "$backup_dir" && pwd -P)"
case "$backup_dir" in "$repo_dir"|"$repo_dir"/*) echo 'backup directory must be outside the repository' >&2; exit 2;; esac

compose=(docker compose -f "$repo_dir/docker-compose.prod.yml")
container_id="$("${compose[@]}" ps -q yjs)"
[[ -n "$container_id" ]] || { echo 'Yjs container not found' >&2; exit 2; }
[[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = true ]] || {
  echo 'Yjs must be running before backup' >&2; exit 2;
}
public_container_id="$("${compose[@]}" ps -q yjs-public)"
[[ -n "$public_container_id" && "$(docker inspect --format '{{.State.Running}}' "$public_container_id")" = true ]] || {
  echo 'Public relay must be running before backup' >&2; exit 2;
}
public_volume="$(docker inspect "$public_container_id" | jq -r '.[0].Mounts[] | select(.Destination == "/data") | .Name')"
[[ -n "$public_volume" ]] || { echo 'Public relay volume not found' >&2; exit 2; }
public_uploads_source="$(docker inspect "$public_container_id" | jq -r '.[0].Mounts[] | select(.Destination == "/uploads" and .Type == "bind") | .Source')"
[[ "$public_uploads_source" = /Volumes/ssd-fluke/BaseData/* && -d "$public_uploads_source" ]] || {
  echo 'Public uploads must be mounted from the operator SSD' >&2; exit 2;
}
data_volume="$(docker inspect "$container_id" | jq -r '.[0].Mounts[] | select(.Destination == "/data") | .Name')"
uploads_volume="$(docker inspect "$container_id" | jq -r '.[0].Mounts[] | select(.Destination == "/uploads") | .Name')"
[[ -n "$data_volume" && -n "$uploads_volume" ]] || { echo 'Yjs volumes not found' >&2; exit 2; }
docker volume inspect "$data_volume" "$uploads_volume" "$public_volume" >/dev/null

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/retro-board-$stamp.tar.gpg"
[[ ! -e "$target" ]] || { echo 'backup filename already exists' >&2; exit 2; }
temp_file="$(mktemp "$backup_dir/.retro-board-$stamp.XXXXXX")"
stopped=false
cleanup() {
  if [[ "$stopped" = true ]]; then
    "${compose[@]}" start yjs yjs-public >/dev/null || echo 'WARNING: restart Yjs manually' >&2
  fi
  [[ ! -e "$temp_file" ]] || rm -f -- "$temp_file"
}
trap cleanup EXIT

"${compose[@]}" stop yjs yjs-public
stopped=true
docker run --rm --log-driver none --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user 1000:1000 -v "$data_volume:/data:ro" -v "$uploads_volume:/uploads:ro" -v "$public_volume:/public-data:ro" \
  -v "$public_uploads_source:/public-uploads:ro" \
  miro-volume-init:latest tar -czf - -C / data uploads public-data public-uploads |
  gpg --batch --yes --symmetric --cipher-algo AES256 --compress-algo none \
    --pinentry-mode loopback --passphrase-file "$key_file" --output "$temp_file"
gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-file "$key_file" "$temp_file" |
  tar -tzf - >/dev/null
mv -- "$temp_file" "$target"
"${compose[@]}" start yjs yjs-public >/dev/null
stopped=false
trap - EXIT
echo "$target"
