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

  echo -n "[*] Waiting for llama-server health"
  for i in {1..60}; do
    if curl -sf http://localhost:8080/health >/dev/null; then echo " ok"; break; fi
    echo -n "."
    [ "$i" -eq 60 ] && { echo " FAIL"; tail -n 50 "$LOGS/gpu/llama-server.log"; exit 1; }
    sleep 2
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
