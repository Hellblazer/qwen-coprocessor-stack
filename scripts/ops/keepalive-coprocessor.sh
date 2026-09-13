#!/usr/bin/env bash
# Keepalive for the box coprocessor (qwen-coprocessor-stack 1xu / P1, opt 3).
# Holds the box llama-server via SSH (it can't detach on this box) + restarts on crash.
#
# 2026-08-16: PROMOTED Qwen3.8-27B (Q6_K + mmproj) as the box model, replacing
# Coder-Next. Optimized config measured in the 2026-08-16 window (bd memory
# qwen3.8-27b-box-optimized-config-2026-08-16): decode 7.62 -> ~14 tps prose /
# ~17 tps code via Q6_K + MTP; 64K ctx for agentic headroom; 28.1 GB GPU
# dedicated, in-carve. To revert to Coder-Next: CODER_MODEL back to
# D:\models\qwen3-coder-next\Qwen3-Coder-Next-UD-Q4_K_XL.gguf, CODER_MANIFEST_ID
# to qwen3-coder-next-unsloth-gguf@ce09c67b, drop --mmproj/--reasoning off/
# --spec-type from the CODER line, ctx back to 32768.
#
# TOPOLOGY (2026-06-12, vision-on-mac migration): the box runs ONE llama-server.
# The dedicated vision model (Qwen2.5-VL-7B) and the 35B (Qwen3.6-35B-A3B) moved to
# the Mac (MLX) — see scripts/ops/keepalive-mac.sh. This removed the coder-box+vision
# CO-RESIDENCY that exhausted the box's ~106GB Vulkan and crashed coder-box with an
# uncaught vk alloc -> abort 0xc0000409 (beads 081/akf, root-caused 2026-06-12).
# 2026-08-16 update: the single box server is now itself multimodal (Qwen3.8 +
# --mmproj on the SAME process). That is NOT the 081/akf co-residency pattern —
# still one server, one model + its ~1.2 GB projector, no second large model. The
# no-co-residency rule (never a second llama-server / second large model) stands.
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
CODER_MODEL='D:\models\qwen3.8-27b\Qwen3.8-27B-Q6_K.gguf'
# Q6_K over Q8_0: +26% decode, no capability loss observed (shakeout 9/9 both).
# CODER line flags (all load-bearing, 2026-08-16 window):
#   --mmproj             vision/OCR head (Qwen3.8 is multimodal; supervisor
#                        routes vision to the box too now).
#   --reasoning off      REQUIRED for agentic use. Qwen3.8 thinks by default
#                        (xhigh effort) and IGNORES /no_think, which is the
#                        supervisor's suppression mechanism (bead yjr) — without
#                        this flag qwen-code sessions overflow the ctx window in
#                        3-5 tool calls (~10K thinking tokens/turn).
#   --spec-type draft-mtp  MTP speculative decode via the model's own MTP head
#                        (present in our self-quantized GGUFs): 9.55 -> 14.4 tps
#                        prose, 17.2 tps code. Exonerated in the OCR-misread
#                        A/B (MTP-on 4/6 vs MTP-off 2/6 — model perception edge).
#   --ctx-size 65536     qwen-code's session budget (~27.8K) crowds 32K; 64K
#                        costs ~0.5 tps and ~2.2 GB KV (28.1 GB dedicated total).
# Manifest id of CODER_MODEL (models/MANIFEST.json). Pinning the id makes the gate
# unambiguous when two entries share a basename+size (a re-quantized packager file);
# empty = match by path (check-path fails closed on ambiguity).
CODER_MANIFEST_ID="qwen3.8-27b-q6_k"
# mmproj is a served artifact too — prov_gate() check-paths it exactly like the
# model (RDR-016: everything llama-server loads is gated). Empty MMPROJ_MODEL
# drops the flag and the check together (text-only serving).
MMPROJ_MODEL='D:\models\qwen3.8-27b\mmproj-Qwen3.8-27B-F16.gguf'
MMPROJ_MANIFEST_ID="qwen3.8-27b-mmproj-f16"
CODER="$LL -m $CODER_MODEL${MMPROJ_MODEL:+ --mmproj $MMPROJ_MODEL} --reasoning off --spec-type draft-mtp --host 0.0.0.0 --port 1235 --n-gpu-layers 99 --ctx-size 65536 --flash-attn 1 --threads 16 --alias qwen --log-file D:\\logs\\coder-box.log${VARIANT:+ $VARIANT}"
KILLALL_B64=$(printf 'Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force' | iconv -t UTF-16LE | base64)
# Emits "<pid> <age-seconds>" for the process OWNING :1235 (age -1 if unreadable).
OWNERPID_B64=$(printf '$c = Get-NetTCPConnection -LocalPort 1235 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; $age = -1; if ($p) { $age = [int]((Get-Date) - $p.StartTime).TotalSeconds }; Write-Output "$($c.OwningProcess) $age" }' | iconv -t UTF-16LE | base64)
# Emits the CommandLine of the process OWNING :1235 (adoption gate, bead bm2).
OWNERCMD_B64=$(printf '$c = Get-NetTCPConnection -LocalPort 1235 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").CommandLine }' | iconv -t UTF-16LE | base64)
CODER_PID=0
LAUNCH_T0=0
# Serving-identity guards (bead bm2): liveness alone accepted a foreign b9596
# server for two days (2026-07-25) while the keepalive believed it owned b10078.
# EXPECTED_BUILD: the build tag baked into $LL ("b9596"). EXPECTED_PID: the
# :1235 owner resolved by write_state() right after our own launch; 0 = unknown
# (adopt the serving pid at the next check instead of reclaiming — a keepalive
# restart over a healthy server must not churn it).
EXPECTED_BUILD=${LL#*llama-}; EXPECTED_BUILD=${EXPECTED_BUILD%%\\*}
# BASE_BUILD: what buildok() actually compares against /props build_info.
# EXPECTED_BUILD is the full runtime id used for the provenance lookup
# (rt="llama.cpp@$EXPECTED_BUILD") and may carry a "-patched" suffix for an
# overlay runtime directory (e.g. "b10867-patched", RDR-016 overlay
# add-runtime) -- but upstream llama.cpp never bakes that suffix into its
# own build_info string (an overlay swaps one DLL, not the build's self-
# report), so the two must diverge for a patched build to pass. Set once
# EXPECTED_BUILD is final (after the format guard below); "-patched" is the
# only suffix an overlay id can carry (provenance.py's default-id
# convention), so a plain "%-patched" strip is exact, not a fuzzy trim.
BASE_BUILD=""
EXPECTED_PID=0
PIDCHECK_EVERY=15   # pid identity check cadence, in 20s cycles (~5 min): ssh isn't free
# Reclaim damping (bead 68a): identity-triggered reclaims are capped. An
# unbounded kill/retry loop against a contested :1235 is the documented cause
# of the 2026-07-24 hard resets (see the waitup comment). After MAX_RECLAIMS
# consecutive identity reclaims with no verified-stable pass in between, the
# guards STAND DOWN (liveness keepalive continues) until a human restarts the
# keepalive. Crash restarts (up() failing) never count toward the cap.
RECLAIMS=0
MAX_RECLAIMS=3
GUARDS_DOWN=0
BUILDCHK_DARK=0
up()    { curl -s --max-time 5 "http://$HOST:$1/v1/models" 2>/dev/null | grep -q '"name"'; }
# Reclaim only on a POSITIVE build mismatch. No/garbled /props response is NOT
# a mismatch — up() already gates liveness, and reclaiming on transient curl
# failure would relaunch a healthy server on every network blip (the 2026-08-04
# flapping class). Going dark is logged once (not per-cycle) so silent
# degradation of the guard is operator-visible without spamming the log.
# build_info is "b9596-18ef86ece" today; the (-|") alternation also accepts a
# bare "b9596" so a future build without a commit-hash suffix cannot turn this
# guard into a permanent reclaim trigger against a correctly-built server.
buildok() {
  local bi
  bi=$(curl -s --max-time 5 "http://$HOST:1235/props" 2>/dev/null | grep -o '"build_info":"[^"]*"')
  if [ -z "$bi" ]; then
    [ "$BUILDCHK_DARK" -eq 0 ] && { log "build check dark — /props returned no build_info (liveness still guarded)"; BUILDCHK_DARK=1; }
    return 0
  fi
  [ "$BUILDCHK_DARK" -eq 1 ] && { log "build check recovered"; BUILDCHK_DARK=0; }
  [ -z "$BASE_BUILD" ] && return 0
  printf '%s' "$bi" | grep -qE "\"build_info\":\"$BASE_BUILD(-|\")"
}
ownerpid() { $SSH "$HOST" "powershell -NoProfile -EncodedCommand $OWNERPID_B64" 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+ -?[0-9]+$' | head -1 | cut -d' ' -f1; }
ownercmd() { $SSH "$HOST" "powershell -NoProfile -EncodedCommand $OWNERCMD_B64" 2>/dev/null | tr -d '\r' | grep 'llama-server' | head -1 | sed 's/"//g; s/[[:space:]]*$//'; }
reclaim() {  # $1 = reason. Counts toward the stand-down cap; crash restarts don't.
  RECLAIMS=$((RECLAIMS+1))
  if [ "$RECLAIMS" -gt "$MAX_RECLAIMS" ]; then
    GUARDS_DOWN=1
    log "identity guards STANDING DOWN after $MAX_RECLAIMS reclaims ($1 persists) — liveness-only until keepalive restart"
    return
  fi
  log "reclaiming :1235 ($1, attempt $RECLAIMS/$MAX_RECLAIMS)"
  start_coder
}
# Adoption gate (bm2): a fresh keepalive over a live server must not churn it —
# but only a server running OUR EXACT cmdline is adopted as ours. Same-build-
# different-flags (36p's documented un-remediation vector, e.g. a restored
# Startup .cmd with --cache-reuse) is a foreign server and gets reclaimed.
# Quote-stripped equality: Win32_Process quotes the exe path, $CODER doesn't.
adopt() {
  local pid cmd want
  pid=$1
  cmd=$(ownercmd)
  [ -z "$cmd" ] && return   # transient — retry next cycle, adopt nothing on no data
  want=$(printf '%s' "$CODER" | sed 's/"//g')
  if [ "$cmd" = "$want" ]; then
    EXPECTED_PID=$pid
    log "adopted serving pid $pid (build + cmdline verified)"
    write_state   # keep state json honest for the adopted server too
  else
    reclaim "foreign cmdline on :1235 (pid $pid)"
  fi
}
log()   { echo "$(date '+%H:%M:%S') $*"; }
# RDR-016 provenance gate. Before every launch: is the model file (and the runtime
# build) in models/MANIFEST.json, status verified, verified_on box, and is the box
# file's byte length what the manifest says? Cheap (one ssh for the length, no
# hashing — a 50 GB re-hash per respawn is not acceptable, and bulk reads have
# surprise-removed D: — see T2 box-nvme-d-drive-surprise-removal). Refuse to launch
# otherwise. QWEN_PROVENANCE_ENFORCE=0 is the documented escape hatch: it launches
# anyway and logs the bypass on EVERY launch so it is a visible, reviewable event.
REPO_DIR="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)"
PROV="$REPO_DIR/scripts/ops/provenance/provenance.py"
# launchd's PATH puts /usr/bin first, so bare `python3` is macOS's 3.9.6. The tool
# runs on 3.9 (its suite passes there), but prefer Homebrew's current python when
# present so the gate does not silently depend on the oldest interpreter on the box.
PYTHON=$(command -v /opt/homebrew/bin/python3 2>/dev/null || command -v python3 2>/dev/null || echo python3)
PROVENANCE_ENFORCE=${QWEN_PROVENANCE_ENFORCE:-1}
PROV_MODEL_ID=""; PROV_RUNTIME_ID=""; PROV_MMPROJ_ID=""; PROV_REFUSED=0
boxlen() {  # $1 = windows path -> byte length (empty on failure)
  local b64
  b64=$(printf "(Get-Item -LiteralPath '%s' -ErrorAction SilentlyContinue).Length" "$1" | iconv -t UTF-16LE | base64)
  $SSH "$HOST" "powershell -NoProfile -EncodedCommand $b64" 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' | head -1
}
prov_gate() {  # sets PROV_MODEL_ID / PROV_RUNTIME_ID; returns 1 with PROV_REASON on refusal
  local len rt
  PROV_REASON=""
  if [ ! -f "$PROV" ]; then PROV_REASON="provenance tool missing at $PROV"; return 1; fi
  # Bootstrap: an EMPTY manifest is the not-yet-populated state (RDR-016 Approach
  # step 4 lands the retro entries), not a bypass — arm the gate only once the
  # manifest has entries. Logged every launch so the unarmed state is visible.
  # Only a well-formed manifest with zero artifacts is "empty"; a missing python3,
  # a missing/unreadable file, or malformed JSON is a gate FAILURE (fail closed).
  local n
  n=$("$PYTHON" -c 'import json,sys
try:
    print(len(json.load(open(sys.argv[1])).get("artifacts",[])))
except Exception as e:
    print("ERR " + type(e).__name__); sys.exit(3)' "$REPO_DIR/models/MANIFEST.json" 2>/dev/null)
  case "$n" in
    0) log "provenance gate UNARMED — models/MANIFEST.json has no artifacts yet (bootstrap); launching unverified"
       PROV_MODEL_ID="unarmed:empty-manifest"; PROV_RUNTIME_ID="unarmed:empty-manifest"; PROV_MMPROJ_ID="unarmed:empty-manifest"; return 0 ;;
    [1-9]*) ;;
    *) PROV_REASON="manifest unreadable or $PYTHON unavailable (${n:-no output}) — refusing, not bootstrapping"; return 1 ;;
  esac
  len=$(boxlen "$CODER_MODEL")
  if [ -z "$len" ]; then PROV_REASON="could not stat $CODER_MODEL on box"; return 1; fi
  PROV_MODEL_ID=$("$PYTHON" "$PROV" check-path "$CODER_MODEL" --host box --size "$len" --print-id ${CODER_MANIFEST_ID:+--id "$CODER_MANIFEST_ID"} 2>/tmp/prov-gate.err) \
    || { PROV_REASON="model not verified: $(tr -d '\n' </tmp/prov-gate.err)"; return 1; }
  # The mmproj on the CODER line is loaded by llama-server the same as the model;
  # RDR-016's invariant covers it identically (substantive-critic finding, PR #86).
  if [ -n "${MMPROJ_MODEL:-}" ]; then
    len=$(boxlen "$MMPROJ_MODEL")
    if [ -z "$len" ]; then PROV_REASON="could not stat $MMPROJ_MODEL on box"; return 1; fi
    PROV_MMPROJ_ID=$("$PYTHON" "$PROV" check-path "$MMPROJ_MODEL" --host box --size "$len" --print-id ${MMPROJ_MANIFEST_ID:+--id "$MMPROJ_MANIFEST_ID"} 2>/tmp/prov-gate.err) \
      || { PROV_REASON="mmproj not verified: $(tr -d '\n' </tmp/prov-gate.err)"; return 1; }
  fi
  rt="llama.cpp@${EXPECTED_BUILD:-unknown}"
  len=$(boxlen "$LL")
  if [ -z "$len" ]; then PROV_REASON="could not stat $LL on box"; return 1; fi
  PROV_RUNTIME_ID=$("$PYTHON" "$PROV" check-path llama-server.exe --host box --id "$rt" --size "$len" --print-id 2>/tmp/prov-gate.err) \
    || { PROV_REASON="runtime not verified ($rt): $(tr -d '\n' </tmp/prov-gate.err)"; return 1; }
  # Overlay runtimes (RDR-016 overlay add-runtime) swap ONE file inside the
  # official release tree (e.g. ggml-vulkan.dll) without touching
  # llama-server.exe's own hash/size, so the check above alone would pass a
  # box with a stale or reverted DLL sitting next to a verified exe. Gate
  # that file too, but ONLY when $rt's own manifest entry actually carries
  # an `overlay` object -- a plain runtime (b9596: no overlay) launches with
  # byte-identical behavior to before this block existed. Like every other
  # check-path call in this gate, this is membership + SIZE only, not a
  # hash re-check -- a full byte-for-byte re-verification is
  # `verify --root`/`--listing` on demand, not the per-respawn gate.
  local overlay_file overlay_path
  overlay_file=$("$PYTHON" -c 'import json, sys
try:
    m = json.load(open(sys.argv[1]))
    for a in m.get("artifacts", []):
        if a.get("id") == sys.argv[2]:
            print((a.get("overlay") or {}).get("file", ""))
            break
except Exception:
    pass' "$REPO_DIR/models/MANIFEST.json" "$rt" 2>/dev/null)
  if [ -n "$overlay_file" ]; then
    overlay_path="${LL%\\*}\\$overlay_file"
    len=$(boxlen "$overlay_path")
    if [ -z "$len" ]; then PROV_REASON="could not stat overlay file $overlay_path on box"; return 1; fi
    "$PYTHON" "$PROV" check-path "$overlay_path" --host box --id "$rt" --size "$len" >/tmp/prov-gate.err 2>&1 \
      || { PROV_REASON="overlay file not verified ($rt $overlay_file): $(tr -d '\n' </tmp/prov-gate.err)"; return 1; }
  fi
  return 0
}
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
  local pid age ts json ps b64 src owner elapsed
  # PID of the process that OWNS :1235 — not tasklist's first llama-server row,
  # which credits a lingering husk when one is resident (bead c7c: state json
  # advertised a dead/non-serving pid twice, 2026-07-26 and 2026-08-04).
  read -r pid age <<<"$($SSH "$HOST" "powershell -NoProfile -EncodedCommand $OWNERPID_B64" 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+ -?[0-9]+$' | head -1)"
  src=owner-query
  # Honest owner attribution (bead 4ru): a process older than this start_coder
  # cycle predates our launch — e.g. the box Startup launcher's instance surviving
  # a failed killremote. Age vs elapsed are both durations, so clock skew cancels.
  owner=PEER-keepalive
  elapsed=$((SECONDS - LAUNCH_T0))
  if [ -n "${age:-}" ] && [ "$age" -gt $((elapsed + 60)) ] 2>/dev/null; then
    owner="preexisting-not-this-launch"
  fi
  if [ -z "${pid:-}" ] || [ "$pid" = "0" ]; then
    pid=$($SSH "$HOST" 'tasklist /FI "IMAGENAME eq llama-server.exe" /FO CSV /NH' 2>/dev/null | head -1 | cut -d'"' -f4)
    src=tasklist-fallback   # can still credit a husk — visible in the log line
  fi
  # Arm the bm2 pid-identity guard only from an authoritative resolution; a
  # fallback pid may be a husk, and guarding on it would reclaim the real server.
  if [ "$src" = owner-query ]; then EXPECTED_PID=$pid; else EXPECTED_PID=0; fi
  ts=$(date '+%Y-%m-%dT%H:%M:%S%z')
  json="{\"pid\": ${pid:-null}, \"launched_at\": \"$ts\", \"owner\": \"$owner\", \"variant\": \"$VARIANT\", \"env\": \"$ENVSET\", \"cmdline\": \"$(printf '%s' "$CODER" | sed 's/\\/\\\\/g; s/"/\\"/g')\", \"provenance\": {\"model_id\": \"${PROV_MODEL_ID:-}\", \"mmproj_id\": \"${PROV_MMPROJ_ID:-}\", \"runtime_id\": \"${PROV_RUNTIME_ID:-}\", \"enforce\": \"$PROVENANCE_ENFORCE\"}}"
  ps="Set-Content -Path D:\claude-coordination\qwen-server-state.json -Value '$json'"
  b64=$(printf '%s' "$ps" | iconv -t UTF-16LE | base64)
  $SSH "$HOST" "powershell -NoProfile -EncodedCommand $b64" >/dev/null 2>&1
  log "state json written (pid ${pid:-unknown} via $src, owner $owner)"
}
start_coder() {
  if ! prov_gate; then
    if [ "$PROVENANCE_ENFORCE" = "0" ]; then
      log "PROVENANCE BYPASS (QWEN_PROVENANCE_ENFORCE=0): $PROV_REASON — launching anyway"
    else
      # Log once per refusal streak, then back off: a refused launch is not a crash to
      # retry every 20 s. Re-checked each cycle so a manifest fix is picked up.
      [ "$PROV_REFUSED" -eq 0 ] && log "REFUSING to launch coder-box — $PROV_REASON (fix the manifest: /qwen-stack:provenance; or QWEN_PROVENANCE_ENFORCE=0 to bypass, logged)"
      PROV_REFUSED=1
      sleep 280
      return 1
    fi
  fi
  [ "$PROV_REFUSED" -eq 1 ] && log "provenance gate now passes (model $PROV_MODEL_ID, runtime $PROV_RUNTIME_ID)"
  PROV_REFUSED=0
  log "starting coder-box (alone) [provenance: model=${PROV_MODEL_ID:-bypass}${PROV_MMPROJ_ID:+ mmproj=$PROV_MMPROJ_ID} runtime=${PROV_RUNTIME_ID:-bypass}]"
  LAUNCH_T0=$SECONDS
  CYC=0
  kpid "$CODER_PID"; killremote; sleep 8
  if [ -n "$ENVSET" ]; then
    # cmd 'set NAME=VALUE&&' (no space before &&: a space would join the value)
    $SSH "$HOST" "cmd /c \"set $ENVSET&& $CODER\"" >/dev/null 2>&1 & CODER_PID=$!
  else
    $SSH "$HOST" "$CODER" >/dev/null 2>&1 & CODER_PID=$!
  fi
  waitup 1235 && { log "coder-box UP"; write_state; } || { log "coder-box FAILED to come up"; EXPECTED_PID=0; }
}
trap 'log "shutdown; killing held ssh"; kpid "$CODER_PID"; exit 0' TERM INT
# Fail loud, not broken: an unparsable build tag (a future $LL path-format
# change) must not leave a guard that can never match — that would be a
# permanent reclaim trigger against a correctly-built server.
case "$EXPECTED_BUILD" in
  b[0-9]*) ;;
  *) log "WARN: unparsable build tag from LL ('$EXPECTED_BUILD') — build guard disabled"; EXPECTED_BUILD="" ;;
esac
BASE_BUILD=${EXPECTED_BUILD%-patched}
BUILDGUARD_NOTE=""
[ -n "$BASE_BUILD" ] && [ "$BASE_BUILD" != "$EXPECTED_BUILD" ] && BUILDGUARD_NOTE=" (build_info compared against $BASE_BUILD)"
log "keepalive started (pid $$) — coder-box only (build guard: ${EXPECTED_BUILD:-off})$BUILDGUARD_NOTE"
CYC=0
while true; do
  if ! up 1235; then
    log "coder-box DOWN"
    start_coder
  elif [ "$GUARDS_DOWN" -eq 1 ]; then
    :  # stood down (reclaim cap) — liveness duty only
  elif ! buildok; then
    # Liveness passed but a DIFFERENT build is serving :1235 — a foreign
    # launcher's instance (bm2: the 2026-07-25 two-day blind spot).
    reclaim "wrong build on :1235 (want $EXPECTED_BUILD)"
  else
    CYC=$((CYC+1))
    if [ "$EXPECTED_PID" -eq 0 ] || [ $((CYC % PIDCHECK_EVERY)) -eq 0 ]; then
      pid=$(ownerpid)
      if [ -z "$pid" ]; then
        :  # transient ssh failure — no data is not a mismatch; don't reclaim
      elif [ "$EXPECTED_PID" -eq 0 ]; then
        adopt "$pid"
      elif [ "$pid" != "$EXPECTED_PID" ]; then
        reclaim "pid changed ($EXPECTED_PID -> $pid), not the server we launched"
      else
        RECLAIMS=0  # identity verified stable — reset the stand-down counter
      fi
    fi
  fi
  sleep 20
done
