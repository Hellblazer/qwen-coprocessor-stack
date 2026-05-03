#!/usr/bin/env bash
# Stop the LiteLLM proxy and the local llama-server cleanly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT/logs/llama-server.pid"

echo "[*] Stopping LiteLLM ..."
( cd "$ROOT" && docker compose down --remove-orphans ) || true

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "[*] Stopping llama-server (pid $PID) ..."
    kill "$PID" || true
    for _ in {1..20}; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

echo "[+] Stopped."
