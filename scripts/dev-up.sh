#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ROOT}/.runtime"
mkdir -p "$LOG_DIR"

start_if_missing() {
  local pattern="$1"
  local cmd="$2"
  local log="$3"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo "[skip] already running: $pattern"
    return
  fi
  echo "[start] $pattern"
  nohup bash -lc "$cmd" >"$log" 2>&1 &
}

start_if_missing "node dashboard/index.js" "cd '$ROOT' && node dashboard/index.js" "$LOG_DIR/dashboard.log"
start_if_missing "node collector/index.js" "cd '$ROOT' && node collector/index.js" "$LOG_DIR/collector.log"
start_if_missing "python3 -m http.server 8765" "cd /home/teny/.openclaw/workspace/map && python3 -m http.server 8765 --bind 0.0.0.0" "$LOG_DIR/map.log"

TS_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
if [ -n "$TS_IP" ]; then
  start_if_missing "node scripts/pg-proxy.js" "cd '$ROOT' && PG_PROXY_HOST='$TS_IP' PG_PROXY_PORT='55432' node scripts/pg-proxy.js" "$LOG_DIR/pg-proxy.log"
else
  echo "[skip] pg-proxy: tailscale ip not found"
fi

# one-time refresh: reload today's attendance snapshot after startup
for i in {1..10}; do
  if curl -fsS -m 2 http://127.0.0.1:3100/api/team/status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if curl -fsS -m 5 -X POST http://127.0.0.1:3100/api/attendance/reload-today >/dev/null 2>&1; then
  echo "[ok] attendance reload-today triggered"
else
  echo "[warn] attendance reload-today failed (dashboard not ready or endpoint error)"
fi

echo "[ok] dev services started"
