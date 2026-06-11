#!/usr/bin/env bash
# Start a local reranker-only llama-server (default port 8082).
#
# Loads a cross-encoder reranker (default: bge-reranker-v2-m3) and
# exposes /v1/rerank. Coexists with the main chat llama-server on :8080
# and the embed server on :8081.
#
# Wire to the supervisor by adding a backend entry with
# `"modality": "rerank"` to ~/.qwen-coprocessor-stack/config.json
# pointing at http://localhost:8082/v1.
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
# Models live outside the repo (keeps the plugin source tree small enough for
# a directory-source marketplace install). Override MODELS_DIR to relocate;
# the legacy in-repo $ROOT/models is used as a fallback if a file exists there.
MODELS_DIR="${MODELS_DIR:-$HOME/.qwen-coprocessor-stack/models}"
RERANK_FILE="${RERANK_FILE:-bge-reranker-v2-m3-Q8_0.gguf}"
RERANK_PATH="$MODELS_DIR/$RERANK_FILE"
[ -f "$RERANK_PATH" ] || { [ -f "$ROOT/models/$RERANK_FILE" ] && RERANK_PATH="$ROOT/models/$RERANK_FILE"; }
RERANK_ALIAS="${RERANK_ALIAS:-bge-reranker-v2-m3}"
RERANK_PORT="${RERANK_PORT:-8082}"

[ -x "$LLAMA_BIN" ] || { echo "[!] llama-server not built. Run scripts/setup-mac-host.sh first."; exit 1; }
[ -f "$RERANK_PATH" ] || {
  echo "[!] Reranker model not present at $RERANK_PATH."
  echo "    Fetch with:"
  echo "      hf download gpustack/bge-reranker-v2-m3-GGUF $RERANK_FILE --local-dir $MODELS_DIR"
  echo "    Or override RERANK_FILE=… to point at another reranker GGUF."
  exit 1
}

PIDFILE="$LOGS/llama-rerank.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "[+] llama-server (rerank) already running (pid $(cat "$PIDFILE"))"
else
  echo "[*] Starting llama-server (rerank) on :$RERANK_PORT ..."
  # --reranking implies --embedding + --pooling rank (llama.cpp flag
  # surface). Most cross-encoder GGUFs need this to expose /v1/rerank.
  "$LLAMA_BIN" \
    -m "$RERANK_PATH" \
    --alias "$RERANK_ALIAS" \
    --reranking \
    -ngl 99 \
    -c 8192 \
    --port "$RERANK_PORT" --host 0.0.0.0 \
    > "$LOGS/gpu/llama-rerank.log" 2>&1 &
  echo $! > "$PIDFILE"

  WAIT_SECS="${RERANK_HEALTH_WAIT_SECS:-120}"
  echo "[*] Waiting up to ${WAIT_SECS}s for rerank server health..."
  deadline=$(( $(date +%s) + WAIT_SECS ))
  while true; do
    if curl -sf "http://localhost:$RERANK_PORT/health" >/dev/null; then
      echo "[+] rerank server healthy"
      break
    fi
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "[!] rerank server died during startup"
      tail -n 30 "$LOGS/gpu/llama-rerank.log"
      exit 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "[!] timeout after ${WAIT_SECS}s"
      tail -n 30 "$LOGS/gpu/llama-rerank.log"
      exit 1
    fi
    sleep 2
  done
fi

cat <<EOF

[+] rerank server up at http://localhost:$RERANK_PORT.

Smoke-test the endpoint directly:

    curl -s http://localhost:$RERANK_PORT/v1/rerank \\
      -H 'Content-Type: application/json' \\
      -d '{
        "model":"$RERANK_ALIAS",
        "query":"what is a panda?",
        "documents":["the giant panda is a bear","pancakes are fluffy"]
      }' | jq

Wire it to the supervisor by adding to ~/.qwen-coprocessor-stack/config.json:

    {
      "id": "rerank-local",
      "url": "http://localhost:$RERANK_PORT/v1",
      "model": "$RERANK_ALIAS",
      "tier": "local",
      "capacity": "fast",
      "modality": "rerank"
    }
EOF
