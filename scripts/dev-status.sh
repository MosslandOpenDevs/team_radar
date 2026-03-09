#!/usr/bin/env bash
set -euo pipefail

printf "%-12s %-8s %s\n" "service" "status" "detail"

check() {
  local name="$1"
  local pattern="$2"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    printf "%-12s %-8s %s\n" "$name" "UP" "$pattern"
  else
    printf "%-12s %-8s %s\n" "$name" "DOWN" "$pattern"
  fi
}

check dashboard "node dashboard/index.js"
check collector "node collector/index.js"
check map "python3 -m http.server 8765"
check pg-proxy "node scripts/pg-proxy.js"

echo
curl -m 3 -s -o /dev/null -w "dashboard_http:%{http_code}\n" http://127.0.0.1:3100/dashboard || true
curl -m 3 -s -o /dev/null -w "status_api:%{http_code}\n" http://127.0.0.1:3100/api/team/status || true
curl -m 3 -s -o /dev/null -w "map_http:%{http_code}\n" http://127.0.0.1:8765/composed_set_map.html || true
