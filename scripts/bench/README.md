# qwen_vs_claude — A/B benchmark for nx_answer-style operator dispatch

Compares two backends on the same prompt+schema:

- **Qwen**: `qwen_oneshot` MCP handler (this stack, v0.8+).
- **Claude**: `claude -p --output-format json --json-schema <schema>` subprocess.

The motivating question is whether Qwen3.6-35B-A3B is good enough at JSON-conforming synthesis to replace `claude_dispatch` in `nexus/operators/dispatch.py:229` for the bundleable nx_answer operators (`extract`, `rank`, `compare`, `summarize`, `generate`, `filter`, `check`, `verify`, `groupby`, `aggregate`).

## Running

From the supervisor package:

```bash
cd mcp-bridges/qwen-agent-server
npm run bench                          # both engines, default cases
npm run bench -- --only qwen           # skip claude (no API spend)
npm run bench -- --only claude         # skip qwen (sanity)
npm run bench -- --cases path/to.json  # custom cases
npm run bench -- --out path/to.jsonl   # custom output
npm run bench -- --timeout-ms 60000    # per-case wall-clock cap
```

The script auto-runs `npm run build` first so the `dist/` import is fresh.

## Output

JSONL, one row per `(case, engine)` pair:

```json
{"case":"summarize-paragraph","engine":"qwen","elapsed_ms":17234,"ok":true,"json_valid":true,"output_len":401,"output_truncated":"{\"summary\":\"...\"}"}
{"case":"summarize-paragraph","engine":"claude","elapsed_ms":4810,"ok":true,"json_valid":true,"output_len":423,"output_truncated":"{\"summary\":\"...\"}"}
```

The summary table at the end shows ok-rate, JSON-valid-rate, median latency, and total wall-clock per engine.

## Cases

`cases.json` ships five operator-shaped prompts covering `summarize`, `extract`, `compare`, `rank`, `filter`. Add your own by appending objects with the shape:

```json
{
  "name": "<unique-id>",
  "operator": "<one-of-the-bundleable-verbs>",
  "prompt": "<full prompt for both engines>",
  "schema": <JSON Schema object>
}
```

Both engines see the same prompt+schema; differences in result are the model's, not the harness's.

## What the harness does NOT measure

- **Quality of the output**, just JSON-validity and wall-clock. Cross-model agreement, manual rating, and answer-correctness against a held-out oracle are downstream tasks. Plumb them on top of the JSONL.
- **Spawn-cost amortization for bundled plans.** `claude -p` runs all bundled operators in one subprocess; this harness spawns one per case. For nx_answer's real workload the per-call number is the relevant comparison; for end-to-end plan latency you'd need a different harness against `nx_answer` directly.
- **Cost.** Claude API spend is implicit (count rows × your rate). Qwen is free at margin (the operator's own GPU box).

## Caveats

- The Qwen leg invokes the supervisor in-process via `createToolHandlers`. It does not perturb a separately-running supervisor process, but it does load the operator's `~/.qwen-coprocessor-stack/config.json` and the installed-extensions cache. Make sure the qwentescence backend (or whichever you're benching) is reachable.
- The Claude leg shells out to whatever `claude` binary is on `PATH`. Authentication uses whatever Claude Code already has cached.
- Per-case timeout default is 120s. A long-running Qwen turn will hit this on a single big prompt; bump `--timeout-ms` if your cases are heavy.
