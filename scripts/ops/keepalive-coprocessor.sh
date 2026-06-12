#!/usr/bin/env bash
# Keepalive for the Coder-Next coprocessor (qwen-coprocessor-stack 1xu / P1, opt 3).
# Holds both box llama-servers via SSH (they can't detach on this box) + restarts on
# crash. LOAD ORDER is load-bearing: coder-box(:1235, 49GB) MUST load before
# vision-box(:1234, 21GB) or the Vulkan submit-allocator OOMs. So if coder (the
# anchor) is down, re-sequence the WHOLE stack: stop both, coder first, then vision.
# Run under launchd (KeepAlive) -> independent of any login shell. ssh -n: never read
# stdin (SIGTTIN under launchd). All kills guarded (kill 0 == signal the whole group).
set -u
HOST=qwentescence
SSH="ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30"
LL='D:\llama-b9596\llama-server.exe'
# bead 081: trialed b9611 for coder-box (2026-06-12) — did NOT fix the qwen3_next
# Vulkan AGENTIC crash (coder-box still died on a qwen_oneshot). Reverted to b9596.
# The fix is supervisor-side: coder-box is excluded from the agentic pool
# (no_agentic in config / chooseBackend), kept for qwen_chat + tokenize.
LL_CODER="$LL"
# NOTE (bead 081): do NOT disable unified-KV (--parallel 1 / --no-kv-unified) —
# that crashes Coder-Next during WARMUP on b9596. And --cache-reuse is DROPPED
# here: the agentic-request crash was captured dying silently in the cross-slot
# prompt-cache "looking for better prompt" path — the same kv_unified+cache-reuse
# combo that caused the b9090 cancel-task bug (bisect-2026-05-21). On b9596
# kv_unified is forced on, so we break the combo from the cache-reuse side.
CODER="$LL_CODER -m D:\\models\\qwen3-coder-next\\Qwen3-Coder-Next-UD-Q4_K_XL.gguf --host 0.0.0.0 --port 1235 --n-gpu-layers 99 --ctx-size 32768 --flash-attn 1 --threads 16 --alias qwen --log-file D:\\logs\\coder-box.log"
VISION="$LL -m D:\\models\\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf --mmproj D:\\models\\mmproj-Qwen3.6-35B-A3B-BF16.gguf --host 0.0.0.0 --port 1234 --n-gpu-layers 99 --ctx-size 32768 --flash-attn 1 --threads 16 --cache-reuse 32 --alias qwen3.6-35b-a3b --log-file D:\\logs\\vision-box.log"
KILLALL_B64=$(printf 'Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force' | iconv -t UTF-16LE | base64)
CODER_PID=0; VISION_PID=0
up()    { curl -s --max-time 5 "http://$HOST:$1/v1/models" 2>/dev/null | grep -q '"name"'; }
log()   { echo "$(date '+%H:%M:%S') $*"; }
kpid()  { [ "${1:-0}" -gt 0 ] 2>/dev/null && kill "$1" 2>/dev/null; }
killremote() { $SSH "$HOST" "powershell -NoProfile -EncodedCommand $KILLALL_B64" >/dev/null 2>&1; }
waitup(){ for i in $(seq 1 30); do up "$1" && return 0; sleep 8; done; return 1; }
trap 'log "shutdown; killing held ssh"; kpid "$CODER_PID"; kpid "$VISION_PID"; exit 0' TERM INT
log "keepalive started (pid $$)"
while true; do
  if ! up 1235; then
    log "coder-box (anchor) DOWN -> full re-sequence (clean GPU, coder first)"
    kpid "$CODER_PID"; kpid "$VISION_PID"; killremote; sleep 10
    $SSH "$HOST" "$CODER" >/dev/null 2>&1 & CODER_PID=$!
    waitup 1235 && log "coder-box UP" || log "coder-box FAILED to come up"
    if up 1235; then
      $SSH "$HOST" "$VISION" >/dev/null 2>&1 & VISION_PID=$!
      waitup 1234 && log "vision-box UP" || log "vision-box FAILED"
    fi
  elif ! up 1234; then
    log "vision-box DOWN (coder up) -> start vision on top (good order)"
    kpid "$VISION_PID"
    $SSH "$HOST" "$VISION" >/dev/null 2>&1 & VISION_PID=$!
    waitup 1234 && log "vision-box UP" || log "vision-box FAILED"
  fi
  sleep 20
done
