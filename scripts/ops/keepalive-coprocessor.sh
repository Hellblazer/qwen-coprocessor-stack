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
# 2026-07-26: REVERTED to b9596. PR #80 pinned b10078 for its ggml-vulkan carve fix,
# but on this box today b10078 does NOT reach the dedicated carve in ANY configuration
# tested — per-process GPU dedicated 0 GB with 46.16 GB of host private commit, across
# all three of {--no-mmap + env var}, {mmap + env var}, {mmap, no env var}. b9596 on the
# same box the same morning held 32.42 GB dedicated with 15.9 GB RAM free. Until the
# b10078 regression is understood (see bead 36p / the negotiation channel), b9596 is the
# only build measured to use the carve here. Do NOT re-pin b10078 on the strength of tps
# alone — tps was 47-50 in the broken states, HIGHER than b9596's 45-46.
LL='D:\llama-b9596\llama-server.exe'
# b10078 (2026-07-21, negotiation V8): fixes ggml-vulkan memory-type selection — the
# whole model lands in the dedicated carve (48.4 GB) instead of spilling ~16 GB to
# host-visible/GTT. RAM free 7.2 -> 22.3 GB (WoW co-residency), tps 41.9 -> 43.8.
# Historical (bead 081): b9611 did NOT fix the qwen3_next Vulkan crash; that was
# co-residency VRAM exhaustion, eliminated by moving vision/35B off the box.
# VARIANT: tuning flags agreed in D:\claude-coordination\QWEN_SERVER_NEGOTIATION.md
# (GTT-spill reduction for WoW co-residency). Empty = baseline. e.g. "--no-mmap"
#
# 2026-07-26: --no-mmap REMOVED. On first launch after the C: repair + D: cable/
# write-cache change it did NOT reproduce its 2026-07-21 V8 measurements. Measured
# live instead: llama-server held 48.57 GB of PRIVATE commit against only 31.65 GB
# of visible system RAM, GPU dedicated usage fell to 0.67 GB (b9596 held 32.42 GB),
# Available MBytes hit 289, Pages/sec 4658, Page Faults/sec 67608, and C:\pagefile.sys
# reached 23.68 GB in use / 68.63 GB peak. The model was being served out of the
# pagefile, not the carve. --no-mmap forces an anonymous private allocation that
# cannot fit the 96/32 carve's 31.65 GB system side, so it spills. Default mmap keeps
# the model file-backed from D:. Decode stayed ~47-50 tps throughout, so tps alone
# does NOT detect this failure — check Available MBytes / GPU dedicated usage.
VARIANT=""
# ENVSET: server-process env var (Variant 5, negotiation 2026-07-21): steer ggml-vulkan
# away from host-visible vidmem (the 16.1 GB GTT spill). "NAME=VALUE" or empty.
#
# 2026-07-26: GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM=1 REMOVED — it is the variable that
# empties the carve on this box today. Isolated across two launches: with the var set,
# GPU dedicated usage stayed at 0.64 GB and Available MBytes collapsed to 17-289 MB
# BOTH with --no-mmap (48.57 GB private commit, pagefile peak 68.63 GB) and without it.
# b9596, which sets no env var, fills the carve to 32.42 GB and leaves 15.9 GB free.
# Reading: telling ggml-vulkan to avoid host-visible VRAM makes this driver fall back
# to plain host RAM rather than device-local, so the model never reaches the carve.
# Why V8 measured 48.4 GB dedicated / 22.3 GB free on 2026-07-21 and does not now is
# UNRESOLVED; untested variables since then are the box's C: repair and the D: cable
# swap + write-cache enable. Re-validate against Available MBytes and GPU dedicated
# usage (NOT tps — tps stayed 47-50 throughout the bad states) before restoring it.
ENVSET=""
CODER="$LL -m D:\\models\\qwen3-coder-next\\Qwen3-Coder-Next-UD-Q4_K_XL.gguf --host 0.0.0.0 --port 1235 --n-gpu-layers 99 --ctx-size 32768 --flash-attn 1 --threads 16 --alias qwen --log-file D:\\logs\\coder-box.log${VARIANT:+ $VARIANT}"
KILLALL_B64=$(printf 'Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force' | iconv -t UTF-16LE | base64)
CODER_PID=0
up()    { curl -s --max-time 5 "http://$HOST:$1/v1/models" 2>/dev/null | grep -q '"name"'; }
log()   { echo "$(date '+%H:%M:%S') $*"; }
kpid()  { [ "${1:-0}" -gt 0 ] 2>/dev/null && kill "$1" 2>/dev/null; }
killremote() { $SSH "$HOST" "powershell -NoProfile -EncodedCommand $KILLALL_B64" >/dev/null 2>&1; }
# 2026-07-26: bound raised 30 -> 150 (240 s -> 20 min). A COLD load of the 49.6 GB
# Coder-Next through the 96/32 carve's 31.65 GB system side takes longer than 240 s,
# so the old bound declared FAILED on a server that was still loading normally, then
# killremote'd it and retried — an unbounded kill/retry loop that never converges and
# hammers the box. This is the 2026-07-24 13:02:27 / 13:09:27 double-FAILED pattern in
# logs/keepalive.log, immediately before that day's two hard resets. Do not lower it
# without measuring a cold load first.
waitup(){ for i in $(seq 1 150); do up "$1" && return 0; sleep 8; done; return 1; }
# Launch metadata for the box-side Claude (negotiation commitment 2, 2026-07-21):
# every (re)launch writes D:\claude-coordination\qwen-server-state.json.
write_state() {
  local pid ts json ps b64
  pid=$($SSH "$HOST" 'tasklist /FI "IMAGENAME eq llama-server.exe" /FO CSV /NH' 2>/dev/null | head -1 | cut -d'"' -f4)
  ts=$(date '+%Y-%m-%dT%H:%M:%S%z')
  json="{\"pid\": ${pid:-null}, \"launched_at\": \"$ts\", \"owner\": \"PEER-keepalive\", \"variant\": \"$VARIANT\", \"env\": \"$ENVSET\", \"cmdline\": \"$(printf '%s' "$CODER" | sed 's/\\/\\\\/g; s/"/\\"/g')\"}"
  ps="Set-Content -Path D:\claude-coordination\qwen-server-state.json -Value '$json'"
  b64=$(printf '%s' "$ps" | iconv -t UTF-16LE | base64)
  $SSH "$HOST" "powershell -NoProfile -EncodedCommand $b64" >/dev/null 2>&1
  log "state json written (pid ${pid:-unknown})"
}
start_coder() {
  log "starting coder-box (alone)"
  kpid "$CODER_PID"; killremote; sleep 8
  if [ -n "$ENVSET" ]; then
    # cmd 'set NAME=VALUE&&' (no space before &&: a space would join the value)
    $SSH "$HOST" "cmd /c \"set $ENVSET&& $CODER\"" >/dev/null 2>&1 & CODER_PID=$!
  else
    $SSH "$HOST" "$CODER" >/dev/null 2>&1 & CODER_PID=$!
  fi
  waitup 1235 && { log "coder-box UP"; write_state; } || log "coder-box FAILED to come up"
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
