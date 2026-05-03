#!/usr/bin/env bash
# Start the M4 Max workhorse llama-server and the LiteLLM proxy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS/gpu" "$LOGS/litellm"

[ -f "$ROOT/.env" ] || { echo "[!] $ROOT/.env missing. Copy .env.example and fill in."; exit 1; }
# shellcheck disable=SC1091
set -a; . "$ROOT/.env"; set +a

LLAMA_DIR="${LLAMA_DIR:-$HOME/src/llama.cpp}"
LLAMA_BIN="$LLAMA_DIR/build/bin/llama-server"
HF_FILE="${HF_FILE:-Qwen3.6-27B-UD-Q6_K_XL.gguf}"
MODEL_PATH="$ROOT/models/$HF_FILE"
MODEL_ALIAS="${MODEL_ALIAS:-qwen3.6-27b-instruct}"

[ -x "$LLAMA_BIN" ] || { echo "[!] llama-server not built. Run scripts/setup-mac-host.sh first."; exit 1; }
[ -f "$MODEL_PATH" ] || { echo "[!] Model not present at $MODEL_PATH. Run scripts/setup-mac-host.sh first."; exit 1; }
command -v docker >/dev/null || { echo "[!] Docker required."; exit 1; }

PIDFILE="$ROOT/logs/llama-server.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "[+] llama-server already running (pid $(cat "$PIDFILE"))"
else
  echo "[*] Starting llama-server on :8080 ..."
  "$LLAMA_BIN" \
    -m "$MODEL_PATH" \
    --alias "$MODEL_ALIAS" \
    -ngl 99 \
    -c 65536 \
    --cache-type-k q8_0 \
    --cache-type-v q8_0 \
    --temp 0.6 --top-p 0.95 \
    --port 8080 --host 0.0.0.0 \
    > "$LOGS/gpu/llama-server.log" 2>&1 &
  echo $! > "$PIDFILE"

  # Cold start of a 27B Q6 GGUF off USB-C external storage can take several
  # minutes to mmap and warm into Metal. Allow up to ~10 min before giving up.
  WAIT_SECS="${LLAMA_HEALTH_WAIT_SECS:-600}"
  echo "[*] Waiting up to ${WAIT_SECS}s for llama-server health (24 GB model load)..."
  deadline=$(( $(date +%s) + WAIT_SECS ))
  while true; do
    if curl -sf http://localhost:8080/health >/dev/null; then
      echo "[+] llama-server healthy"
      break
    fi
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "[!] llama-server died during startup"
      tail -n 50 "$LOGS/gpu/llama-server.log"
      exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "[!] timeout after ${WAIT_SECS}s — llama-server still loading?"
      echo "    Increase with LLAMA_HEALTH_WAIT_SECS=900 ./scripts/start-stack.sh"
      tail -n 30 "$LOGS/gpu/llama-server.log"
      exit 1
    fi
    sleep 3
  done
fi

# --- claude-shim (subscription-billed escalation backend) ---
SHIM_PIDFILE="$LOGS/claude-shim.pid"
SHIM_BIN="$ROOT/mcp-bridges/claude-shim/server.py"
if [ -f "$SHIM_PIDFILE" ] && kill -0 "$(cat "$SHIM_PIDFILE")" 2>/dev/null; then
  echo "[+] claude-shim already running (pid $(cat "$SHIM_PIDFILE"))"
elif [ ! -x "$SHIM_BIN" ]; then
  echo "[!] $SHIM_BIN not executable; skipping claude-shim. claude-escalation will fail."
elif ! command -v uv >/dev/null; then
  echo "[!] uv not on PATH; skipping claude-shim. Install uv (https://docs.astral.sh/uv/) to enable."
else
  echo "[*] Starting claude-shim on :9000 ..."
  "$SHIM_BIN" > "$LOGS/claude-shim.log" 2>&1 &
  echo $! > "$SHIM_PIDFILE"
  for i in {1..20}; do
    if curl -sf http://127.0.0.1:9000/health >/dev/null; then echo "[+] claude-shim healthy"; break; fi
    if ! kill -0 "$(cat "$SHIM_PIDFILE")" 2>/dev/null; then
      echo "[!] claude-shim died on startup:"; tail -n 20 "$LOGS/claude-shim.log"; exit 1
    fi
    [ "$i" -eq 20 ] && { echo "[!] claude-shim health timeout"; tail -n 20 "$LOGS/claude-shim.log"; exit 1; }
    sleep 0.5
  done
fi

echo "[*] Starting LiteLLM proxy ..."
( cd "$ROOT" && docker compose up -d litellm-proxy )

echo -n "[*] Waiting for LiteLLM health"
for i in {1..30}; do
  if curl -sf http://localhost:4000/health/liveliness >/dev/null; then echo " ok"; break; fi
  echo -n "."
  [ "$i" -eq 30 ] && { echo " FAIL"; docker logs --tail 50 qwen-coprocessor-proxy; exit 1; }
  sleep 2
done

cat <<EOF

[+] Stack up.
    llama-server : http://localhost:8080
    LiteLLM      : http://localhost:4000

To run Claude Code through it:
    source $ROOT/claude-code/env.sh
    claude

Smoke test the model list:
    curl -s http://localhost:4000/v1/models -H "Authorization: Bearer \$LITELLM_MASTER_KEY" | jq .
EOF
