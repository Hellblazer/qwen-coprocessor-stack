#!/usr/bin/env bash
# Keepalive for the Coder-Next coprocessor (qwen-coprocessor-stack 1xu / P1, opt 3).
# Holds the box llama-server via SSH (it can't detach on this box) + restarts on crash.
#
# TOPOLOGY (2026-06-12, vision-on-mac migration): the box now runs coder-box ALONE.
# Vision (Qwen2.5-VL-7B) and the 35B (Qwen3.6-35B-A3B, general/reasoning) moved to the
# Mac (MLX) — see scripts/ops/keepalive-mac.sh. This removed the coder-box+vision-35B
# CO-RESIDENCY that exhausted the box's ~106GB Vulkan and crashed coder-box with an
# uncaught vk alloc -> abort 0xc0000409 (beads 081/akf, root-caused 2026-06-12). With
# coder-box alone there is no co-residency, so it is stable for agentic coding.
#
# Run under launchd (KeepAlive) -> independent of any login shell. ssh -n: never read
# stdin (SIGTTIN under launchd). All kills guarded (kill 0 == signal the whole group).
set -u
HOST=qwentescence
SSH="ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30"
LL='D:\llama-b9596\llama-server.exe'
# bead 081: b9611 did NOT fix the qwen3_next Vulkan crash; it was co-residency VRAM
# exhaustion, now eliminated by moving vision/35B off the box. Stay on b9596.
CODER="$LL -m D:\\models\\qwen3-coder-next\\Qwen3-Coder-Next-UD-Q4_K_XL.gguf --host 0.0.0.0 --port 1235 --n-gpu-layers 99 --ctx-size 32768 --flash-attn 1 --threads 16 --alias qwen --log-file D:\\logs\\coder-box.log"
KILLALL_B64=$(printf 'Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force' | iconv -t UTF-16LE | base64)
CODER_PID=0
up()    { curl -s --max-time 5 "http://$HOST:$1/v1/models" 2>/dev/null | grep -q '"name"'; }
log()   { echo "$(date '+%H:%M:%S') $*"; }
kpid()  { [ "${1:-0}" -gt 0 ] 2>/dev/null && kill "$1" 2>/dev/null; }
killremote() { $SSH "$HOST" "powershell -NoProfile -EncodedCommand $KILLALL_B64" >/dev/null 2>&1; }
waitup(){ for i in $(seq 1 30); do up "$1" && return 0; sleep 8; done; return 1; }
start_coder() {
  log "starting coder-box (alone)"
  kpid "$CODER_PID"; killremote; sleep 8
  $SSH "$HOST" "$CODER" >/dev/null 2>&1 & CODER_PID=$!
  waitup 1235 && log "coder-box UP" || log "coder-box FAILED to come up"
}
trap 'log "shutdown; killing held ssh"; kpid "$CODER_PID"; exit 0' TERM INT
log "keepalive started (pid $$) — coder-box only"
while true; do
  if ! up 1235; then
    log "coder-box DOWN"
    start_coder
  fi
  sleep 20
done
