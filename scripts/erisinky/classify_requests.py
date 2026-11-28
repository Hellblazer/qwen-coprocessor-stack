#!/usr/bin/env python3
"""Classify a captured qwen-code request log (RDR-017 P0 / S4, bead z7dk).

Input: JSONL files from capture_proxy.py, one file per run, each line
{seq, ts, method, path, body} with body the OpenAI chat-completions request.
Pass files or a directory (which expands to its run-*.jsonl files).

Per run it reports:
  * total requests, main-loop requests, side requests by guessed kind. A
    request's group is sha256(canonical(tools) + canonical(system message));
    a missing and an empty `tools` are the same NO_TOOLS value. The dominant
    group in a run is the main loop, every other group is a side request.
  * for each request, whether its messages array extends the previous
    main-loop request's messages as a prefix, compared per message on
    canonical JSON. Requests that do not extend it are listed with the index
    of the first differing message and the field that differs (role,
    content, reasoning_content, tool_calls, other).
  * requests that share no prefix with the request just before them (group
    differs, or message 0 differs), split by main/side transition.

This is a proxy for the token prefix: the script has no tokenizer, so it
compares at message granularity. P1's renderer and tokenizer give the exact
token count later. Stdlib only.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys

# Marker table for guessing a side request's kind. First match wins. Searched
# in the system message plus the last user message, case-insensitive. Add new
# kinds here.
KIND_MARKERS = [
    ("compression", re.compile(r"state_snapshot|compress|summari[sz]e the (conversation|chat|history)", re.I)),
    ("memory", re.compile(r"auto-?memory|memory (extraction|consolidation)|extract.*memor", re.I)),
    ("dream", re.compile(r"\bdream", re.I)),
    ("suggestion", re.compile(r"prompt suggestion|suggest.*(next|follow-?up)", re.I)),
    ("recap", re.compile(r"\brecap\b", re.I)),
    ("loop-detection", re.compile(r"loop detect|repetitive|stuck in a loop", re.I)),
]
FIELD_ORDER = ["role", "content", "reasoning_content", "tool_calls"]
NOTE = ("Prefix comparison is at message granularity on canonical JSON: a proxy "
        "for the token prefix, not an exact token count.")


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def system_message(body):
    for m in body.get("messages") or []:
        if m.get("role") == "system":
            return m
    return None


def group_key(body):
    tools = body.get("tools") or []  # missing == empty == NO_TOOLS
    return hashlib.sha256((canon(tools) + canon(system_message(body))).encode()).hexdigest()


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def guess_kind(body):
    sysm = system_message(body) or {}
    users = [m for m in body.get("messages") or [] if m.get("role") == "user"]
    hay = _text(sysm.get("content")) + "\n" + (_text(users[-1].get("content")) if users else "")
    for kind, rx in KIND_MARKERS:
        if rx.search(hay):
            return kind
    rf = body.get("response_format") or {}
    if rf.get("type") in ("json_schema", "json_object"):
        return "structured-json"
    return "unknown"


def differing_fields(a, b):
    """Fields that differ between two messages; `other` for anything else."""
    if a is None or b is None:
        return ["other"]
    out = [f for f in FIELD_ORDER if a.get(f) != b.get(f)]
    rest = (set(a) | set(b)) - set(FIELD_ORDER)
    if any(a.get(k) != b.get(k) for k in rest):
        out.append("other")
    return out or ["other"]


def _empty_np():
    return {"total": 0, "main_to_side": 0, "side_to_main": 0, "main_to_main": 0, "side_to_side": 0}


def analyze_run(name, rows):
    reqs, skipped = [], 0
    for row in rows:
        body = row.get("body")
        if row.get("method") != "POST" or not isinstance(body, dict) or "messages" not in body:
            skipped += 1
            continue
        reqs.append({"seq": row.get("seq"), "body": body, "key": group_key(body)})

    counts, first = {}, {}
    for i, q in enumerate(reqs):
        counts[q["key"]] = counts.get(q["key"], 0) + 1
        first.setdefault(q["key"], i)
    main_key = None
    if counts:
        has_tools = {k: bool(reqs[first[k]]["body"].get("tools")) for k in counts}
        main_key = max(counts, key=lambda k: (counts[k], has_tools[k], -first[k]))

    groups = []
    for k in sorted(counts, key=lambda k: first[k]):
        b = reqs[first[k]]["body"]
        groups.append({"key": k, "count": counts[k], "main": k == main_key,
                       "tools": len(b.get("tools") or []),
                       "kind": None if k == main_key else guess_kind(b)})
    kind_of = {g["key"]: g["kind"] for g in groups}

    out_reqs, events = [], []
    np_ = _empty_np()
    side_by_kind = {}
    prev = prev_main_msgs = None
    for i, q in enumerate(reqs):
        body, is_main = q["body"], q["key"] == main_key
        msgs = [canon(m) for m in body["messages"]]
        rec = {"index": i, "seq": q["seq"], "group": q["key"][:12],
               "label": "main" if is_main else "side", "kind": kind_of[q["key"]],
               "messages": len(msgs), "extends_prev_main": None,
               "common_with_prev": None, "no_prefix": False}
        if not is_main:
            side_by_kind[rec["kind"]] = side_by_kind.get(rec["kind"], 0) + 1
        if prev is not None:
            common = 0
            while common < min(len(msgs), len(prev["msgs"])) and msgs[common] == prev["msgs"][common]:
                common += 1
            rec["common_with_prev"] = common
            if q["key"] != prev["key"] or common == 0:
                rec["no_prefix"] = True
                np_["total"] += 1
                np_[("main" if prev["main"] else "side") + "_to_" + ("main" if is_main else "side")] += 1
        if is_main:
            if prev_main_msgs is not None:
                n = len(prev_main_msgs)
                ext = len(msgs) >= n and msgs[:n] == prev_main_msgs
                rec["extends_prev_main"] = ext
                if not ext:
                    k = 0
                    while k < min(len(msgs), n) and msgs[k] == prev_main_msgs[k]:
                        k += 1
                    cur = body["messages"][k] if k < len(msgs) else None
                    old = json.loads(prev_main_msgs[k]) if k < n else None
                    events.append({"run": name, "seq": q["seq"], "index": i, "first_diff_index": k,
                                   "fields": differing_fields(old, cur),
                                   "reason": "shorter than predecessor" if k >= len(msgs) else "rewritten message"})
            prev_main_msgs = msgs
        prev = {"key": q["key"], "msgs": msgs, "main": is_main}
        out_reqs.append(rec)

    n_main = sum(1 for r in out_reqs if r["label"] == "main")
    return {"run": name, "total": len(out_reqs), "main": n_main, "side": len(out_reqs) - n_main,
            "skipped": skipped, "side_by_kind": side_by_kind, "groups": groups,
            "main_requests_with_predecessor": sum(1 for r in out_reqs if r["extends_prev_main"] is not None),
            "no_prefix": np_,
            "non_extending": {"count": len(events), "events": events},
            "requests": out_reqs}


def combine(runs):
    c = {"total": 0, "main": 0, "side": 0, "side_by_kind": {}, "no_prefix": _empty_np(),
         "main_requests_with_predecessor": 0, "non_extending": {"count": 0, "events": []},
         "distinct_groups": len({g["key"] for r in runs for g in r["groups"]})}
    for r in runs:
        for f in ("total", "main", "side", "main_requests_with_predecessor"):
            c[f] += r[f]
        for k, v in r["side_by_kind"].items():
            c["side_by_kind"][k] = c["side_by_kind"].get(k, 0) + v
        for k, v in r["no_prefix"].items():
            c["no_prefix"][k] += v
        c["non_extending"]["count"] += r["non_extending"]["count"]
        c["non_extending"]["events"] += r["non_extending"]["events"]
    return c


def load_rows(path):
    rows = []
    with open(path) as f:
        for n, text in enumerate(f, 1):
            if text.strip():
                try:
                    rows.append(json.loads(text))
                except ValueError as e:
                    raise SystemExit(f"{path}:{n}: bad JSON: {e}")
    return rows


def expand(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            files += sorted(glob.glob(os.path.join(p, "run-*.jsonl")))
        else:
            files.append(p)
    return files


def _fmt_kinds(d):
    return ", ".join(f"{k}={v}" for k, v in sorted(d.items())) or "none"


def _block(title, r):
    np_ = r["no_prefix"]
    lines = [f"{title}",
             f"  requests: {r['total']}  main-loop: {r['main']}  side: {r['side']} ({_fmt_kinds(r['side_by_kind'])})",
             f"  share no prefix with previous request: {np_['total']} "
             f"(main->side {np_['main_to_side']}, side->main {np_['side_to_main']}, "
             f"main->main {np_['main_to_main']}, side->side {np_['side_to_side']})",
             f"  main-loop requests not extending previous main-loop request: "
             f"{r['non_extending']['count']} of {r['main_requests_with_predecessor']}"]
    for e in r["non_extending"]["events"]:
        lines.append(f"    {e['run']} seq {e['seq']}: first differing message {e['first_diff_index']}, "
                     f"field {'+'.join(e['fields'])} ({e['reason']})")
    return lines


def render_text(report):
    out = [NOTE, ""]
    for r in report["runs"]:
        out += _block(f"{r['run']}", r)
        out.append(f"  groups: " + ", ".join(
            f"{g['key'][:12]} x{g['count']} {'main' if g['main'] else 'side:' + str(g['kind'])} tools={g['tools']}"
            for g in r["groups"]))
        out.append("")
    c = report["combined"]
    out += _block("ALL RUNS", c)
    out.append(f"  distinct (tools, system) groups across runs: {c['distinct_groups']}")
    return "\n".join(out) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+", help="run JSONL files, or a directory holding run-*.jsonl")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args = ap.parse_args(argv)
    files = expand(args.paths)
    if not files:
        ap.error("no run-*.jsonl files found")
    runs = [analyze_run(os.path.splitext(os.path.basename(f))[0], load_rows(f)) for f in files]
    report = {"note": NOTE, "runs": runs, "combined": combine(runs)}
    if args.json:
        json.dump(report, sys.stdout, indent=2)
        print()
    else:
        sys.stdout.write(render_text(report))


if __name__ == "__main__":
    main()
