#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f /workspaces/.codespaces/shared/.env ]]; then
  set -a
  source /workspaces/.codespaces/shared/.env
  set +a
fi

if [[ -z "${AMAP_MAPS_API_KEY:-}" || -z "${FLYAI_API_KEY:-}" ]]; then
  echo "Codespaces secrets are missing; service was not started." >&2
  exit 1
fi

flyai config set FLYAI_API_KEY "$FLYAI_API_KEY" >/dev/null

if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  exit 0
fi

setsid env HOST=0.0.0.0 PORT=8787 AMAP_MAPS_API_KEY="$AMAP_MAPS_API_KEY" npm start </dev/null > /tmp/xingji.log 2>&1 &
