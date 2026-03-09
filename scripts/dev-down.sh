#!/usr/bin/env bash
set -euo pipefail

pkill -f "node dashboard/index.js" >/dev/null 2>&1 || true
pkill -f "node collector/index.js" >/dev/null 2>&1 || true
pkill -f "python3 -m http.server 8765" >/dev/null 2>&1 || true

echo "[ok] dev services stopped"
