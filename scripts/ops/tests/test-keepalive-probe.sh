#!/bin/bash
# Offline test for the keepalive inference probe (bead ffsc): runs infer_probe and
# probe_step, extracted from keepalive-coprocessor.sh, against a fake llama-server
# in each failure mode. The main-loop wiring is not covered here; validate it with
# QWEN_KEEPALIVE_SELFTEST=1 and by reading the loop.
# Usage: bash scripts/ops/tests/test-keepalive-probe.sh   (python3 + curl; ~70 s,
# most of it the one 60 s hang case). Exits non-zero if any case is wrong.
set -u
here=$(cd "$(dirname "$0")" && pwd)
ka="$here/../keepalive-coprocessor.sh"
tmp=$(mktemp -d); P=0
trap '[ "$P" -gt 0 ] && kill "$P" 2>/dev/null; rm -rf "$tmp"' EXIT
sed -n '/^# Inference probe (bead ffsc)/,/^# Reclaim only on a POSITIVE/p' "$ka" | sed '$d' > "$tmp/fns.sh"
grep -q '^infer_probe()' "$tmp/fns.sh" && grep -q '^probe_step()' "$tmp/fns.sh" \
  || { echo "FAIL: probe block not found in $ka"; exit 1; }
cat > "$tmp/fake.py" <<'PY'
import http.server, sys, time
mode, port = sys.argv[1], int(sys.argv[2])
# llama-server's own /slots is compact JSON ("is_processing":false, no space).
SLOTS = {"busy":  '[' + ','.join(['{"id":%d,"is_processing":true}' % i for i in range(4)]) + ']',
         "mixed": '[{"id":0,"is_processing":true},{"id":1,"is_processing":false}]',
         "slotserr": '{"error":{"code":501,"message":"This server does not support slots endpoint."}}',
         "spaced": '[{"id":0, "is_processing": false}]'}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = SLOTS.get(mode, '[{"id":0,"is_processing":false},{"id":1,"is_processing":false}]').encode()
        self.send_response(501 if mode == "slotserr" else 200)
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        if mode == "drop": self.connection.close(); return
        if mode == "hang": time.sleep(70)
        if mode in ("500", "503"):
            self.send_response(int(mode)); self.end_headers(); self.wfile.write(b'{"error":"x"}'); return
        b = b'{"tokens_predicted":1}' if mode == "nocontent" else b'{"content":"ok","tokens_predicted":1}'
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
PY
HOST=127.0.0.1
log() { :; }
. "$tmp/fns.sh"
# A free port, set after sourcing so it overrides the shipped 1235.
PROBE_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
fails=0
serve() {
  python3 "$tmp/fake.py" "$1" "$PROBE_PORT" & P=$!
  for i in $(seq 1 50); do curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PROBE_PORT/slots" && return; sleep 0.1; done
  echo "FAIL: fake server did not start"; exit 1
}
stop() { [ "$P" -gt 0 ] && { kill "$P" 2>/dev/null; wait "$P" 2>/dev/null; }; P=0; }
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want $2 got $3"; fails=$((fails+1)); fi; }
# infer_probe: 0 generated, 1 hard, 2 inconclusive
for c in "ok 0" "spaced 0" "mixed 0" "slotserr 0" "busy 2" "500 1" "503 2" "nocontent 1" "drop 2" "hang 1"; do
  set -- $c; serve "$1"; infer_probe; expect "infer_probe $1" "$2" "$?"; stop
done
infer_probe; expect "infer_probe closed-port" 2 "$?"
# probe_step: not due for 14 cycles; then MAX_PROBE_FAILS consecutive hard failures
# relaunch, inconclusive in between neither counts nor resets.
PROBE_CYC=0; PROBE_FAILS=0; PROBE_RELAUNCHES=0; PROBE_OFF=0
serve 500; r=0; for i in $(seq 1 14); do probe_step || r=1; done
expect "probe_step not due" "0/0" "$r/$PROBE_FAILS"
probe_step; expect "probe_step fail 1" "0/1" "$?/$PROBE_FAILS"; stop
serve busy; probe_step; expect "probe_step inconclusive" "0/1" "$?/$PROBE_FAILS"; stop
serve 500; probe_step; expect "probe_step fail 2" "0/2" "$?/$PROBE_FAILS"
probe_step; expect "probe_step relaunch due" "1/0" "$?/$PROBE_RELAUNCHES"
# loop(): the main loop's handling of probe_step's verdict, with start_coder's
# outcome given as $1 (0 launched, 1 refused).
loop() { probe_step || { [ "$1" -eq 0 ] && { PROBE_FAILS=0; PROBE_RELAUNCHES=$((PROBE_RELAUNCHES + 1)); }; }; }
loop 0; expect "launched relaunch counts" "1/0" "$PROBE_RELAUNCHES/$PROBE_FAILS"
# refused launches never burn the budget or stand the probe down
PROBE_CYC=14; for i in 1 2 3 4 5 6; do loop 1; done
expect "refused launches do not count" "1/0" "$PROBE_RELAUNCHES/$PROBE_OFF"
PROBE_FAILS=0; PROBE_CYC=14; for i in 1 2 3; do loop 0; done
expect "second launched relaunch" "2/0" "$PROBE_RELAUNCHES/$PROBE_OFF"
PROBE_CYC=14; for i in 1 2 3; do loop 0; done
expect "probe_step stands down at cap" "2/1" "$PROBE_RELAUNCHES/$PROBE_OFF"
c=$PROBE_CYC; probe_step; expect "probe_step off stays off (no probe, no count)" "0/$c" "$?/$PROBE_CYC"; stop
# a passing probe clears both counters
PROBE_OFF=0; PROBE_FAILS=1; serve ok; probe_step; expect "probe_step recovery" "0/0/0" "$?/$PROBE_FAILS/$PROBE_RELAUNCHES"; stop
[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
