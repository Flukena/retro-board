#!/usr/bin/env bash
set -euo pipefail

archive="${1:?pass an absolute .tar.gpg archive path}"
key_file="${BACKUP_KEY_FILE:?set BACKUP_KEY_FILE to the passphrase file}"
[[ "$archive" = /* && "$key_file" = /* ]] || { echo 'paths must be absolute' >&2; exit 2; }
[[ -f "$archive" && -f "$key_file" ]] || { echo 'archive or key file missing' >&2; exit 2; }
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
gpg --batch --quiet --decrypt --pinentry-mode loopback --passphrase-file "$key_file" "$archive" |
  tar -xzf - -C "$scratch"
[[ -f "$scratch/data/.room-session-key" && -d "$scratch/uploads" ]] || {
  echo 'archive is missing a volume or the session key' >&2; exit 1;
}
[[ -f "$scratch/public-data/.public-wall-v1" && -f "$scratch/public-data/.room-session-key" ]] || {
  echo 'archive is missing public relay data or session key' >&2; exit 1;
}
cd "$repo_dir"
for database in data public-data; do
BACKUP_VERIFY_DB_DIR="$scratch/$database" BACKUP_VERIFY_MODE="$database" BACKUP_VERIFY_PUBLIC_UPLOADS="$scratch/public-uploads" node --input-type=module -e '
  import { LeveldbPersistence } from "y-leveldb";
  import { ROOM_REGISTRATION_META } from "./src/server/relay-room-registry.js";
  import { verifyPublicUploadFiles } from "./src/server/public-upload-backup.js";
  const persistence = new LeveldbPersistence(process.env.BACKUP_VERIFY_DB_DIR);
  try {
    const names = await persistence.getAllDocNames();
    if (!Array.isArray(names)) throw new Error("restored LevelDB cannot list rooms");
    const isPublic = process.env.BACKUP_VERIFY_MODE === "public-data";
    const PUBLIC_REGISTERED_ROOM_COUNT = 1;
    const REGISTERED_META_VALUE = 1;
    let committed = 0;
    for (const name of names) {
      if (isPublic && await persistence.getMeta(name, ROOM_REGISTRATION_META) !== REGISTERED_META_VALUE) continue;
      committed += 1;
      const doc = await persistence.getYDoc(name);
      if (!doc) throw new Error("restored room cannot be decoded");
      try {
        if (isPublic) await verifyPublicUploadFiles(doc, process.env.BACKUP_VERIFY_PUBLIC_UPLOADS);
      } finally { doc.destroy(); }
    }
    if (isPublic && committed !== PUBLIC_REGISTERED_ROOM_COUNT) {
      throw new Error("public backup must contain exactly one registered room");
    }
    console.log(`restored ${process.env.BACKUP_VERIFY_MODE} LevelDB opens; ${committed} documents decoded`);
  } finally { await persistence.destroy(); }
'
done
echo 'backup restores private data/uploads, public data/uploads and both session keys'
