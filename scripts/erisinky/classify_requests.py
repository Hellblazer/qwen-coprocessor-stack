#!/usr/bin/env python3
"""Classify a captured qwen-code request log (RDR-017 P0 / S4, bead z7dk).

Input: JSONL files from capture_proxy.py, one file per run, each line
{seq, ts, method, path, body} with body the OpenAI chat-completions request.
Pass files or a directory (which expands to its run-*.jsonl files).

Per run it reports:
  * total requests, main-loop requests, side requests by guessed kind. A
    request's group is sha256(canonical(tools) + canonical(system message));
    a missing and an empty `tools` are the same NO_TOOLS value. The main loop
    is every request whose tools hash equals the most common non-empty tools
    hash in the run (a subagent with its own tool set is therefore side). Of
    those, the most common (tools, system) group is labelled `main` and any
    other, which has the main tools under a different system message, is
    labelled `main-system-changed`: still the main loop, but its prefix
    differs from message 0. Everything else is a side request. A run with no
    tools at all has no main loop.
  * for each request, whether its messages array extends the previous
    main-loop request's messages as a prefix, compared per message on
    canonical JSON. Requests that do not extend it are listed with the index
    of the first differing message and the field that differs (role,
    content, reasoning_content, tool_calls, other).
  * requests that share no prefix with the request just before them (group
    differs, or message 0 differs), split by main/side transition. Within one
    group, main->main is 0 by construction: the system message is part of the
    group and is message 0, so a same-group request always shares it. It is
    nonzero only when the system prompt changes mid-run. The informative
    number is `common_with_prev`, the count of leading messages a request
    shares with the one just before it; it is reported per request and
    summarised per run by transition.

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
import statistics
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
KIND_NOTE = "kind guesses unvalidated against real qwen-code side requests"
NP_NOTE = ("main->main is 0 by construction while the system prompt is unchanged (the system "
           "message is message 0 and part of the group); read the leading-message counts for "
           "the real shared prefix.")


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha(text):
    # surrogatepass: a lone UTF-16 surrogate (JSON \ud83d) is a legal str here
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()


def system_message(body):
    for m in body.get("messages") or []:
        if m.get("role") == "system":
            return m
    return None


def tools_key(body):
    return _sha(canon(body.get("tools") or []))  # missing == empty == NO_TOOLS


def group_key(body):
    tools = body.get("tools") or []
    return _sha(canon(tools) + canon(system_message(body)))


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
        reqs.append({"seq": row.get("seq"), "body": body, "key": group_key(body),
                     "tkey": tools_key(body), "has_tools": bool(body.get("tools"))})

    def dominant(keys, firsts):
        """Most common key, earliest first-seen on a tie."""
        return max(keys, key=lambda k: (keys[k], -firsts[k]))

    counts, first = {}, {}  # per (tools, system) group
    tcounts, tfirst = {}, {}  # per non-empty tools hash
    for i, q in enumerate(reqs):
        counts[q["key"]] = counts.get(q["key"], 0) + 1
        first.setdefault(q["key"], i)
        if q["has_tools"]:
            tcounts[q["tkey"]] = tcounts.get(q["tkey"], 0) + 1
            tfirst.setdefault(q["tkey"], i)
    main_tkey = dominant(tcounts, tfirst) if tcounts else None
    in_main_tools = {k: c for k, c in counts.items() if reqs[first[k]]["tkey"] == main_tkey}
    main_key = dominant(in_main_tools, first) if in_main_tools else None

    def label_of(q):
        if q["tkey"] != main_tkey:  # also true for every request when main_tkey is None
            return "side"
        return "main" if q["key"] == main_key else "main-system-changed"

    groups = []
    for k in sorted(counts, key=lambda k: first[k]):
        q0 = reqs[first[k]]
        lab = label_of(q0)
        groups.append({"key": k, "count": counts[k], "main": lab == "main", "label": lab,
                       "tools": len(q0["body"].get("tools") or []),
                       "kind": guess_kind(q0["body"]) if lab == "side" else None})
    kind_of = {g["key"]: g["kind"] for g in groups}

    out_reqs, events = [], []
    np_ = _empty_np()
    common_by_transition = {}
    side_by_kind = {}
    prev = prev_main_msgs = None
    for i, q in enumerate(reqs):
        body, label = q["body"], label_of(q)
        is_main = label != "side"  # in the main loop, system prompt changed or not
        msgs = [canon(m) for m in body["messages"]]
        rec = {"index": i, "seq": q["seq"], "group": q["key"][:12],
               "label": label, "kind": kind_of[q["key"]],
               "messages": len(msgs), "extends_prev_main": None,
               "common_with_prev": None, "no_prefix": False}
        if not is_main:
            side_by_kind[rec["kind"]] = side_by_kind.get(rec["kind"], 0) + 1
        if prev is not None:
            common = 0
            while common < min(len(msgs), len(prev["msgs"])) and msgs[common] == prev["msgs"][common]:
                common += 1
            rec["common_with_prev"] = common
            trans = ("main" if prev["main"] else "side") + "_to_" + ("main" if is_main else "side")
            common_by_transition.setdefault(trans, []).append(common)
            if q["key"] != prev["key"] or common == 0:
                rec["no_prefix"] = True
                np_["total"] += 1
                np_[trans] += 1
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
    n_msc = sum(1 for r in out_reqs if r["label"] == "main-system-changed")
    summary = {t: {"n": len(v), "min": min(v), "median": statistics.median(v), "max": max(v)}
               for t, v in common_by_transition.items()}
    return {"run": name, "total": len(out_reqs), "main": n_main, "main_system_changed": n_msc,
            "side": len(out_reqs) - n_main - n_msc,
            "skipped": skipped, "side_by_kind": side_by_kind, "groups": groups,
            "main_requests_with_predecessor": sum(1 for r in out_reqs if r["extends_prev_main"] is not None),
            "no_prefix": np_, "common_with_prev": summary,
            "non_extending": {"count": len(events), "events": events},
            "requests": out_reqs}


def combine(runs):
    c = {"total": 0, "main": 0, "main_system_changed": 0, "side": 0, "side_by_kind": {}, "no_prefix": _empty_np(),
         "main_requests_with_predecessor": 0, "non_extending": {"count": 0, "events": []},
         "distinct_groups": len({g["key"] for r in runs for g in r["groups"]})}
    for r in runs:
        for f in ("total", "main", "main_system_changed", "side", "main_requests_with_predecessor"):
            c[f] += r[f]
        for k, v in r["side_by_kind"].items():
            c["side_by_kind"][k] = c["side_by_kind"].get(k, 0) + v
        for k, v in r["no_prefix"].items():
            c["no_prefix"][k] += v
        c["non_extending"]["count"] += r["non_extending"]["count"]
        c["non_extending"]["events"] += r["non_extending"]["events"]
    return c


def load_rows(path):
    """Read a capture log. Any bad line stops the run with `path:line: reason`."""
    rows = []
    # surrogateescape turns invalid UTF-8 bytes into lone surrogates, which the
    # encode() check below reports with the exact line (a strict decode would
    # fail a whole read chunk, not the line).
    with open(path, encoding="utf-8", errors="surrogateescape") as f:
        for n, text in enumerate(f, 1):
            if not text.strip():
                continue
            try:
                text.encode("utf-8")
            except UnicodeEncodeError:
                raise SystemExit(f"{path}:{n}: not valid UTF-8")
            try:
                row = json.loads(text)
            except ValueError as e:
                raise SystemExit(f"{path}:{n}: bad JSON: {e}")
            if not isinstance(row, dict):
                raise SystemExit(f"{path}:{n}: not a JSON object (got {type(row).__name__})")
            rows.append(row)
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
    msc = f" + {r['main_system_changed']} main-system-changed" if r["main_system_changed"] else ""
    lines = [f"{title}",
             f"  requests: {r['total']}  main-loop: {r['main']}{msc}  side: {r['side']} "
             f"({_fmt_kinds(r['side_by_kind'])}{'; kinds unvalidated' if r['side'] else ''})",
             f"  share no prefix with previous request: {np_['total']} "
             f"(main->side {np_['main_to_side']}, side->main {np_['side_to_main']}, "
             f"main->main {np_['main_to_main']}, side->side {np_['side_to_side']})",
             f"  main-loop requests not extending previous main-loop request: "
             f"{r['non_extending']['count']} of {r['main_requests_with_predecessor']}"]
    for e in r["non_extending"]["events"]:
        lines.append(f"    {e['run']} seq {e['seq']}: first differing message {e['first_diff_index']}, "
                     f"field {'+'.join(e['fields'])} ({e['reason']})")
    cw = r.get("common_with_prev")
    if cw:
        lines.append("  leading messages shared with previous request (min/median/max, n): " + "; ".join(
            f"{t.replace('_to_', '->')} {s['min']}/{s['median']:g}/{s['max']} (n={s['n']})"
            for t, s in sorted(cw.items())))
    return lines


def _group_label(g):
    return "side:" + str(g["kind"]) if g["label"] == "side" else g["label"]


def render_text(report):
    out = [NOTE, report["kind_note"], NP_NOTE, ""]
    for r in report["runs"]:
        out += _block(f"{r['run']}", r)
        out.append(f"  groups: " + ", ".join(
            f"{g['key'][:12]} x{g['count']} {_group_label(g)} tools={g['tools']}"
            for g in r["groups"]))
        out.append("")
    c = report["combined"]
    out += _block("ALL RUNS", c)
    out.append(f"  distinct (tools, system) groups across runs: {c['distinct_groups']}")
    return "\n".join(out) + "\n"


def build_report(runs):
    return {"note": NOTE, "kind_note": KIND_NOTE, "main_to_main_note": NP_NOTE,
            "runs": runs, "combined": combine(runs)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("paths", nargs="+", help="run JSONL files, or a directory holding run-*.jsonl")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args = ap.parse_args(argv)
    files = expand(args.paths)
    if not files:
        ap.error("no run-*.jsonl files found")
    runs = [analyze_run(os.path.splitext(os.path.basename(f))[0], load_rows(f)) for f in files]
    report = build_report(runs)
    if args.json:
        json.dump(report, sys.stdout, indent=2)
        print()
    else:
        sys.stdout.write(render_text(report))


if __name__ == "__main__":
    main()
