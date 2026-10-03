#!/bin/bash
# Cloud sessions only: install dependencies and start a Docker daemon so the
# Docker runner can be checked against a real container (npm run verify:docker).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm ci --no-audit --no-fund >&2

if command -v dockerd >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  setsid nohup dockerd >/tmp/dockerd.log 2>&1 < /dev/null &
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi

image="${VERIFY_DOCKER_IMAGE:-debian:bookworm-slim}"
if docker info >/dev/null 2>&1; then
  docker image inspect "$image" >/dev/null 2>&1 \
    || docker pull --quiet "$image" >/dev/null \
    || echo "session-start: could not pull the verify:docker image; it will be pulled on first use" >&2
else
  echo "session-start: Docker daemon did not start; see /tmp/dockerd.log" >&2
fi
