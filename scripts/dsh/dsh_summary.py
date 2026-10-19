"""Summarise one dsh run: python3 dsh_summary.py EVENTS USAGE RC

Prints one JSON object: turns (model steps), is_error (nonzero rc, no final
event, or a turn that did not end with kind=completed), result (the final
message, or the stderr tail when there is none), and token/cost totals from
the proxy's usage log."""
import json, sys

ev, usage_path, rc = sys.argv[1], sys.argv[2], int(sys.argv[3])
steps, final, ends = 0, None, []
try:
    for line in open(ev):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "status" and e.get("phase") == "step_end":
            steps += 1
        elif e.get("type") == "status" and e.get("phase") == "turn_end":
            ends.append((e.get("reason") or {}).get("kind"))
        elif e.get("type") == "final":
            final = e.get("text")
except OSError:
    pass
tot = {"requests": 0, "input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0, "cost": 0.0}
try:
    for line in open(usage_path):
        u = json.loads(line).get("usage") or {}
        tot["requests"] += 1
        for k in ("input_tokens", "cache_read_input_tokens", "output_tokens", "cost"):
            tot[k] += u.get(k) or 0
except OSError:
    pass
tot["cost"] = round(tot["cost"], 4)
err = rc != 0 or final is None or any(k != "completed" for k in ends)
if final is None:
    try:
        final = open(ev + ".stderr", errors="replace").read()[-400:]
    except OSError:
        final = ""
print(json.dumps({"turns": steps, "is_error": err, "rc": rc, "turn_end": ends, "usage": tot, "result": final}))
