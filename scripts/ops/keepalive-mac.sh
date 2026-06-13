#!/usr/bin/env bash
# Keepalive for the Mac-side MLX coprocessor servers (vision-on-mac migration, 2026-06-12).
# Holds vision-mac (Qwen2.5-VL-7B via mlx_vlm) + reason-mac (Qwen3.6-35B-A3B via mlx_lm),
# both co-resident on the M4 Max (fits comfortably: ~25GB weights, ~44GB free). Restarts
# on crash. Local processes (no SSH). Run under launchd (KeepAlive) so it survives logout.
#
# WHY: coder-box (coding) stays on the box ALONE; vision + the 35B (general/reasoning)
# live here. This split removed the box co-residency that crashed coder-box (081/akf).
# Models load off the external Transcend disk (~94 MB/s) so first start is slow (mins).
set -u
VENV="$HOME/.qwen-coprocessor-stack/mlx-venv"
export HF_HOME="/Volumes/Transcend Hell/hf-cache"
LOGDIR="$HOME/.qwen-coprocessor-stack/logs"; mkdir -p "$LOGDIR"
VISION_MODEL="mlx-community/Qwen2.5-VL-7B-Instruct-4bit"
REASON_MODEL="mlx-community/Qwen3.6-35B-A3B-4bit"
REASON_MAX_TOKENS="${REASON_MAX_TOKENS:-4096}"  # generation-length guardrail for reason-mac (mlx_lm.server has no --max-kv-size; --max-tokens bounds generation -> bounds KV growth since operator prompts are small). Override via env.
VISION_PID=0; REASON_PID=0
up()  { curl -s --max-time 5 "http://localhost:$1/v1/models" 2>/dev/null | grep -q '"object"'; }
log() { echo "$(date '+%H:%M:%S') $*"; }
kpid(){ [ "${1:-0}" -gt 0 ] 2>/dev/null && kill "$1" 2>/dev/null; }
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
trap 'log "shutdown; killing servers"; kpid "$VISION_PID"; kpid "$REASON_PID"; exit 0' TERM INT
log "mac keepalive started (pid $$) — vision-mac + reason-mac"
while true; do
  up 8083 || start_vision
  up 8084 || start_reason
  sleep 20
done
