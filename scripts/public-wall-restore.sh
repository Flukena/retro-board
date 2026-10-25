#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node "$repo_dir/scripts/public-wall-restore.mjs" "$@"
