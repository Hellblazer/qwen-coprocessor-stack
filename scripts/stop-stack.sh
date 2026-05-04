#!/usr/bin/env bash
# Stop the local llama-server cleanly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

stop_pidfile() {
  local label="$1" pidfile="$2"
  if [ -f "$pidfile" ]; then
    local pid; pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "[*] Stopping $label (pid $pid) ..."
      kill "$pid" || true
      for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

stop_pidfile "llama-server"  "$ROOT/logs/llama-server.pid"

echo "[+] Stopped."
