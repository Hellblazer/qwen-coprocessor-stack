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
# /slots shapes come from fixtures/slots-b11541.json, a real llama-server b11541 response
# (compact, 4 slots, next_token an array); the busy variants are derived from it.
# Usage: /bin/bash scripts/ops/tests/test-keepalive-inference-dead.sh   (a few seconds).
# KA=<path> runs the suite against another copy of the script (used to mutation-check the tests).
# Exits non-zero if any case is wrong.
set -u
here=$(cd "$(dirname "$0")" && pwd)
ka="${KA:-$here/../keepalive-coprocessor.sh}"
fx="$here/fixtures/slots-b11541.json"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed -n -e '/^# Inference probe (bead ffsc)/,/^# Reclaim only on a POSITIVE/p' "$ka" | sed '$d' > "$tmp/fns.sh"
sed -n -e '/^json_esc() {/,/^}$/p' -e '/^write_state() {/,/^}$/p' -e '/^start_coder() {/,/^}$/p' \
       -e '/^prov_reason_class() {/,/^}$/p' -e '/^prov_mark() {/,/^}$/p' -e '/^prov_ids_clear() {.*}$/p' \
       -e '/^ownerpid() {.*}$/p' -e '/^kpid() .*}$/p' -e '/^killremote() {.*}$/p' "$ka" >> "$tmp/fns.sh"
for f in infer_probe probe_step probe_stall_step probe_stall_reset probe_stall_note probe_note_sig probe_off_set notify_sam oob_read slot_sig json_esc write_state start_coder \
         prov_reason_class prov_mark prov_ids_clear ownerpid kpid killremote; do
  grep -q "^$f() *{" "$tmp/fns.sh" || { echo "FAIL: $f not found in $ka"; exit 1; }
done
# The main loop, one iteration: the trailing sleep becomes a break.
sed -n '/^CYC=0$/,$p' "$ka" | sed -e 's/^  sleep 20$/  break/' -e 's/^CYC=0$/CYC=${CYC0:-0}/' > "$tmp/loop.sh"
grep -q '^  break$' "$tmp/loop.sh" || { echo "FAIL: main loop not found in $ka"; exit 1; }
# The startup validation of QWEN_PROBE_STALL_MAX (a bare case block plus the minimum clamp in the script body).
# The SELFTEST block (it ends in exit, so it is run in a subshell).
sed -n '/^if \[ "\${QWEN_KEEPALIVE_SELFTEST:-0}" = "1" \]; then$/,/^fi$/p' "$ka" > "$tmp/selftest.sh"
grep -q "SELFTEST done" "$tmp/selftest.sh" || { echo "FAIL: SELFTEST block not found in $ka"; exit 1; }
sed -n '/^case "\$PROBE_STALL_MAX" in$/,/^fi$/p' "$ka" > "$tmp/envcheck.sh"
grep -q "^fi$" "$tmp/envcheck.sh" || { echo "FAIL: PROBE_STALL_MAX validation not found in $ka"; exit 1; }

# Real definitions of the ssh wrapper and the encoded commands the fake ssh decodes.
eval "$(grep '^SSH=' "$ka")"
eval "$(grep '^KILLALL_B64=' "$ka")"
eval "$(grep '^OWNERPID_B64=' "$ka")"
eval "$(grep '^OOB_B64=' "$ka")"
HOST=box
EVENTS="$tmp/events"; STATE_OUT="$tmp/state.json"; : > "$EVENTS"; : > "$tmp/sshcalls"; rm -f "$tmp/sshviol"

# --- fakes -------------------------------------------------------------------
# curl: /slots returns FAKE_SLOTS with @N@ replaced by SLOT_TICK (so a test can make the
# counters move); /completion returns FAKE_COMP: ok | timeout (rc 28) | transport (rc 7) | 503.
SLOT_TICK=0; FAKE_SLOTS=""; FAKE_COMP=ok
# The 25 s /slots re-read (after a probe timeout) returns FAKE_SLOTS25 when that is set, else FAKE_SLOTS.
# Placeholders: @N@ tick, @D@ decoded tokens (45/tick), @R@ n_remain, @P@ prompt tokens processed (4096/tick).
curl() {
  local a url="" long=0 body
  for a in "$@"; do url=$a; [ "$a" = 25 ] && long=1; done
  case "$url" in
    */slots)
      body=$FAKE_SLOTS
      if [ "$long" = 1 ]; then echo x >> "$tmp/slots25calls"; body=${FAKE_SLOTS25-$FAKE_SLOTS}; fi
      body=${body//@N@/$SLOT_TICK}; body=${body//@D@/$((SLOT_TICK * 45))}
      body=${body//@R@/$((16384 - SLOT_TICK * 45))}; body=${body//@P@/$((SLOT_TICK * 4096))}
      printf '%s' "$body"; return 0 ;;
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
# osascript: records the notification text; FAKE_OSA_FAIL=1 makes it fail.
osascript() { echo "$*" >> "$tmp/notes"; [ "${FAKE_OSA_FAIL:-0}" = 1 ] && return 1; return 0; }
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
    *LOGSIZE=*)
      # the out-of-band read: FAKE_OOB = fail (ssh error) | grow (log grows 100 B per read) | hold (same size)
      echo x >> "$tmp/oobcalls"; printf '%s' "$script" > "$tmp/oobscript"
      case "${FAKE_OOB:-fail}" in
        fail) return 255 ;;
        junk) echo "LOGSIZE=abc" ;;
        empty) return 0 ;;
        missing) echo "LOGSIZE=-1" ;;
        crlf) printf 'LOGSIZE=4321\r\n' ;;
        grow) echo $(( $(cat "$tmp/oobsize" 2>/dev/null || echo 1000) + 100 )) > "$tmp/oobsize"; echo "LOGSIZE=$(cat "$tmp/oobsize")" ;;
        hold) echo "LOGSIZE=$(cat "$tmp/oobsize" 2>/dev/null || echo 1000)" ;;
      esac ;;
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
  unset FAKE_SLOTS25 QWEN_KEEPALIVE_NOTIFY NOTIFY_T_reclaim NOTIFY_T_stands NOTIFY_T_held
  FAKE_OOB=fail; FAKE_OSA_FAIL=0; PROBE_OOB_PREV=""; PROBE_HELD=0; PROBE_OFF_ALERT_T=0; PROBE_NOTE_SIG=""
  : > "$tmp/notes"; : > "$tmp/oobcalls"; : > "$tmp/slots25calls"; rm -f "$tmp/oobsize"
  SECONDS=100000
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
expect "log shows count/threshold" "1" "$(count 'STALLED (timed out after 60 s; slot counters unreadable, box log size unreadable), stalls 3/5' "$tmp/log")"
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
for v in 1 2; do
  PROBE_STALL_MAX=$v; : > "$tmp/log"; . "$tmp/envcheck.sh"
  expect "QWEN_PROBE_STALL_MAX '$v' is clamped to 3 + warning" "3/1" "$PROBE_STALL_MAX/$(count 'below the minimum of 3' "$tmp/log")"
done
PROBE_STALL_MAX=3; : > "$tmp/log"; . "$tmp/envcheck.sh"; expect "QWEN_PROBE_STALL_MAX 3 is kept, no warning" "3/0" "$PROBE_STALL_MAX/$(count WARN "$tmp/log")"
PROBE_STALL_MAX=0; : > "$tmp/log"; . "$tmp/envcheck.sh"; expect "QWEN_PROBE_STALL_MAX 0 still disables, no warning" "0/0" "$PROBE_STALL_MAX/$(count WARN "$tmp/log")"
for v in abc "" -1 2.5; do
  PROBE_STALL_MAX=$v; : > "$tmp/log"; . "$tmp/envcheck.sh"
  expect "invalid QWEN_PROBE_STALL_MAX '$v' -> 5 + warning" "5/1" "$PROBE_STALL_MAX/$(count 'WARN: QWEN_PROBE_STALL_MAX' "$tmp/log")"
done
PROBE_STALL_MAX=7; : > "$tmp/log"; . "$tmp/envcheck.sh"; expect "valid value kept" "7/0" "$PROBE_STALL_MAX/$(count WARN "$tmp/log")"

# 11: the real b11541 /slots shape (fixtures/slots-b11541.json) and busy variants derived from it
python3 -I - "$fx" "$tmp" <<'PY'
import json, sys
src, out = sys.argv[1:3]
base = json.load(open(src))
D, P, R = 11111111, 22222222, 33333333   # sentinels that become @D@ @P@ @R@ placeholders
def variant(name, f):
    d = json.loads(json.dumps(base))
    for s in d:
        s["is_processing"] = True
        f(s)
    t = json.dumps(d, separators=(",", ":")).replace(str(D), "@D@").replace(str(P), "@P@").replace(str(R), "@R@")
    open(f"{out}/{name}.json", "w").write(t)
def frozen(s):
    s["n_prompt_tokens"] = 30000; s["n_prompt_tokens_processed"] = 30000
    s["next_token"][0]["n_decoded"] = 100 + s["id"]; s["next_token"][0]["n_remain"] = 16284 - s["id"]
def decode(s):   # slot 0 decodes (n_decoded/n_remain move, inside next_token[0]); the others are frozen
    frozen(s)
    if s["id"] == 0: s["next_token"][0]["n_decoded"] = D; s["next_token"][0]["n_remain"] = R
def prefill(s):  # slot 0 prefills: ONLY n_prompt_tokens_processed moves; the others are frozen
    frozen(s)
    if s["id"] == 0:
        s["n_prompt_tokens"] = 600000; s["n_prompt_tokens_processed"] = P
        s["next_token"][0]["n_decoded"] = 0; s["next_token"][0]["n_remain"] = -1
variant("busy-frozen", frozen); variant("busy-decode", decode); variant("busy-prefill", prefill)
PY
RS_IDLE=$(cat "$fx"); RS_FROZEN=$(cat "$tmp/busy-frozen.json"); RS_DECODE=$(cat "$tmp/busy-decode.json"); RS_PREFILL=$(cat "$tmp/busy-prefill.json")
expect "real shape: the signature carries 4 slots x (id_task, n_prompt_tokens_processed, n_remain, n_decoded)" "16" "$(slot_sig "$RS_IDLE" | grep -o '"[a-z_]*":' | wc -l | tr -d ' ')"
expect "real shape: n_prompt_tokens_processed is in the signature" "4" "$(slot_sig "$RS_IDLE" | grep -o 'n_prompt_tokens_processed' | wc -l | tr -d ' ')"
reset; FAKE_SLOTS="$RS_FROZEN"
cycles 1; expect "real shape, busy frozen: first sample is a baseline" "0/0" "$PROBE_STALLS/$(kills)"
cycles 4; expect "real shape, busy frozen: 4 stalls, nothing yet" "4/0" "$PROBE_STALLS/$(kills)"
cycles 1; expect "real shape, busy frozen: 5th stall reclaims" "1/1" "$(kills)/$(launches)"
reset; FAKE_SLOTS="$RS_DECODE"; TICK=1; cycles 12
expect "real shape, busy, decode moving (n_decoded/n_remain in next_token[0]) x12: never reclaimed" "0/0/0" "$(kills)/$(launches)/$PROBE_STALLS"
reset; FAKE_SLOTS="$RS_PREFILL"; TICK=1; cycles 12
expect "real shape, busy, prefill-only moving (n_prompt_tokens_processed) x12: never reclaimed" "0/0/0" "$(kills)/$(launches)/$PROBE_STALLS"
reset; FAKE_SLOTS="$RS_IDLE"; FAKE_COMP=timeout; cycles 3
expect "real shape, all slots idle + timeout: hard failure after 3 strikes" "1/1" "$(kills)/$(launches)"
reset; FAKE_SLOTS="$RS_IDLE"; FAKE_COMP=ok; cycles 12
expect "real shape, all slots idle + completion ok: healthy, nothing logged as a stall" "0/0/0" "$(kills)/$PROBE_STALLS/$(count STALLED "$tmp/log")"

# 12: /slots unreadable (the 2026-11-26/27 shape): re-read with --max-time 25, then an out-of-band reading
# 12a: the box log keeps growing -> progress, never reclaimed (the ssh fake returns a growing size)
reset; FAKE_COMP=timeout; FAKE_SLOTS=""; FAKE_OOB=grow; cycles 20
expect "unreadable /slots + growing box log x20: no kill, no launch, no stall" "0/0/0" "$(kills)/$(launches)/$PROBE_STALLS"
expect "unreadable /slots: re-read with --max-time 25 happened every probe" "20" "$(wc -l < "$tmp/slots25calls" | tr -d ' ')"
expect "unreadable /slots: out-of-band read happened every probe" "20" "$(wc -l < "$tmp/oobcalls" | tr -d ' ')"
expect "growing log is logged as progress" "yes" "$([ "$(count 'the box log moved' "$tmp/log")" -ge 10 ] && echo yes || echo no)"
# 12b: the box log is silent (constant size): the first reading is a baseline, then 5 stalls reclaim
reset; FAKE_COMP=timeout; FAKE_SLOTS=""; FAKE_OOB=hold; cycles 5
expect "silent log, probe 5: baseline + 4 stalls, no kill" "4/0" "$PROBE_STALLS/$(kills)"
cycles 1
expect "silent log, probe 6: reclaimed" "1/1" "$(kills)/$(launches)"
expect "silent log: stall line names the evidence" "yes" "$([ "$(count 'slot counters unreadable, box log size unchanged at' "$tmp/log")" -ge 5 ] && echo yes || echo no)"
# 12c: the log grows for a while, then stops: progress resets, then 5 silent probes reclaim
reset; FAKE_COMP=timeout; FAKE_SLOTS=""; FAKE_OOB=grow; cycles 8
FAKE_OOB=hold; cycles 4; expect "log stopped growing: 4 stalls, no kill" "4/0" "$PROBE_STALLS/$(kills)"
cycles 1; expect "log stopped growing: 5th stall reclaims" "1/1" "$(kills)/$(launches)"
# 12d: the out-of-band read itself fails: counted (that is the 11-26 shape), reclaim at 5
reset; FAKE_COMP=timeout; FAKE_SLOTS=""; FAKE_OOB=fail; cycles 5
expect "out-of-band read fails x5: reclaimed at 5" "1/1" "$(kills)/$(launches)"
expect "out-of-band read was attempted" "yes" "$([ "$(wc -l < "$tmp/oobcalls" | tr -d ' ')" -ge 5 ] && echo yes || echo no)"
# 12e: /slots fails at 5 s but answers the 25 s re-read with MOVING counters: progress, no ssh needed
reset; FAKE_COMP=timeout; FAKE_SLOTS=""; FAKE_SLOTS25='[{"id":0,"id_task":7,"next_token":[{"n_decoded":@N@,"n_remain":-1}]}]'; TICK=1; FAKE_OOB=fail
cycles 12
expect "re-read returns moving counters x12: no kill" "0/0/0" "$(kills)/$(launches)/$PROBE_STALLS"
expect "re-read returns counters: the out-of-band read is not needed" "0" "$(wc -l < "$tmp/oobcalls" | tr -d ' ')"
# 12f: the re-read returns FROZEN counters: compared against the previous probe, counted, reclaim at 5
reset; FAKE_COMP=timeout; FAKE_SLOTS=""; FAKE_SLOTS25='[{"id":0,"id_task":7,"next_token":[{"n_decoded":100,"n_remain":-1}]}]'; FAKE_OOB=grow
cycles 4; expect "re-read frozen counters: 4 stalls, no kill" "4/0" "$PROBE_STALLS/$(kills)"
cycles 1; expect "re-read frozen counters: reclaimed at 5" "1/1" "$(kills)/$(launches)"
expect "re-read frozen counters: out-of-band read not consulted" "0" "$(wc -l < "$tmp/oobcalls" | tr -d ' ')"
# 12g: readable /slots never triggers the re-read or the ssh read on a healthy probe
reset; FAKE_COMP=ok; FAKE_SLOTS="$RS_IDLE"; cycles 5
expect "healthy probe: no re-read, no out-of-band read" "0/0" "$(wc -l < "$tmp/slots25calls" | tr -d ' ')/$(wc -l < "$tmp/oobcalls" | tr -d ' ')"

# 13: the standing alert: hourly re-log, passive probe, macOS notification, state json
reset; FAKE_COMP=timeout; cycles 5; cycles 5; cycles 5
expect "stand-down: probing OFF, two kills, one ALERT STANDS" "1/2/1" "$PROBE_OFF/$(kills)/$(count 'ALERT STANDS: coder-box inference-dead' "$tmp/log")"
expect "stand-down: state json says probe_off 1, relaunches 2" "1/2" "$(field inference_probe.probe_off)/$(field inference_probe.relaunches)"
expect "notifications: the reclaims share one hourly slot, the stand-down has its own" "1/1" "$(count 'keepalive is relaunching it' "$tmp/notes")/$(count 'Check the box' "$tmp/notes")"
cycles 10
expect "while it stands: no further kill, no re-log within the hour" "2/1" "$(kills)/$(count 'ALERT STANDS' "$tmp/log")"
SECONDS=$((SECONDS + 1800)); cycles 1
expect "after 30 min: still no re-log" "1" "$(count 'ALERT STANDS' "$tmp/log")"
SECONDS=$((SECONDS + 1800)); cycles 1
expect "after an hour: ALERT STANDS is logged again" "2" "$(count 'ALERT STANDS' "$tmp/log")"
expect "after an hour: the notification repeats" "2" "$(count 'Check the box' "$tmp/notes")"
expect "while it stands: never a third kill (passive probe times out)" "2" "$(kills)"
FAKE_COMP=ok; cycles 1
expect "a probe that passes turns probing back ON, budget refunded" "0/0" "$PROBE_OFF/$PROBE_RELAUNCHES"
expect "passive probe recovery is logged" "1" "$(count 'probing back ON' "$tmp/log")"
expect "state json after recovery: probe_off 0" "0" "$(field inference_probe.probe_off)"
FAKE_COMP=timeout; cycles 5; expect "after recovery the reclaim works again" "3" "$(kills)"
# the hard-failure stand-down gets the same treatment
reset; FAKE_COMP=timeout; FAKE_SLOTS="$IDLE_SLOTS"; cycles 3; cycles 3; cycles 3
expect "hard-failure stand-down: probe_off 1 in the state json, notified" "1/1/1" "$PROBE_OFF/$(field inference_probe.probe_off)/$(count 'Check the box' "$tmp/notes")"
# notification can be muted, and a failing osascript never breaks the loop
reset; QWEN_KEEPALIVE_NOTIFY=0; FAKE_COMP=timeout; cycles 5; cycles 5; cycles 5
expect "QWEN_KEEPALIVE_NOTIFY=0: no notification, alerts still logged" "0/1" "$(wc -l < "$tmp/notes" | tr -d ' ')/$(count 'ALERT STANDS' "$tmp/log")"
reset; FAKE_OSA_FAIL=1; FAKE_COMP=timeout; cycles 5
expect "osascript failing: the reclaim still happens" "1/1" "$(kills)/$(launches)"
unset QWEN_KEEPALIVE_NOTIFY

# 14: the state json is rewritten when what it says changes, not on every stall
reset; FAKE_COMP=timeout; PROV_GATE_STATE="adopt-fail"; PROV_GATE_REASON="size mismatch"; PROV_GATE_CLASS="definitive"
cycles 12
expect "held reclaim x12 probes: 5 count changes + 1 hold change = 6 writes, not 12" "6" "$(count 'state json written' "$tmp/log")"
expect "state json: held 1" "1" "$(field inference_probe.held)"
probe_stall_note; expect "unchanged state: no write" "6" "$(count 'state json written' "$tmp/log")"
expect "held notification sent once" "1" "$(count 'reclaim is held' "$tmp/notes")"

# 15: SELFTEST logs the slot counters and the stall classification
reset; FAKE_COMP=ok; FAKE_SLOTS="$RS_FROZEN"; (QWEN_KEEPALIVE_SELFTEST=1; . "$tmp/selftest.sh") >/dev/null 2>&1
expect "SELFTEST logs the slot counters" "1" "$(count 'SELFTEST slot counters: "id_task":' "$tmp/log")"
expect "SELFTEST logs the stall classification" "1" "$(count 'SELFTEST stall classification: stall candidate (all slots busy)' "$tmp/log")"
reset; FAKE_COMP=timeout; FAKE_SLOTS=""; (QWEN_KEEPALIVE_SELFTEST=1; . "$tmp/selftest.sh") >/dev/null 2>&1
expect "SELFTEST with unreadable /slots says UNREADABLE" "1" "$(count 'SELFTEST slot counters: UNREADABLE' "$tmp/log")"
reset; FAKE_COMP=ok; FAKE_SLOTS="$RS_IDLE"; (QWEN_KEEPALIVE_SELFTEST=1; . "$tmp/selftest.sh") >/dev/null 2>&1
expect "SELFTEST on a healthy probe: not a stall" "1" "$(count 'SELFTEST stall classification: not a stall' "$tmp/log")"

# 16: the out-of-band read is a handle read, not Get-Item (bead gc44): Get-Item .Length is the NTFS
# directory-entry size and lags for a log llama-server holds open. The command is sent encoded, so
# ssh and PowerShell 5.1 quoting never see the double quotes; the decoded text is what runs on the box.
want_oob='$h = $null; try { $h = [IO.File]::Open("C:\logs\coder-box.log", "Open", "Read", "ReadWrite,Delete"); Write-Output ("LOGSIZE=" + $h.Length) } catch { Write-Output "LOGSIZE=-1" } finally { if ($h) { $h.Close() } }'
got_oob=$(printf '%s' "$OOB_B64" | base64 --decode | iconv -f UTF-16LE -t UTF-8)
expect "oob command text is the handle read, exactly" "$want_oob" "$got_oob"
expect "oob command no longer uses Get-Item" "0" "$(printf '%s' "$got_oob" | grep -c 'Get-Item')"
reset; FAKE_OOB=hold; echo 7777 > "$tmp/oobsize"; r=$(oob_read)
expect "oob_read sends the handle command over ssh (decoded text seen by the box)" "$want_oob" "$(cat "$tmp/oobscript")"
expect "oob_read parses a bare integer" "7777" "$r"
reset; FAKE_OOB=crlf; expect "oob_read strips the CR of a CRLF reply" "4321" "$(oob_read)"
reset; FAKE_OOB=junk; expect "oob_read: non-integer reply is empty (inconclusive)" "" "$(oob_read)"
reset; FAKE_OOB=empty; expect "oob_read: empty reply is empty (inconclusive)" "" "$(oob_read)"
reset; FAKE_OOB=missing; expect "oob_read: LOGSIZE=-1 (open failed) is empty (inconclusive)" "" "$(oob_read)"
reset; FAKE_OOB=fail; expect "oob_read: ssh failure is empty (inconclusive)" "" "$(oob_read)"
# inconclusive replies are counted exactly as an ssh failure is (12d): reclaim at 5
for m in junk empty missing; do
  reset; FAKE_COMP=timeout; FAKE_SLOTS=""; FAKE_OOB=$m; cycles 5
  expect "oob reply '$m' x5: counted like an ssh failure, reclaimed at 5" "1/1" "$(kills)/$(launches)"
  expect "oob reply '$m': stall line says unreadable" "yes" "$([ "$(count 'box log size unreadable' "$tmp/log")" -ge 4 ] && echo yes || echo no)"
done
# 16s: SELFTEST prints the box log size before and after its one probe request
reset; FAKE_COMP=ok; FAKE_SLOTS="$RS_IDLE"; FAKE_OOB=grow; (QWEN_KEEPALIVE_SELFTEST=1; . "$tmp/selftest.sh") >/dev/null 2>&1
expect "SELFTEST box log size line, growing log" "1" "$(count 'SELFTEST box log size: 1100 -> 1200 bytes (grew across the request)' "$tmp/log")"
reset; FAKE_COMP=ok; FAKE_SLOTS="$RS_IDLE"; FAKE_OOB=hold; echo 5000 > "$tmp/oobsize"; (QWEN_KEEPALIVE_SELFTEST=1; . "$tmp/selftest.sh") >/dev/null 2>&1
expect "SELFTEST box log size line, unchanged log" "1" "$(count 'SELFTEST box log size: 5000 -> 5000 bytes (UNCHANGED' "$tmp/log")"
reset; FAKE_COMP=ok; FAKE_SLOTS="$RS_IDLE"; FAKE_OOB=junk; (QWEN_KEEPALIVE_SELFTEST=1; . "$tmp/selftest.sh") >/dev/null 2>&1
expect "SELFTEST box log size line, unreadable" "1" "$(count 'SELFTEST box log size: UNREADABLE' "$tmp/log")"

# 10: invariants over the whole run: every ssh carried -n; kpid keeps its pid>0 guard
expect "no ssh without -n across the whole suite" "none" "$([ -s "$tmp/sshviol" ] && echo VIOLATED || echo none)"
grep -q '^kpid()  *{ \[ "\${1:-0}" -gt 0 \]' "$ka"; expect "kpid keeps its pid>0 guard (kill 0 signals the group)" "0" "$?"

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
