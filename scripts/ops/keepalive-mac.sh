#!/usr/bin/env bash
# Keepalive for the Mac-side coprocessor servers (vision-on-mac migration, 2026-06-12).
# Holds, all co-resident on the M4 Max, restarting any that fall over:
#   - vision-mac  (:8083, Qwen2.5-VL-7B  via mlx_vlm)  — MLX, mlx-venv
#   - reason-mac  (:8084, Qwen3.6-35B-A3B via mlx_lm)  — MLX, mlx-venv (off by default)
#   - coder-mac   (:8085, Qwen3-Coder-Next 4-bit via mlx_lm) — MLX, mlx-venv, ~45 GB resident
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
# coder-mac (bead 4f81, 2026-10-12): Qwen3-Coder-Next MLX 4-bit, pooled with coder-box. Measured on
# this M4 Max (bead c2m0): 1232/58 tok/s prefill/decode at 8K, 580/42 at 60K, battery 9/9; two
# concurrent 121K sessions peaked at 84 GB wired with no Metal OOM.
# Served from the pinned snapshot DIRECTORY, not the repo id: a repo id follows the cache's
# refs/main, which a later download moves, and the manifest verifies this revision only.
# CODER_MANIFEST_ID, CODER_SNAPSHOT and CODER_FILE_COUNT change together.
CODER_ENABLED="${CODER_MAC_ENABLED:-1}"   # CODER_MAC_ENABLED=0 in the plist's environment removes the slot
CODER_OFF_FILE="$HOME/.qwen-coprocessor-stack/coder-mac.off"  # touch = stop and hold coder-mac down within one tick (frees ~45 GB without a keepalive restart); rm = start it again
CODER_MANIFEST_ID="qwen3-coder-next-mlx-4bit@7b9321ea"
CODER_SNAPSHOT="$HF_HOME/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/7b9321eabb85ce79625cac3f61ea691e4ea984b5"
CODER_FILE_COUNT=10   # 9 weight shards + tokenizer.json, the files[] of CODER_MANIFEST_ID
CODER_MAX_TOKENS="${CODER_MAX_TOKENS:-16384}"   # a low cap truncates tool calls mid-write (CLAUDE.md eval rule 4)
CODER_MIN_FREE_GB="${CODER_MIN_FREE_GB:-50}"    # MIN_FREE_GB is sized for the 4.5 GB vision model; this one wires ~45 GB
CODER_PAT='mlx_lm\.server.*--port 8085( |$)'
REASON_PAT='mlx_lm\.server.*--port 8084( |$)'  # port-specific and end-anchored: both are mlx_lm.server, a bare pattern makes each reap the other, and an open-ended one takes a bench on :80850 too
PROBE_FAILS_MAX="${PROBE_FAILS_MAX:-3}"   # failed probes in a row before a server that still holds its port is reaped
PROV="$REPO_ROOT/scripts/ops/provenance/provenance.py"
PYTHON=$(command -v /opt/homebrew/bin/python3 2>/dev/null || command -v python3 2>/dev/null || echo python3)
PROVENANCE_ENFORCE=${QWEN_PROVENANCE_ENFORCE:-1}
VISION_PID=0; REASON_PID=0; CODER_PID=0
VISION_DEADLINE=0; REASON_DEADLINE=0; CODER_DEADLINE=0  # epoch when each in-flight load's budget expires (0 = not loading)
CODER_REFUSED=0; PROV_REASON=""
CODER_READY=0; CODER_STARTS=0; CODER_NEXT_START=0
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
mem_ok(){ [ "$(free_gb)" -ge "${1:-$MIN_FREE_GB}" ] 2>/dev/null; }
# RDR-016 gate for coder-mac, the Mac twin of prov_gate() in keepalive-coprocessor.sh: every
# weight shard and the tokenizer must be a file of CODER_MANIFEST_ID, verified on host mac, at
# the manifested byte length. Membership + size, no hashing (`provenance.py verify` hashes).
# The count check is the non-vacuity assert: a deleted shard fails no per-file check.
coder_prov_ok(){
  local f sz n=0
  PROV_REASON=""
  for f in "$CODER_SNAPSHOT"/*.safetensors "$CODER_SNAPSHOT/tokenizer.json"; do
    [ -f "$f" ] || { PROV_REASON="missing $f"; return 1; }
    sz=$(wc -c < "$f" | tr -d ' ')
    "$PYTHON" "$PROV" check-path "$(basename "$f")" --host mac --id "$CODER_MANIFEST_ID" --size "$sz" \
      >/dev/null 2>"$LOGDIR/coder-mac-prov.err" \
      || { PROV_REASON="$(basename "$f"): $(tail -n 1 "$LOGDIR/coder-mac-prov.err" 2>/dev/null)"; return 1; }
    n=$((n+1))
  done
  [ "$n" -eq "$CODER_FILE_COUNT" ] || { PROV_REASON="$n of $CODER_FILE_COUNT manifested files present in $CODER_SNAPSHOT"; return 1; }
}
# coder-mac readiness. mlx_lm.server answers /v1/models within seconds of spawn, while its
# generation thread is still loading 42 GB; if that load raises, the thread dies and the HTTP
# side keeps answering forever. So until the first success after a spawn the probe also
# needs a one-token completion. After that it is /v1/models only: a completion queues
# behind an in-flight request, and a long prefill would read as a dead server.
# Not detected: a generation thread that dies after readiness.
coder_up(){
  up 8085 || return 1
  [ "$CODER_READY" = 1 ] && return 0
  curl -sf --max-time 30 http://localhost:8085/v1/chat/completions -H 'Content-Type: application/json' \
    -d '{"model":"default_model","messages":[{"role":"user","content":"ok"}],"max_tokens":1}' 2>/dev/null \
    | grep -q '"choices"' || return 1
  CODER_READY=1; CODER_STARTS=0; CODER_NEXT_START=0
}
# ensure_mlx <port> <label> <pidvar> <deadlinevar> <startfn> [min_free_gb] [probefn]
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
  local port="$1" label="$2" pidvar="$3" dlvar="$4" startfn="$5" minfree="${6:-$MIN_FREE_GB}" probe="${7:-up}" pid dl now
  local failvar="${pidvar%_PID}_PROBE_FAILS" fails
  if "$probe" "$port"; then
    if [ "${!dlvar:-0}" -ne 0 ]; then log "$label UP (:$port)"; printf -v "$dlvar" '%s' 0; fi
    printf -v "$failvar" '%s' 0
    return 0
  fi
  pid="${!pidvar:-0}"; dl="${!dlvar:-0}"; now=$(date +%s)
  if [ "$pid" -gt 0 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null && [ "$now" -lt "$dl" ]; then
    return 0   # in-flight load within budget — leave it alone (no respawn = no leak/thrash)
  fi
  # A server that still holds its port gets PROBE_FAILS_MAX failed probes in a row before it
  # is reaped. One missed 5 s probe (wake from sleep, a memory stall) used to fall straight
  # through to the start fn, which kills the server and whatever sessions it was serving.
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fails=$(( ${!failvar:-0} + 1 )); printf -v "$failvar" '%s' "$fails"
    if [ "$fails" -lt "$PROBE_FAILS_MAX" ]; then
      log "$label probe failed ($fails/$PROBE_FAILS_MAX) with :$port still held — not respawning yet"
      return 0
    fi
  fi
  printf -v "$failvar" '%s' 0
  if mem_ok "$minfree"; then "$startfn"; else
    log "$label down; reclaimable RAM < ${minfree}G — deferring respawn (memory backstop)"
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
  reap_pat "$REASON_PAT" reason-mac   # same SIGKILL-escalating reap (SIGTERM ignored mid-load)
  "$VENV/bin/mlx_lm.server" --model "$REASON_MODEL" --host 0.0.0.0 --port 8084 \
    --max-tokens "$REASON_MAX_TOKENS" \
    > "$LOGDIR/reason-mac.log" 2>&1 & REASON_PID=$!
  REASON_DEADLINE=$(( $(date +%s) + LOAD_BUDGET ))   # non-blocking: not gated behind vision's load (hxp)
  log "reason-mac spawned (pid $REASON_PID); load budget ${LOAD_BUDGET}s"
}
start_coder() {
  if ! coder_prov_ok; then
    if [ "$PROVENANCE_ENFORCE" = 0 ]; then
      log "PROVENANCE BYPASS (QWEN_PROVENANCE_ENFORCE=0): $PROV_REASON — launching coder-mac anyway"
    else
      [ "$CODER_REFUSED" -eq 0 ] && log "REFUSING to launch coder-mac — $PROV_REASON (fix the manifest: /qwen-stack:provenance; or QWEN_PROVENANCE_ENFORCE=0 to bypass, logged)"
      CODER_REFUSED=1; return 0
    fi
  fi
  CODER_REFUSED=0
  # Spawn backoff, 20 s doubling to 10 min: a coder that dies at load must not reread 42 GB
  # every tick. coder_up clears it on the first good completion.
  [ "$(date +%s)" -lt "$CODER_NEXT_START" ] && return 0
  CODER_STARTS=$((CODER_STARTS + 1))
  CODER_NEXT_START=$(( $(date +%s) + 20 * (2 ** (CODER_STARTS > 6 ? 5 : CODER_STARTS - 1)) ))
  CODER_READY=0
  log "starting coder-mac (:8085, $CODER_MANIFEST_ID, max-tokens $CODER_MAX_TOKENS)"
  reap_pat "$CODER_PAT" coder-mac
  # HF_HUB_OFFLINE: mlx_lm.server loads whatever model a request names. Offline, a name that
  # is not already in the cache is a 404 instead of an unmanifested download (RDR-016). A
  # name that IS in the cache still loads and replaces the coder; the gate does not cover that.
  # Sampling is the model's intended one; temperature 0 loops agentic runs (CLAUDE.md eval rule 3).
  HF_HUB_OFFLINE=1 "$VENV/bin/mlx_lm.server" --model "$CODER_SNAPSHOT" --host 0.0.0.0 --port 8085 \
    --temp 0.7 --top-p 0.8 --max-tokens "$CODER_MAX_TOKENS" \
    >> "$LOGDIR/coder-mac.log" 2>&1 & CODER_PID=$!   # append: a load crash's traceback must survive the respawn
  CODER_DEADLINE=$(( $(date +%s) + LOAD_BUDGET ))
  log "coder-mac spawned (pid $CODER_PID); load budget ${LOAD_BUDGET}s"
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
trap 'log "shutdown; killing servers"; reap_pat "mlx_vlm\.server" vision-mac; reap_pat "$REASON_PAT" reason-mac; reap_pat "$CODER_PAT" coder-mac; kpidfile "$REPO_ROOT/logs/llama-embed.pid"; kpidfile "$REPO_ROOT/logs/llama-rerank.pid"; exit 0' TERM INT
log "mac keepalive started (pid $$) — vision-mac + embed-local + rerank-local (reason-mac enabled=$REASON_ENABLED, coder-mac enabled=$CODER_ENABLED)"
# A coder that outlived the previous keepalive (it was killed, not TERMed) may be mid-request,
# where the readiness completion cannot answer. Adopt it with a fresh load budget.
if [ "$CODER_ENABLED" = 1 ] && up 8085; then
  CODER_PID=$(lsof -tiTCP:8085 -sTCP:LISTEN 2>/dev/null | head -1); CODER_PID=${CODER_PID:-0}
  CODER_DEADLINE=$(( $(date +%s) + LOAD_BUDGET ))
  log "coder-mac already serving (pid $CODER_PID) — adopting; readiness budget ${LOAD_BUDGET}s"
fi
while true; do
  # Backstop: prune duplicate MLX servers (keep the one serving its port) before the health
  # checks, so a stuck/orphaned instance can't keep failing `up` and stacking respawns.
  guard_single 'mlx_vlm\.server' 8083 vision-mac
  [ "$REASON_ENABLED" = 1 ] && guard_single "$REASON_PAT" 8084 reason-mac
  # Non-blocking ensures: neither MLX load gates the other (hxp) — both proceed concurrently,
  # and the deadline gate inside ensure_mlx prevents respawn-while-loading (the leak/thrash).
  # The memory backstop lives inside ensure_mlx (mem_ok before any spawn).
  ensure_mlx 8083 vision-mac VISION_PID VISION_DEADLINE start_vision
  [ "$REASON_ENABLED" = 1 ] && ensure_mlx 8084 reason-mac REASON_PID REASON_DEADLINE start_reason
  if [ "$CODER_ENABLED" = 1 ]; then
    if [ -e "$CODER_OFF_FILE" ]; then
      if pgrep -f "$CODER_PAT" >/dev/null 2>&1; then
        log "coder-mac switched off ($CODER_OFF_FILE present) — stopping"
        reap_pat "$CODER_PAT" coder-mac; CODER_PID=0; CODER_DEADLINE=0
      fi
    else
      guard_single "$CODER_PAT" 8085 coder-mac
      ensure_mlx 8085 coder-mac CODER_PID CODER_DEADLINE start_coder "$CODER_MIN_FREE_GB" coder_up
    fi
  fi
  ensure_http 8081 embed-local  "$REPO_ROOT/scripts/start-embed-server.sh"  embed-mac.log  EMBED_FAILS  EMBED_DUE
  ensure_http 8082 rerank-local "$REPO_ROOT/scripts/start-rerank-server.sh" rerank-mac.log RERANK_FAILS RERANK_DUE
  sleep 20
done
