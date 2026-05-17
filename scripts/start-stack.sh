#!/usr/bin/env bash
# Start the local llama-server (M4 Max Metal-accelerated Qwen 3.6 27B).
# Claude Code talks to it via the qwen-agent-server MCP supervisor; see
# mcp-bridges/qwen-agent-server/README.md for registration.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS/gpu"

if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$ROOT/.env"; set +a
fi

LLAMA_DIR="${LLAMA_DIR:-$HOME/src/llama.cpp}"
LLAMA_BIN="$LLAMA_DIR/build/bin/llama-server"
HF_FILE="${HF_FILE:-Qwen3.6-27B-UD-Q6_K_XL.gguf}"
MODEL_PATH="$ROOT/models/$HF_FILE"
MODEL_ALIAS="${MODEL_ALIAS:-qwen3.6-27b-instruct}"
# Vision projector (RDR-005, v0.10): when present, llama-server enables
# multimodal (image+text → text) on /v1/chat/completions. Optional —
# unset MMPROJ_FILE or remove the file to revert to text-only.
MMPROJ_FILE="${MMPROJ_FILE:-mmproj-Qwen3.6-27B-F16.gguf}"
MMPROJ_PATH="$ROOT/models/$MMPROJ_FILE"

[ -x "$LLAMA_BIN" ] || { echo "[!] llama-server not built. Run scripts/setup-mac-host.sh first."; exit 1; }
[ -f "$MODEL_PATH" ] || { echo "[!] Model not present at $MODEL_PATH. Run scripts/setup-mac-host.sh first."; exit 1; }

PIDFILE="$ROOT/logs/llama-server.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "[+] llama-server already running (pid $(cat "$PIDFILE"))"
else
  MMPROJ_ARGS=()
  if [ -f "$MMPROJ_PATH" ]; then
    echo "[*] Vision projector found at $MMPROJ_PATH — enabling multimodal."
    MMPROJ_ARGS=(--mmproj "$MMPROJ_PATH")
  else
    echo "[i] No vision projector at $MMPROJ_PATH — text-only mode."
  fi

  echo "[*] Starting llama-server on :8080 ..."
  "$LLAMA_BIN" \
    -m "$MODEL_PATH" \
    "${MMPROJ_ARGS[@]}" \
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

cat <<EOF

[+] llama-server up at http://localhost:8080.

Claude Code reaches it through the qwen-agent-server MCP supervisor.
Register it once with:

    claude mcp add --scope user qwen-agent-server \\
      node $ROOT/mcp-bridges/qwen-agent-server/dist/server.js

Or run scripts/setup-qwen-agent-server.sh to build + register in one go.
EOF
