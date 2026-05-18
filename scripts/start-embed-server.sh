#!/usr/bin/env bash
# Start a local embedding-only llama-server (default port 8081).
#
# Loads an embedding model (default: bge-m3 — multilingual, 1024-dim,
# well-supported by llama.cpp) and exposes /v1/embeddings. Coexists
# with the main chat llama-server on :8080 — they're separate processes.
#
# Wire to the supervisor by adding a backend entry with
# `"modality": "embedding"` to ~/.qwen-coprocessor-stack/config.json
# pointing at http://localhost:8081/v1. See
# docs/integrations/embed-rerank-tokenize.md.
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
EMBED_FILE="${EMBED_FILE:-bge-m3-Q8_0.gguf}"
EMBED_PATH="$ROOT/models/$EMBED_FILE"
EMBED_ALIAS="${EMBED_ALIAS:-bge-m3}"
EMBED_PORT="${EMBED_PORT:-8081}"

[ -x "$LLAMA_BIN" ] || { echo "[!] llama-server not built. Run scripts/setup-mac-host.sh first."; exit 1; }
[ -f "$EMBED_PATH" ] || {
  echo "[!] Embedding model not present at $EMBED_PATH."
  echo "    Fetch with:"
  echo "      huggingface-cli download gpustack/bge-m3-GGUF $EMBED_FILE --local-dir $ROOT/models"
  echo "    Or override EMBED_FILE=… to point at another GGUF you already have."
  exit 1
}

PIDFILE="$LOGS/llama-embed.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "[+] llama-server (embed) already running (pid $(cat "$PIDFILE"))"
else
  echo "[*] Starting llama-server (embed) on :$EMBED_PORT ..."
  "$LLAMA_BIN" \
    -m "$EMBED_PATH" \
    --alias "$EMBED_ALIAS" \
    --embedding \
    --pooling mean \
    -ngl 99 \
    -c 8192 \
    --port "$EMBED_PORT" --host 0.0.0.0 \
    > "$LOGS/gpu/llama-embed.log" 2>&1 &
  echo $! > "$PIDFILE"

  WAIT_SECS="${EMBED_HEALTH_WAIT_SECS:-120}"
  echo "[*] Waiting up to ${WAIT_SECS}s for embed server health..."
  deadline=$(( $(date +%s) + WAIT_SECS ))
  while true; do
    if curl -sf "http://localhost:$EMBED_PORT/health" >/dev/null; then
      echo "[+] embed server healthy"
      break
    fi
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "[!] embed server died during startup"
      tail -n 30 "$LOGS/gpu/llama-embed.log"
      exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "[!] timeout after ${WAIT_SECS}s"
      tail -n 30 "$LOGS/gpu/llama-embed.log"
      exit 1
    fi
    sleep 2
  done
fi

cat <<EOF

[+] embed server up at http://localhost:$EMBED_PORT.

Smoke-test the endpoint directly:

    curl -s http://localhost:$EMBED_PORT/v1/embeddings \\
      -H 'Content-Type: application/json' \\
      -d '{"model":"$EMBED_ALIAS","input":"hello world"}' \\
      | jq '.data[0].embedding | length'

Wire it to the supervisor by adding to ~/.qwen-coprocessor-stack/config.json:

    {
      "id": "embed-local",
      "url": "http://localhost:$EMBED_PORT/v1",
      "model": "$EMBED_ALIAS",
      "tier": "local",
      "capacity": "fast",
      "modality": "embedding"
    }

Then call qwen_embed from any MCP client — the supervisor hot-reloads
config on each request.
EOF
