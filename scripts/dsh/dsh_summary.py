"""Summarise one dsh run: python3 dsh_summary.py EVENTS USAGE RC

Prints one JSON object, always: turns (model steps), is_error (nonzero rc, no
final event, a turn that did not end with kind=completed, or a summary error),
result (the final message, or the stderr tail when there is none), and
token/cost totals from the proxy's usage log. Malformed lines are skipped."""
import json, sys


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def lines(path):
    try:
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if isinstance(d, dict):
                    yield d
    except OSError:
        return


def summarise(ev, usage_path, rc):
    steps, final, ends = 0, None, []
    for e in lines(ev):
        if e.get("type") == "status" and e.get("phase") == "step_end":
            steps += 1
        elif e.get("type") == "status" and e.get("phase") == "turn_end":
            reason = e.get("reason")
            ends.append(reason.get("kind") if isinstance(reason, dict) else reason)
        elif e.get("type") == "final" and isinstance(e.get("text"), str):
            final = e["text"]
    tot = {"requests": 0, "input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0, "cost": 0.0}
    for rec in lines(usage_path):
        u = rec.get("usage") if isinstance(rec.get("usage"), dict) else {}
        tot["requests"] += 1
        for k in ("input_tokens", "cache_read_input_tokens", "output_tokens", "cost"):
            tot[k] += num(u.get(k))
    tot["cost"] = round(tot["cost"], 4)
    err = rc != 0 or final is None or any(k != "completed" for k in ends)
    if final is None:
        try:
            final = open(ev + ".stderr", errors="replace").read()[-400:]
        except OSError:
            final = ""
    return {"turns": steps, "is_error": err, "rc": rc, "turn_end": ends, "usage": tot, "result": final}


if __name__ == "__main__":
    try:
        ev, usage_path = sys.argv[1], sys.argv[2]
        try:
            rc = int(sys.argv[3])
        except (IndexError, ValueError):
            rc = -1
        out = summarise(ev, usage_path, rc)
    except Exception as e:  # the launcher's contract is one JSON line, whatever happened
        out = {"turns": 0, "is_error": True, "rc": -1, "turn_end": [], "usage": {},
               "result": f"summary failed: {type(e).__name__}: {e}"}
    print(json.dumps(out))
