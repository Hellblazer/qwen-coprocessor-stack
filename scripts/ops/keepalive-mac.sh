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
export HF_HOME="/Volumes/SanHell/hf-cache"
LOGDIR="$HOME/.qwen-coprocessor-stack/logs"; mkdir -p "$LOGDIR"
VISION_MODEL="mlx-community/Qwen2.5-VL-7B-Instruct-4bit"
REASON_MODEL="mlx-community/Qwen3.6-35B-A3B-4bit"
REASON_ENABLED="${REASON_ENABLED:-0}"  # 2026-09-12: reason-mac OFF by default to free ~20 GB of unified memory for large-model work (DeepSeek-V4-Flash trial). REASON_ENABLED=1 restores it; also re-add the reason-mac backend to ~/.qwen-coprocessor-stack/config.json.
REASON_MAX_TOKENS="${REASON_MAX_TOKENS:-4096}"  # generation-length guardrail for reason-mac (mlx_lm.server has no --max-kv-size; --max-tokens bounds generation -> bounds KV growth since operator prompts are small). Override via env.
MIN_FREE_GB="${MIN_FREE_GB:-6}"   # memory backstop: don't (re)spawn a ~4.5G+ MLX model when reclaimable RAM is below this — defers respawn (logs) instead of thrashing disk under pressure (qwen-coprocessor-stack-25s, spec item 4). Override via env.
LOAD_BUDGET="${LOAD_BUDGET:-900}"  # seconds a freshly-spawned MLX server is allowed to load off the slow external disk before we treat a still-down port as stuck and respawn. Generous so a slow-but-progressing cold load is not killed (qwen-coprocessor-stack-hxp). Override via env.
VISION_PID=0; REASON_PID=0
VISION_DEADLINE=0; REASON_DEADLINE=0  # epoch when each in-flight load's budget expires (0 = not loading)
up()  { curl -s --max-time 5 "http://localhost:$1/v1/models" 2>/dev/null | grep -q '"object"'; }
uph() { curl -sf --max-time 5 "http://localhost:$1/health" 2>/dev/null | grep -q 'ok'; }  # llama.cpp embed/rerank expose /health, not a model list
log() { echo "$(date '+%H:%M:%S') $*"; }
kpid(){ [ "${1:-0}" -gt 0 ] 2>/dev/null && kill "$1" 2>/dev/null; }
# Only signal a pid the pidfile still legitimately owns. A pidfile outlives its process, the
# OS recycles the number, and an unvalidated `kill` then lands on a stranger: the rerank
# pidfile held 1464, which by then was a WebKit networking process (jh3).
kpidfile(){
  local f="$1" p
  [ -f "$f" ] || return 0
  p="$(cat "$f" 2>/dev/null)"
  [ "${p:-0}" -gt 0 ] 2>/dev/null || return 0
  case "$(ps -p "$p" -o comm= 2>/dev/null)" in
    *llama-server) kpid "$p" ;;
    *) log "stale pidfile $f (pid $p is not llama-server) — not signalling" ;;
  esac
}
# Hard-reap every process matching a pattern: SIGTERM, wait, then SIGKILL-escalate.
# MLX servers (mlx_vlm.server / mlx_lm.server) IGNORE SIGTERM while loading the 4-bit
# model off the slow external disk, so a lone `kpid` SIGTERM never reaps them — the prior
# instance survives and the respawn loop stacks ~4.3G/cycle until the 128G host is full
# (qwen-coprocessor-stack-25s). reap_pat pkills by pattern (catches reparented/multiple),
# escalating to -9 after a 5s grace. Returns once nothing matches.
reap_pat(){
  local pat="$1" label="$2" i
  pgrep -f "$pat" >/dev/null 2>&1 || return 0
  pkill -f "$pat" 2>/dev/null
  for i in 1 2 3 4 5; do
    sleep 1
    pgrep -f "$pat" >/dev/null 2>&1 || { log "$label reaped (TERM)"; return 0; }
  done
  pkill -9 -f "$pat" 2>/dev/null
  sleep 1
  if pgrep -f "$pat" >/dev/null 2>&1; then
    log "$label: STILL ALIVE after SIGKILL (zombie?) — spawning anyway"
  else
    log "$label reaped (KILL — SIGTERM ignored mid-load)"
  fi
}
# Defensive backstop for duplicate instances (e.g. orphans from a prior keepalive that
# launchd restarted mid-load). Port-aware: keep the PID currently LISTENing on $port (the
# healthy server — never force an unnecessary multi-minute reload of a serving model) and
# SIGKILL the rest. If nothing is serving (the leak case — forensics showed N zombies, none
# bound to 8083), all get reaped and the next up-check respawns a clean singleton.
guard_single(){
  local pat="$1" port="$2" label="$3" pids n keep p
  pids=$(pgrep -f "$pat" 2>/dev/null)
  n=$(printf '%s\n' "$pids" | grep -c .)
  [ "${n:-0}" -gt 1 ] || return 0
  keep=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1)
  log "$label: $n instances detected — pruning to singleton (keep=${keep:-none})"
  for p in $pids; do
    [ -n "$keep" ] && [ "$p" = "$keep" ] && continue
    kill -9 "$p" 2>/dev/null
  done
  sleep 1
}
# Reclaimable memory (free + inactive + speculative) in whole GB, via vm_stat. Used by the
# memory backstop to refuse a respawn that would only deepen memory pressure.
free_gb(){
  local ps
  ps=$(sysctl -n hw.pagesize 2>/dev/null || echo 16384)
  vm_stat 2>/dev/null | awk -v ps="$ps" '
    /Pages free/        {gsub(/\./,"",$3); f=$3}
    /Pages inactive/    {gsub(/\./,"",$3); i=$3}
    /Pages speculative/ {gsub(/\./,"",$3); s=$3}
    END { printf "%d", (f+i+s)*ps/1073741824 }'
}
mem_ok(){ [ "$(free_gb)" -ge "$MIN_FREE_GB" ] 2>/dev/null; }
# ensure_mlx <port> <label> <pidvar> <deadlinevar> <startfn>
# Non-blocking health gate (qwen-coprocessor-stack-hxp). Each MLX server loads its weights
# off the slow external disk; the old design blocked the loop in a synchronous 600s `waitup`
# inside start_vision, so reason-mac (and embed/rerank) could not start until vision finished
# or timed out. Here the start fns spawn-and-return, recording a load deadline; the loop polls
# `up` each tick without blocking, so vision and reason load concurrently. The deadline gate is
# what now prevents the respawn-while-loading leak the old synchronous waitup prevented for free:
#   - up -> healthy: clear the deadline (log the UP transition once).
#   - down + process alive + within deadline -> still loading: do NOT respawn.
#   - down + process dead (crashed) OR past deadline (stuck) -> (re)spawn, subject to mem_ok.
# NOTE: this gate is the steady-state protection. guard_single (loop top) may legitimately
# SIGKILL an in-flight load when duplicates exist with no listener — that leaves <pidvar> on a
# dead pid, so the next tick respawns immediately (correct: no live instance to protect). Single
# instance is still guaranteed by reap_pat inside startfn. <pidvar>/<dlvar> must name globals
# (VISION_*/REASON_*); pid/dl/now below are tick-scoped snapshots, and startfn updates the
# globals for the next tick.
ensure_mlx() {
  local port="$1" label="$2" pidvar="$3" dlvar="$4" startfn="$5" pid dl now
  if up "$port"; then
    if [ "${!dlvar:-0}" -ne 0 ]; then log "$label UP (:$port)"; printf -v "$dlvar" '%s' 0; fi
    return 0
  fi
  pid="${!pidvar:-0}"; dl="${!dlvar:-0}"; now=$(date +%s)
  if [ "$pid" -gt 0 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null && [ "$now" -lt "$dl" ]; then
    return 0   # in-flight load within budget — leave it alone (no respawn = no leak/thrash)
  fi
  if mem_ok; then "$startfn"; else
    log "$label down; reclaimable RAM < ${MIN_FREE_GB}G — deferring respawn (memory backstop)"
  fi
}
start_vision() {
  log "starting vision-mac (:8083, $VISION_MODEL)"
  reap_pat 'mlx_vlm\.server' vision-mac   # SIGKILL-escalating; SIGTERM alone is ignored mid-load
  "$VENV/bin/mlx_vlm.server" --model "$VISION_MODEL" --host 0.0.0.0 --port 8083 \
    > "$LOGDIR/vision-mac.log" 2>&1 & VISION_PID=$!
  VISION_DEADLINE=$(( $(date +%s) + LOAD_BUDGET ))   # non-blocking: loop polls `up` instead of waiting here
  log "vision-mac spawned (pid $VISION_PID); load budget ${LOAD_BUDGET}s"
}
start_reason() {
  # --max-tokens guardrail: cap generation length so a runaway on this verbose
  # thinking model can't balloon unified memory and pressure vision-mac (the
  # co-residency we engineered away). mlx_lm.server has no --max-kv-size; capping
  # generation bounds KV growth because operator prompts are small. 64K is far
  # above any real answer; the model's native window is 256K (we don't need it).
  log "starting reason-mac (:8084, $REASON_MODEL, max-tokens $REASON_MAX_TOKENS)"
  reap_pat 'mlx_lm\.server' reason-mac   # same SIGKILL-escalating reap (SIGTERM ignored mid-load)
  "$VENV/bin/mlx_lm.server" --model "$REASON_MODEL" --host 0.0.0.0 --port 8084 \
    --max-tokens "$REASON_MAX_TOKENS" \
    > "$LOGDIR/reason-mac.log" 2>&1 & REASON_PID=$!
  REASON_DEADLINE=$(( $(date +%s) + LOAD_BUDGET ))   # non-blocking: not gated behind vision's load (hxp)
  log "reason-mac spawned (pid $REASON_PID); load budget ${LOAD_BUDGET}s"
}
# embed-local / rerank-local are llama.cpp servers driven by their own start scripts,
# which self-background, write a pidfile under $REPO_ROOT/logs, wait for /health, and are
# idempotent (a running instance is detected by probing the port — NOT by the pidfile, whose
# pid gets recycled and then lies; jh3). We call them when the port is down and re-check the
# port afterward; their own llama-server child reparents away, so we track shutdown via their
# pidfiles rather than a PID var, validating ownership before signalling.
# A zero exit from the start script is NOT evidence the port is serving — verify before
# claiming UP. Without that check the loop logged a cheerful "rerank-local UP" every 20s for
# six days while nothing listened on :8082 (24540 cycles, 16.5 MB of log, jh3). <failvar> and
# <duevar> must name globals; ensure_http gates the retry cadence on them.
ensure_http() {
  local port="$1" label="$2" script="$3" logf="$4" failvar="$5" duevar="$6" fails backoff
  uph "$port" && { if [ "${!failvar:-0}" -ne 0 ]; then log "$label UP (:$port)"; fi
                       printf -v "$failvar" '%s' 0; printf -v "$duevar" '%s' 0; return 0; }
  [ "$(date +%s)" -lt "${!duevar:-0}" ] && return 0   # backing off — no attempt this tick
  log "starting $label (:$port) via $(basename "$script")"
  bash "$script" >> "$LOGDIR/$logf" 2>&1 || true
  if uph "$port"; then
    log "$label UP (:$port)"
    printf -v "$failvar" '%s' 0; printf -v "$duevar" '%s' 0
  else
    fails=$(( ${!failvar:-0} + 1 ))
    # 20s doubling to a 10-minute ceiling: a service that will not start must not respawn
    # every 20s forever, filling the disk with identical failures nobody reads.
    backoff=$(( 20 * (2 ** $(( fails > 5 ? 5 : fails - 1 )) ) ))
    [ "$backoff" -gt 600 ] && backoff=600
    printf -v "$failvar" '%s' "$fails"
    printf -v "$duevar" '%s' "$(( $(date +%s) + backoff ))"
    log "$label FAILED to come up on :$port (attempt $fails; retry in ${backoff}s; see $logf)"
  fi
}
trap 'log "shutdown; killing servers"; reap_pat "mlx_vlm\.server" vision-mac; reap_pat "mlx_lm\.server" reason-mac; kpidfile "$REPO_ROOT/logs/llama-embed.pid"; kpidfile "$REPO_ROOT/logs/llama-rerank.pid"; exit 0' TERM INT
log "mac keepalive started (pid $$) — vision-mac + embed-local + rerank-local (reason-mac enabled=$REASON_ENABLED)"
while true; do
  # Backstop: prune duplicate MLX servers (keep the one serving its port) before the health
  # checks, so a stuck/orphaned instance can't keep failing `up` and stacking respawns.
  guard_single 'mlx_vlm\.server' 8083 vision-mac
  [ "$REASON_ENABLED" = 1 ] && guard_single 'mlx_lm\.server'  8084 reason-mac
  # Non-blocking ensures: neither MLX load gates the other (hxp) — both proceed concurrently,
  # and the deadline gate inside ensure_mlx prevents respawn-while-loading (the leak/thrash).
  # The memory backstop lives inside ensure_mlx (mem_ok before any spawn).
  ensure_mlx 8083 vision-mac VISION_PID VISION_DEADLINE start_vision
  [ "$REASON_ENABLED" = 1 ] && ensure_mlx 8084 reason-mac REASON_PID REASON_DEADLINE start_reason
  ensure_http 8081 embed-local  "$REPO_ROOT/scripts/start-embed-server.sh"  embed-mac.log  EMBED_FAILS  EMBED_DUE
  ensure_http 8082 rerank-local "$REPO_ROOT/scripts/start-rerank-server.sh" rerank-mac.log RERANK_FAILS RERANK_DUE
  sleep 20
done
