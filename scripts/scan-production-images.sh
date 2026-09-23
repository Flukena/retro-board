#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$(dirname -- "$script_dir")"

compose_file=${COMPOSE_FILE:-docker-compose.prod.yml}
trivy_image='aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969'
cache_volume=${TRIVY_CACHE_VOLUME:-retroboard-trivy-cache}

printf 'Scanning source tree for secrets\n'
docker run --rm \
  -v "$PWD:/workspace:ro" \
  -v "$cache_volume:/root/.cache/" \
  "$trivy_image" fs \
  --disable-telemetry \
  --scanners secret \
  --skip-dirs /workspace/node_modules \
  --skip-dirs /workspace/.git \
  --skip-dirs /workspace/dist \
  --skip-dirs /workspace/.playwright-cli \
  --exit-code 1 \
  --no-progress \
  /workspace

printf 'Scanning container build configuration\n'
docker run --rm \
  -v "$PWD:/workspace:ro" \
  -v "$cache_volume:/root/.cache/" \
  "$trivy_image" config \
  --disable-telemetry \
  --file-patterns 'dockerfile:.*Dockerfile.*' \
  --skip-dirs /workspace/node_modules \
  --skip-dirs /workspace/.git \
  --skip-dirs /workspace/dist \
  --severity HIGH,CRITICAL \
  --exit-code 1 \
  /workspace

images=$(docker compose -f "$compose_file" config --images)
if [ -z "$images" ]; then
  printf 'No production images were resolved from %s\n' "$compose_file" >&2
  exit 1
fi

printf '%s\n' "$images" | while IFS= read -r image; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf 'Production image is not built locally: %s\n' "$image" >&2
    exit 1
  fi

  printf 'Scanning %s\n' "$image"
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$cache_volume:/root/.cache/" \
    "$trivy_image" image \
    --disable-telemetry \
    --scanners vuln \
    --pkg-types os,library \
    --severity HIGH,CRITICAL \
    --exit-code 1 \
    --no-progress \
    "$image"
done
