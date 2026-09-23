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
cd "$repo_dir"
BACKUP_VERIFY_DB_DIR="$scratch/data" node --input-type=module -e '
  import { LeveldbPersistence } from "y-leveldb";
  const persistence = new LeveldbPersistence(process.env.BACKUP_VERIFY_DB_DIR);
  try {
    const names = await persistence.getAllDocNames();
    if (!Array.isArray(names)) throw new Error("restored LevelDB cannot list rooms");
    for (const name of names) {
      const doc = await persistence.getYDoc(name);
      if (!doc) throw new Error("restored room cannot be decoded");
      doc.destroy();
    }
    console.log(`restored LevelDB opens; ${names.length} documents decoded`);
  } finally { await persistence.destroy(); }
'
echo 'backup restores both volumes and the session key'
