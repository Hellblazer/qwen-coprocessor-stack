#!/bin/bash
# shellcheck disable=SC2034  # variables are consumed by the sourced keepalive functions
# Offline test for bead i1y1: a llama-server that answers liveness but never completes
# must be reclaimed after QWEN_PROBE_STALL_MAX consecutive STALLED inference probes
# (2026-11-26/27: 207 "timed out -- not counted" probes over ~22 h, no action), and a
# server that is merely busy and still making progress must never be.
# infer_probe, probe_step and the stall helpers, write_state, start_coder and the main
# loop (one iteration per call, the trailing sleep becomes a break) are extracted from
# keepalive-coprocessor.sh and driven with a shell-function curl (the /slots body and
# the /completion outcome come from FAKE_* variables, so no probe waits 60 s) and a
# shell-function ssh that decodes the encoded PowerShell, records KILL / LAUNCH events,
# captures the state json and checks every call carries `ssh -n`. No box, no network.
# Usage: /bin/bash scripts/ops/tests/test-keepalive-inference-dead.sh   (a few seconds).
# Exits non-zero if any case is wrong.
set -u
here=$(cd "$(dirname "$0")" && pwd)
ka="$here/../keepalive-coprocessor.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed -n -e '/^# Inference probe (bead ffsc)/,/^# Reclaim only on a POSITIVE/p' "$ka" | sed '$d' > "$tmp/fns.sh"
sed -n -e '/^json_esc() {/,/^}$/p' -e '/^write_state() {/,/^}$/p' -e '/^start_coder() {/,/^}$/p' \
       -e '/^prov_reason_class() {/,/^}$/p' -e '/^prov_mark() {/,/^}$/p' -e '/^prov_ids_clear() {.*}$/p' \
       -e '/^ownerpid() {.*}$/p' -e '/^kpid() .*}$/p' -e '/^killremote() {.*}$/p' "$ka" >> "$tmp/fns.sh"
for f in infer_probe probe_step probe_stall_step probe_stall_reset probe_stall_note json_esc write_state start_coder \
         prov_reason_class prov_mark prov_ids_clear ownerpid kpid killremote; do
  grep -q "^$f() *{" "$tmp/fns.sh" || { echo "FAIL: $f not found in $ka"; exit 1; }
done
# The main loop, one iteration: the trailing sleep becomes a break.
sed -n '/^CYC=0$/,$p' "$ka" | sed -e 's/^  sleep 20$/  break/' -e 's/^CYC=0$/CYC=${CYC0:-0}/' > "$tmp/loop.sh"
grep -q '^  break$' "$tmp/loop.sh" || { echo "FAIL: main loop not found in $ka"; exit 1; }
# The startup validation of QWEN_PROBE_STALL_MAX (a bare case block in the script body).
sed -n '/^case "\$PROBE_STALL_MAX" in$/,/^esac$/p' "$ka" > "$tmp/envcheck.sh"
grep -q "esac" "$tmp/envcheck.sh" || { echo "FAIL: PROBE_STALL_MAX validation not found in $ka"; exit 1; }

# Real definitions of the ssh wrapper and the encoded commands the fake ssh decodes.
eval "$(grep '^SSH=' "$ka")"
eval "$(grep '^KILLALL_B64=' "$ka")"
eval "$(grep '^OWNERPID_B64=' "$ka")"
HOST=box
EVENTS="$tmp/events"; STATE_OUT="$tmp/state.json"; : > "$EVENTS"; : > "$tmp/sshcalls"; rm -f "$tmp/sshviol"

# --- fakes -------------------------------------------------------------------
# curl: /slots returns FAKE_SLOTS with @N@ replaced by SLOT_TICK (so a test can make the
# counters move); /completion returns FAKE_COMP: ok | timeout (rc 28) | transport (rc 7) | 503.
SLOT_TICK=0; FAKE_SLOTS=""; FAKE_COMP=ok
curl() {
  local a url=""
  for a in "$@"; do url=$a; done
  case "$url" in
    */slots) printf '%s' "${FAKE_SLOTS//@N@/$SLOT_TICK}"; return 0 ;;
    */completion)
      case "$FAKE_COMP" in
        ok)        printf '{"content":"ok"}\n200' ;;
        timeout)   return 28 ;;
        transport) return 7 ;;
        503)       printf '{}\n503' ;;
      esac ;;
  esac
  return 0
}
# ssh: every call must start with -n. Records KILL (the Stop-Process command) and LAUNCH
# (the llama-server launch line), answers the owner-pid query, captures the state json.
ssh() {
  [ "$1" = "-n" ] || echo "ssh-without-n" >> "$tmp/sshviol"
  echo call >> "$tmp/sshcalls"
  local cmd=${!#} script
  case "$cmd" in
    *llama-server.exe*--port*) echo LAUNCH >> "$EVENTS"; return 0 ;;
  esac
  script=$(printf '%s' "${cmd##* }" | base64 --decode 2>/dev/null | iconv -f UTF-16LE -t UTF-8 2>/dev/null)
  case "$script" in
    *Stop-Process*) echo KILL >> "$EVENTS" ;;
    *Get-NetTCPConnection*) [ -n "${FAKE_OWNER:-}" ] && echo "$FAKE_OWNER" ;;
    *Set-Content*)
      payload=$(printf '%s' "$script" | sed -e "s/^.*-Value '//" -e "s/'\$//")
      q="'"; printf '%s' "${payload//$q$q/$q}" > "$STATE_OUT" ;;
  esac
  return 0
}
log() { echo "$*" >> "$tmp/log"; }
sleep() { :; }
wait_for_session() { :; }
preflight() { return 0; }
waitup() { return 0; }
gpu_check() { GPU_LAST="53 GB dedicated"; return 0; }
prov_adopt_retry() { :; }
up() { return 0; }
buildok() { return 0; }
prov_gate() {
  if [ "${FAKE_GATE_FAIL:-0}" = 1 ]; then PROV_REASON="size mismatch"; return 1; fi
  PROV_MODEL_ID="model-id@abc"; PROV_RUNTIME_ID="rt@b1"; return 0
}

# --- globals the extracted code reads ---------------------------------------
LL='C:\llama-test\llama-server.exe'; EXPECTED_BUILD="b-test"; BASE_BUILD="b-test"
CODER_MODEL='C:\models\m.gguf'; MMPROJ_MODEL=""
CODER="$LL -m $CODER_MODEL --port 1235"; VARIANT=""; ENVSET="X=1"
PROVENANCE_ENFORCE=1; LAUNCH_T0=0; CODER_PID=0; GPU_LAST=""; GPU_ALERT=""; GPU_FAILS=0; MAX_GPU_RETRIES=2
PREFLIGHT_ENFORCE=1; PREFLIGHT_REFUSED=0; PREFLIGHT_ALERT=""; LAUNCH_DEAD=0; PROV_REFUSED=0
GUARDS_DOWN=0; RECLAIMS=0; MAX_RECLAIMS=3; PIDCHECK_EVERY=15; GPUCHK_EVERY=45; OWNERPID_DARK=0
LAUNCHED_AT=""; LAUNCHED_PID=""
. "$tmp/fns.sh"
PROBE_EVERY=1   # probe every cycle (set after sourcing: the shipped value is 15)

fails=0
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$2] got [$3]"; fails=$((fails+1)); fi; }
count() { grep -c "$1" "$2" 2>/dev/null; true; }   # grep -c prints 0 AND exits 1 on no match
field() { python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$STATE_OUT" "$1" 2>/dev/null || echo "<UNPARSEABLE>"; }
reset() {
  : > "$EVENTS"; : > "$tmp/log"; rm -f "$STATE_OUT"
  PROBE_STALL_MAX=5; MAX_PROBE_FAILS=3; MAX_PROBE_RELAUNCHES=2
  PROBE_FAILS=0; PROBE_CYC=0; PROBE_RELAUNCHES=0; PROBE_OFF=0
  PROBE_STALLS=0; PROBE_STALL=0; PROBE_SIG=""; PROBE_SIG_PREV=""; PROBE_STALL_ALERT_T=0
  PROV_GATE_STATE="launch-pass"; PROV_GATE_REASON=""; PROV_GATE_CLASS="none"; PROV_GATE_PID=""; PROV_GATE_AT=""; PROV_GATE_T=0
  PROV_MODEL_ID=""; PROV_RUNTIME_ID=""; PROV_MMPROJ_ID=""
  EXPECTED_PID=4242; CODER_PID=0; SLOT_TICK=0; FAKE_SLOTS=""; FAKE_COMP=ok; LAUNCHED_AT=""; LAUNCHED_PID=""
  FAKE_OWNER="4242 90"; FAKE_GATE_FAIL=0; TICK=0
}
# n main-loop iterations. SLOT_TICK advances each cycle when TICK=1 (moving counters).
cycles() {
  local i n=$1
  for i in $(seq 1 "$n"); do
    [ "$TICK" = 1 ] && SLOT_TICK=$((SLOT_TICK + 1))
    CYC0=0; . "$tmp/loop.sh"
    wait 2>/dev/null; CODER_PID=0   # the launch ssh is backgrounded; a finished pid is never signalled
  done
}
kills() { count '^KILL' "$EVENTS"; }
launches() { count '^LAUNCH' "$EVENTS"; }
IDLE_SLOTS='[{"id":0,"is_processing":false},{"id":1,"is_processing":false}]'
BUSY_FROZEN='[{"id":0,"id_task":7,"is_processing":true,"next_token":{"n_decoded":100,"n_remain":-1}},{"id":1,"id_task":8,"is_processing":true,"next_token":{"n_decoded":50,"n_remain":-1}}]'
BUSY_MOVING='[{"id":0,"id_task":7,"is_processing":true,"next_token":{"n_decoded":@N@,"n_remain":-1}},{"id":1,"id_task":8,"is_processing":true,"next_token":{"n_decoded":50,"n_remain":-1}}]'
BUSY_NOCOUNTERS='[{"id":0,"is_processing":true},{"id":1,"is_processing":true}]'

# 1: N timeouts in a row (/slots unreadable, the 2026-11-26 shape) -> alert + reclaim at the Nth, not before
reset; FAKE_COMP=timeout
cycles 4
expect "timeouts 4/5: nothing killed or launched" "0/0" "$(kills)/$(launches)"
expect "timeouts 4/5: count is 4" "4" "$PROBE_STALLS"
cycles 1
expect "timeouts 5/5: one kill, one launch" "1/1" "$(kills)/$(launches)"
expect "timeouts 5/5: ALERT logged" "1" "$(count 'ALERT: coder-box INFERENCE-DEAD: 5/5' "$tmp/log")"
expect "timeouts 5/5: kill precedes launch (one llama-server)" "KILL LAUNCH" "$(tr '\n' ' ' < "$EVENTS" | sed 's/ $//')"
expect "timeouts 5/5: stall count reset, relaunch counted" "0/1" "$PROBE_STALLS/$PROBE_RELAUNCHES"
expect "ssh was actually exercised" "yes" "$([ "$(wc -l < "$tmp/sshcalls")" -gt 5 ] && echo yes || echo no)"

# 2: below N does nothing; a success resets the count, so 3 + ok + 4 never reclaims
reset; FAKE_COMP=timeout
cycles 3; expect "3 timeouts: stalls 3, nothing done" "3/0" "$PROBE_STALLS/$(kills)"
FAKE_COMP=ok; cycles 1
expect "success resets the count" "0" "$PROBE_STALLS"
expect "success logged" "1" "$(count 'inference probe recovered (stalls 3 -> 0)' "$tmp/log")"
FAKE_COMP=timeout; cycles 4
expect "4 timeouts after a success: still below N" "4/0/0" "$PROBE_STALLS/$(kills)/$(launches)"

# 3: all slots busy AND progressing -> never reclaimed, logged as progressing
reset; FAKE_SLOTS="$BUSY_MOVING"; TICK=1
cycles 12
expect "busy+moving x12: no kill, no launch" "0/0" "$(kills)/$(launches)"
expect "busy+moving: count stays 0" "0" "$PROBE_STALLS"
expect "busy+moving: logged as progressing" "yes" "$([ "$(count 'slot counters are moving -- progressing, not counted' "$tmp/log")" -ge 5 ] && echo yes || echo no)"
# a timeout while the counters moved is progress too, not a stall
reset; FAKE_COMP=timeout; FAKE_SLOTS='[{"id":0,"id_task":7,"next_token":{"n_decoded":@N@}}]'; TICK=1
cycles 12; expect "timeout + moving counters x12: no kill" "0/0/0" "$(kills)/$(launches)/$PROBE_STALLS"
# busy with unreadable counters is unknown, not stalled
reset; FAKE_SLOTS="$BUSY_NOCOUNTERS"
cycles 12; expect "busy, counters unreadable x12: no kill" "0/0/0" "$(kills)/$(launches)/$PROBE_STALLS"
expect "busy, counters unreadable: logged" "yes" "$([ "$(count 'counters unreadable' "$tmp/log")" -ge 1 ] && echo yes || echo no)"
# busy and FROZEN is a stall: first sample is a baseline, then N frozen samples reclaim
reset; FAKE_SLOTS="$BUSY_FROZEN"
cycles 1; expect "busy frozen: first sample is a baseline" "0/0" "$PROBE_STALLS/$(kills)"
cycles 4; expect "busy frozen: 4 stalls, nothing yet" "4/0" "$PROBE_STALLS/$(kills)"
cycles 1; expect "busy frozen: 5th stall reclaims" "1/1" "$(kills)/$(launches)"
# progress part-way through a frozen run resets it
reset; FAKE_SLOTS="$BUSY_FROZEN"; cycles 4
FAKE_SLOTS="${BUSY_FROZEN//\"n_decoded\":100/\"n_decoded\":101}"; cycles 1
expect "busy frozen then a counter moves: count reset" "0/0" "$PROBE_STALLS/$(kills)"

# 4: other inconclusive results neither count nor reset
reset; FAKE_COMP=timeout; cycles 2
FAKE_COMP=transport; cycles 3; expect "transport errors: count unchanged" "2/0" "$PROBE_STALLS/$(kills)"
FAKE_COMP=503; cycles 3;       expect "HTTP 503: count unchanged" "2/0" "$PROBE_STALLS/$(kills)"
FAKE_COMP=timeout; cycles 2;   expect "stalls continue across them: 4" "4/0" "$PROBE_STALLS/$(kills)"

# 5: the existing hard-failure path is untouched (timeout WITH an idle slot, 3 strikes)
reset; FAKE_COMP=timeout; FAKE_SLOTS="$IDLE_SLOTS"
cycles 2; expect "idle-slot timeout x2: below MAX_PROBE_FAILS" "0/2" "$(kills)/$PROBE_FAILS"
cycles 1; expect "idle-slot timeout x3: relaunch (ffsc)" "1/1" "$(kills)/$(launches)"
expect "idle-slot timeouts are not stalls" "0" "$(count 'STALLED' "$tmp/log")"

# 6: provenance gate state forbids the reclaim
# 6a: adopt-time gate failed DEFINITIVELY: held, alerted once, server left running
reset; FAKE_COMP=timeout; PROV_GATE_STATE="adopt-fail"; PROV_GATE_REASON="size mismatch"; PROV_GATE_CLASS="definitive"
cycles 12
expect "adopt-fail definitive: no kill, no launch" "0/0" "$(kills)/$(launches)"
expect "adopt-fail definitive: hold ALERT logged once, not per cycle" "1" "$(count 'reclaim is HELD' "$tmp/log")"
expect "adopt-fail definitive: server stays adopted (EXPECTED_PID kept)" "4242" "$EXPECTED_PID"
# 6b: adopt-time failure that is only TRANSIENT does not block: start_coder re-gates and passes
reset; FAKE_COMP=timeout; PROV_GATE_STATE="adopt-fail"; PROV_GATE_REASON="could not stat x"; PROV_GATE_CLASS="transient"
cycles 5; expect "adopt-fail transient + gate now passes: reclaimed" "1/1" "$(kills)/$(launches)"
# 6c: the launch gate refuses inside start_coder: refused BEFORE the kill, nothing counted
reset; FAKE_COMP=timeout; FAKE_GATE_FAIL=1
cycles 5
expect "launch gate refuses: no kill, no launch" "0/0" "$(kills)/$(launches)"
expect "launch gate refuses: state is launch-refused" "launch-refused" "$PROV_GATE_STATE"
expect "launch gate refuses: relaunch budget untouched, stalls kept" "0/5" "$PROBE_RELAUNCHES/$PROBE_STALLS"
FAKE_GATE_FAIL=0; cycles 1
expect "gate fixed: next cycle reclaims" "1/1" "$(kills)/$(launches)"

# 7: bounded: after MAX_PROBE_RELAUNCHES with no passing probe, stand down, never kill again
reset; FAKE_COMP=timeout
cycles 5; cycles 5
expect "two reclaims happened" "2/2" "$(kills)/$(launches)"
cycles 5
expect "third threshold: probing OFF, ALERT STANDS, no third kill" "2/1/1" "$(kills)/$PROBE_OFF/$(count 'ALERT STANDS: coder-box inference-dead' "$tmp/log")"
# a passing probe in between refunds the budget
reset; FAKE_COMP=timeout; cycles 5; FAKE_COMP=ok; cycles 1
expect "a passing probe clears the relaunch budget" "0" "$PROBE_RELAUNCHES"

# 8: the counter and its threshold are visible: the log on every stall, the state json
reset; FAKE_COMP=timeout; cycles 3
expect "log shows count/threshold" "1" "$(count 'STALLED (timed out after 60 s; no sign of progress), stalls 3/5' "$tmp/log")"
expect "state json: stalls" "3" "$(field inference_probe.stalls)"
expect "state json: stall_max" "5" "$(field inference_probe.stall_max)"
expect "state json: last_reason" "timed out after 60 s" "$(field inference_probe.last_reason)"
reset; FAKE_COMP=timeout; PROBE_STALL_MAX=3; cycles 3
expect "threshold is a variable: 3 reclaims at 3" "1/1" "$(kills)/$(launches)"
expect "state json after the relaunch: counters reset, relaunch recorded" "0/3/1" "$(field inference_probe.stalls)/$(field inference_probe.stall_max)/$(field inference_probe.relaunches)"

# 9: QWEN_PROBE_STALL_MAX: default 5 in the script, 0 disables, garbage falls back to 5 with a warning
grep -q 'PROBE_STALL_MAX=${QWEN_PROBE_STALL_MAX:-5}' "$ka"; expect "default threshold is 5, env QWEN_PROBE_STALL_MAX" "0" "$?"
reset; PROBE_STALL_MAX=0; FAKE_COMP=timeout; cycles 20
expect "threshold 0 disables the stall reclaim" "0/0/0" "$(kills)/$(launches)/$PROBE_STALLS"
for v in abc "" -1 2.5; do
  PROBE_STALL_MAX=$v; : > "$tmp/log"; . "$tmp/envcheck.sh"
  expect "invalid QWEN_PROBE_STALL_MAX '$v' -> 5 + warning" "5/1" "$PROBE_STALL_MAX/$(count 'WARN: QWEN_PROBE_STALL_MAX' "$tmp/log")"
done
PROBE_STALL_MAX=7; : > "$tmp/log"; . "$tmp/envcheck.sh"; expect "valid value kept" "7/0" "$PROBE_STALL_MAX/$(count WARN "$tmp/log")"

# 10: invariants over the whole run: every ssh carried -n; kpid keeps its pid>0 guard
expect "no ssh without -n across the whole suite" "none" "$([ -s "$tmp/sshviol" ] && echo VIOLATED || echo none)"
grep -q '^kpid()  *{ \[ "\${1:-0}" -gt 0 \]' "$ka"; expect "kpid keeps its pid>0 guard (kill 0 signals the group)" "0" "$?"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
