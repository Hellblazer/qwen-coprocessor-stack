#!/usr/bin/env bash
# Keepalive for the Mac-side coprocessor servers (vision-on-mac migration, 2026-06-12).
# Holds, all co-resident on the M4 Max, restarting any that fall over:
#   - vision-mac  (:8083, Qwen2.5-VL-7B  via mlx_vlm)  — MLX, mlx-venv
#   - reason-mac  (:8084, Qwen3.6-35B-A3B via mlx_lm)  — MLX, mlx-venv
#   - embed-local (:8081, bge-m3)                      — llama.cpp, via start-embed-server.sh
#   - rerank-local(:8082, bge-reranker-v2-m3)          — llama.cpp, via start-rerank-server.sh
# Local processes (no SSH). Run under launchd (KeepAlive) so it survives logout.
#
# WHY: coder-box (coding) stays on the box ALONE; vision + the 35B (general/reasoning) +
# the small embed/rerank servers live here. This split removed the box co-residency that
# crashed coder-box (081/akf). embed/rerank were added to this keepalive (qwen-…-hvr,
# 2026-06-13) because they have no other holder and silently dropped on every Mac reboot.
# The big MLX models load off the external Transcend disk (~94 MB/s) so first start is slow.
set -u
VENV="$HOME/.qwen-coprocessor-stack/mlx-venv"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"  # …/qwen-coprocessor-stack
export HF_HOME="/Volumes/Transcend Hell/hf-cache"
LOGDIR="$HOME/.qwen-coprocessor-stack/logs"; mkdir -p "$LOGDIR"
VISION_MODEL="mlx-community/Qwen2.5-VL-7B-Instruct-4bit"
REASON_MODEL="mlx-community/Qwen3.6-35B-A3B-4bit"
REASON_MAX_TOKENS="${REASON_MAX_TOKENS:-4096}"  # generation-length guardrail for reason-mac (mlx_lm.server has no --max-kv-size; --max-tokens bounds generation -> bounds KV growth since operator prompts are small). Override via env.
VISION_PID=0; REASON_PID=0
up()  { curl -s --max-time 5 "http://localhost:$1/v1/models" 2>/dev/null | grep -q '"object"'; }
uph() { curl -sf --max-time 5 "http://localhost:$1/health" 2>/dev/null | grep -q 'ok'; }  # llama.cpp embed/rerank expose /health, not a model list
log() { echo "$(date '+%H:%M:%S') $*"; }
kpid(){ [ "${1:-0}" -gt 0 ] 2>/dev/null && kill "$1" 2>/dev/null; }
kpidfile(){ local f="$1"; [ -f "$f" ] && kpid "$(cat "$f" 2>/dev/null)"; }
waitup(){ for i in $(seq 1 60); do up "$1" && return 0; sleep 10; done; return 1; }
start_vision() {
  log "starting vision-mac (:8083, $VISION_MODEL)"
  kpid "$VISION_PID"
  "$VENV/bin/mlx_vlm.server" --model "$VISION_MODEL" --host 0.0.0.0 --port 8083 \
    > "$LOGDIR/vision-mac.log" 2>&1 & VISION_PID=$!
  waitup 8083 && log "vision-mac UP" || log "vision-mac FAILED"
}
start_reason() {
  # --max-tokens guardrail: cap generation length so a runaway on this verbose
  # thinking model can't balloon unified memory and pressure vision-mac (the
  # co-residency we engineered away). mlx_lm.server has no --max-kv-size; capping
  # generation bounds KV growth because operator prompts are small. 64K is far
  # above any real answer; the model's native window is 256K (we don't need it).
  log "starting reason-mac (:8084, $REASON_MODEL, max-tokens $REASON_MAX_TOKENS)"
  kpid "$REASON_PID"
  "$VENV/bin/mlx_lm.server" --model "$REASON_MODEL" --host 0.0.0.0 --port 8084 \
    --max-tokens "$REASON_MAX_TOKENS" \
    > "$LOGDIR/reason-mac.log" 2>&1 & REASON_PID=$!
  waitup 8084 && log "reason-mac UP" || log "reason-mac FAILED"
}
# embed-local / rerank-local are llama.cpp servers driven by their own start scripts,
# which self-background, write a pidfile under $REPO_ROOT/logs, wait for /health, and are
# idempotent (a running instance is detected via pidfile, so re-invoking is a no-op). We
# just call them when the port is down; their own llama-server child reparents away, so we
# track shutdown via their pidfiles rather than a PID var.
start_embed() {
  log "starting embed-local (:8081, bge-m3) via start-embed-server.sh"
  bash "$REPO_ROOT/scripts/start-embed-server.sh" >> "$LOGDIR/embed-mac.log" 2>&1 \
    && log "embed-local UP" || log "embed-local start returned nonzero (see embed-mac.log)"
}
start_rerank() {
  log "starting rerank-local (:8082, bge-reranker-v2-m3) via start-rerank-server.sh"
  bash "$REPO_ROOT/scripts/start-rerank-server.sh" >> "$LOGDIR/rerank-mac.log" 2>&1 \
    && log "rerank-local UP" || log "rerank-local start returned nonzero (see rerank-mac.log)"
}
trap 'log "shutdown; killing servers"; kpid "$VISION_PID"; kpid "$REASON_PID"; kpidfile "$REPO_ROOT/logs/llama-embed.pid"; kpidfile "$REPO_ROOT/logs/llama-rerank.pid"; exit 0' TERM INT
log "mac keepalive started (pid $$) — vision-mac + reason-mac + embed-local + rerank-local"
while true; do
  up  8083 || start_vision
  up  8084 || start_reason
  uph 8081 || start_embed
  uph 8082 || start_rerank
  sleep 20
done
