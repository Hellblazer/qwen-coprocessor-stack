---
name: Observability — structured logs, per-backend metrics, optional traces
type: architecture
status: draft
priority: medium
created: 2026-05-04
authors:
  - hal.hildebrand
related:
  - RDR-001 §Observability (mandates pino structured logging)
  - RDR-002 (plugins emit through the same log surface)
  - RDR-004 (fleet management — agent metrics flow into the same Prometheus surface)
---

# RDR-003 — Observability: structured logs, per-backend metrics, optional traces

## Status

**Draft** (2026-05-04). Scope was reserved during RDR-001's Observability
section and the placeholder index. Pino structured logging shipped in
Phase 1; this RDR designs the layer above — metrics, traces, and the
sampling/retention policy — without breaking the pino contract.

## Context

The supervisor today emits structured logs via pino at every state
change: spawn, tool call, permission deny, turn complete, reap, evict,
shutdown. The grep gate in RDR-001 §Phase 5b enforces no bare
`console.*` in `src/`. This is enough to retroactively explain "what
happened in this session" by reading the log stream — but only if you
already know which session.

What's missing for real operations:

- **Per-backend metrics.** The router heuristic pretends backend health
  and load are observable. They are — by pino timestamps and counting
  events — but no aggregation surfaces. The router cannot use load
  signals it cannot measure.
- **Cross-session correlation.** A single user request can fan out into
  a multi-turn session with several `qwen_send` calls, multiple tool
  invocations per turn, and possibly a backend swap. Today, stitching
  this together requires `task_id`-grep across log lines.
- **External integration points.** Operators using Grafana, Honeycomb,
  Langfuse, etc. cannot ingest pino JSON without bespoke pipelines.
  Standard endpoints (Prometheus scrape, OTel push) make these
  immediate.
- **Sampling and retention.** A long supervised session (hours, dozens
  of turns) emits thousands of pino lines. Without a sampling policy,
  log volume scales linearly with conversation length and overwhelms
  the small-payload assumption baked into `qwen_poll`'s 16-event
  default.

The aim of this RDR is to add these without compromising the pino
contract or the lightweight "no infrastructure overhead" property that
RDR-001 §D5 made primary.

## Decision drivers

- **D1. pino is mandatory; everything else is optional.** Structured
  logs are the floor: removable only by changing RDR-001. Metrics and
  traces sit on top — gated by env vars and absent by default.
- **D2. Per-backend visibility drives routing.** The router today
  filters on health (boolean) and capacity (label). Adding live load
  (in-flight turns, p95 latency, recent error rate) per backend
  enables better routing decisions later. Metrics must expose these
  whether or not the router currently consumes them.
- **D3. One trace per supervised session.** A trace's lifecycle is the
  span from `qwen_spawn` to `qwen_stop` (or terminal `complete`/
  `error`). Inside, child spans cover each turn, each tool call, each
  permission gate. This shape matches operator intuition.
- **D4. No backend-locking dependencies.** OTel and Prometheus are
  standards; Langfuse is opinionated. Treat Langfuse as one possible
  trace exporter, not a primary surface — code paths must work
  identically when it's absent.
- **D5. Bounded log volume.** Every emitter respects an opt-in
  sampling policy. Ring buffers cap event retention. The
  `model_message_summary` event already truncates assistant text to
  120 chars; that pattern generalizes.
- **D6. Plugin-friendly logger surface.** Plugins (RDR-002) need a
  way to emit through the supervisor's pino logger so their lines
  appear under the same `task_id` and trace context. The supervisor
  exports a small helper module for this.

## Options considered

### Option A — Status quo: pino only

What we ship today.

- ✅ Zero added complexity
- ❌ No aggregation, no cross-session view (D2 fails)
- ❌ No standard ingest path for external tooling (no Prometheus,
  no traces)
- ❌ No sampling — log volume unbounded in long sessions

### Option B — pino + Prometheus `/metrics` only

Add a `prom-client` integration exposing per-backend counters and
histograms on a small HTTP endpoint.

- ✅ Cheap, well-known, plays with Grafana
- ✅ Solves D2 immediately
- ⚠️ No traces — cross-session correlation still requires log grep
- ✅ Gated by `QWEN_METRICS_PORT` env var; absent by default

### Option C — pino + OpenTelemetry (traces + metrics)

OTel SDK with both metric and trace providers. Exports via OTLP
(gRPC or HTTP) to any compatible collector.

- ✅ Single integration covers D2 and D3
- ✅ Standard, exportable to many backends (Honeycomb, Tempo, Jaeger,
  vendor-specific OTel collectors)
- ⚠️ OTel SDK adds ~80 packages to `node_modules` and a startup cost
- ⚠️ OTLP requires running a collector — operators without one see
  no benefit
- ✅ Gated by `OTEL_EXPORTER_OTLP_ENDPOINT`; absent by default

### Option D — pino + Langfuse SDK

Langfuse's `@langfuse/node` client, opinionated for LLM tracing —
prompt/response display, token cost rollups, eval hooks built in.

- ✅ Best per-session UX for LLM-specific debugging
- ⚠️ Langfuse-flavored data model; not a standard
- ⚠️ Conflicts with OTel if both are enabled (double-tracing)
- ✅ Gated by `LANGFUSE_PUBLIC_KEY`; absent by default

### Option E — Layered (B + C + D, all optional, pino mandatory)

Each layer is independently switchable. The supervisor exposes the
data; the operator picks zero, one, or more sinks.

- ✅ Operators with no telemetry get no surprises
- ✅ Operators with Prometheus get D2 with one env var
- ✅ Operators with OTel get D2 + D3 with another env var
- ✅ Operators with Langfuse get the LLM-specific UX as a
  drop-in replacement for OTel traces
- ⚠️ Multiple sink integrations = more code paths to test
- ⚠️ Conflict if OTel and Langfuse both on — needs explicit policy

**Decision: Option E.** Layered, all-optional. Conflict policy:
when both `OTEL_EXPORTER_OTLP_ENDPOINT` and `LANGFUSE_PUBLIC_KEY` are
set, the supervisor warns at startup and emits to both (Langfuse for
the LLM-shape spans, OTel for everything else). Operators can disable
one explicitly.

## Decision

A layered observability stack with pino at the floor and optional
Prometheus/OTel/Langfuse on top.

### Layer 1 — pino structured logs (mandatory, already shipped)

No changes. Current logger names: `qwen-agent-server`, `qwen-pool`,
`qwen-session`, `qwen-shutdown`, `qwen-backends`. Each event line
includes `task_id` (when applicable), `backend_id`, `event_type`,
`state`. RDR-001 §Critical Pins covers no-bare-console enforcement.

### Layer 2 — Prometheus `/metrics` endpoint (optional)

Exposed on a separate HTTP server when `QWEN_METRICS_PORT` is set
(default unset → endpoint absent). Implementation: `prom-client`.
Endpoint: `GET /metrics` only; no other paths.

Metric inventory:

| Metric                                        | Type      | Labels                          | Notes |
|-----------------------------------------------|-----------|---------------------------------|-------|
| `qwen_spawn_total`                            | counter   | `backend_id`, `outcome`         | outcome ∈ accept/reject/no_backend |
| `qwen_session_state`                          | gauge     | `backend_id`, `state`           | per-state count |
| `qwen_turn_duration_ms`                       | histogram | `backend_id`                    | from spawn-or-send to result |
| `qwen_turn_input_tokens`                      | histogram | `backend_id`                    | from SDK result.usage |
| `qwen_turn_output_tokens`                     | histogram | `backend_id`                    | from SDK result.usage |
| `qwen_turn_cache_read_input_tokens`           | histogram | `backend_id`                    | KV-cache hit measurement |
| `qwen_turn_cache_hit_ratio`                   | histogram | `backend_id`                    | derived; cache_read / input |
| `qwen_tool_call_total`                        | counter   | `backend_id`, `tool_name`, `outcome` | outcome ∈ allow/deny/error |
| `qwen_permission_deny_total`                  | counter   | `backend_id`, `tool_name`       | always emitted, even when count is zero, so dashboards show no-flow as no-flow not as missing |
| `qwen_backend_health`                         | gauge     | `backend_id`                    | 1=healthy, 0=unhealthy, -1=unknown (treats null) |
| `qwen_backend_health_probe_duration_ms`       | histogram | `backend_id`                    | wall time of `probeHealth` |
| `qwen_pool_evict_total`                       | counter   | `reason`                        | reason ∈ terminal/lru/reaper |
| `qwen_pool_size`                              | gauge     |                                 | current pool occupancy |
| `qwen_supervisor_uptime_seconds`              | counter   |                                 | seconds since process start |

Histograms use buckets tuned for the workload — token counts in
`[100, 500, 2k, 5k, 10k, 25k, 65k, 130k]`, durations in
`[100ms, 500ms, 1s, 5s, 30s, 2min, 10min]`. Tunable via
`QWEN_METRICS_BUCKETS_*`.

### Layer 3 — OpenTelemetry traces (optional)

Enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Standard OTel
Node SDK; OTLP HTTP exporter (gRPC available via `OTEL_EXPORTER_OTLP_PROTOCOL`).

Span hierarchy:

```
qwen_session                (root span, lifetime: spawn → terminal)
├── attributes: task_id, backend_id, write_authority, allow_subagents
├── qwen_turn (child, repeated per turn)
│   ├── attributes: turn_index, input_tokens, output_tokens
│   ├── qwen_tool_call (child, repeated per tool)
│   │   ├── attributes: tool_name, outcome
│   │   └── qwen_permission_gate (child, when canUseTool fires)
│   └── qwen_assistant_text (event, optional sample)
└── qwen_session_end (event)
```

Span attributes use the OTel `gen_ai.*` semantic conventions where
they exist (gen_ai.system="qwen", gen_ai.request.model, gen_ai.usage.*).

The pino logger's `task_id` field is enriched with the OTel `trace_id`
and `span_id` when tracing is enabled, so log lines can be joined to
spans without bespoke correlation.

### Layer 4 — Langfuse (optional)

Enabled when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set.
Uses `@langfuse/node`. Per-session trace; per-turn observation; tool
calls as nested observations.

When OTel is also enabled: Langfuse emits in parallel to the OTel
exporter (so operators see both views). Spans are intentionally
duplicated — Langfuse's data model differs enough that translation
would be lossy. Operators who only want one disable the other.

### Plugin logger helper

The supervisor publishes `@qwen-agent-server/plugin-logger` as a
package consumable by plugins (RDR-002). It exposes a `pino`-shaped
logger pre-configured with:

- Same name format: `qwen-plugin-<plugin_name>`.
- The current `task_id` if invoked inside a session (read from
  AsyncLocalStorage).
- The current OTel trace context.

Plugins call it like any pino logger; their lines appear in the
unified stream without the plugin needing to know about pino,
AsyncLocalStorage, or OTel.

### Sampling policy

| Event class                  | Default policy                                       |
|------------------------------|------------------------------------------------------|
| pino logs                    | All emitted at `INFO`; `LOG_LEVEL=debug` for verbose |
| `model_message_summary.data` | First 120 chars (current); full text as DEBUG only   |
| `tool_result.data`           | Truncate to 2 KB; full payload as DEBUG only         |
| Prometheus histograms        | Always sampled (counters and gauges are full)        |
| OTel spans                   | Tail sampling at the collector (operator's choice); SDK emits all |
| Langfuse traces              | All emitted; Langfuse's UI handles volume           |

Operators tune via `LOG_LEVEL`, `QWEN_LOG_TRUNCATE_TOOL_RESULT_BYTES`,
and standard OTel sampler env vars. No supervisor-side sampling on
metrics — they're already aggregates.

### Implementation map

| Concern                             | Source file (planned)                              |
|-------------------------------------|----------------------------------------------------|
| pino logger init and module loggers | `src/server.ts` (existing — no change)             |
| Metrics module (prom-client)        | `src/metrics.ts` (new)                             |
| Metrics HTTP server                 | `src/metrics-server.ts` (new; optional, gated)     |
| OTel SDK init                       | `src/tracing/otel.ts` (new; optional, gated)       |
| Langfuse client init                | `src/tracing/langfuse.ts` (new; optional, gated)   |
| AsyncLocalStorage for trace context | `src/trace-context.ts` (new)                       |
| Plugin logger helper package        | `mcp-bridges/qwen-agent-server/plugin-logger/`     |

## Consequences

### Positive

- Operationally legible without log-grep gymnastics.
- Per-backend metrics enable smarter routing (RDR-004's load-aware
  evolution can read directly from the same `prom-client` registry).
- One trace per session matches operator intuition.
- All optional layers absent by default — zero-knob deployments
  unaffected.
- Plugins write logs that integrate without each one re-implementing
  pino/OTel wiring.

### Negative

- Optional integrations balloon `node_modules`: prom-client (~30
  packages), OTel (~80), Langfuse (~15). Mitigated by lazy
  import — modules load only when their env var is set.
- Conflict policy (OTel + Langfuse simultaneously) emits duplicate
  data. Documented; explicit operator choice.
- Histogram buckets are workload-tuned; misconfigured buckets give
  misleading dashboards. Mitigated by sensible defaults and
  documented override env vars.

### Neutral

- Trace IDs in pino lines change the log-line shape. Bumped a minor
  version of any external log parser the operator may have built;
  documented.
- Metric labels include `backend_id` — high cardinality if backends
  churn fast (RDR-004). Mitigated by `id` being operator-chosen and
  stable across hot-reloads.

## Research findings (open questions)

### Q1 — Whether to derive `qwen_turn_cache_hit_ratio` server-side

**Status:** Open.

Per-turn the SDK reports `cache_read_input_tokens` and `input_tokens`;
their ratio is the prefix-cache hit rate. We can derive it as a
histogram metric (above), or leave operators to compute it from the
two raw histograms in their dashboard.

Trade-off: server-side derivation is friendlier to operators with
no PromQL fluency; raw histograms compose better in custom queries.

Lean: ship both. Derivation is cheap and the convenience is real.

### Q2 — Tool-call duration metric

**Status:** Deferred.

Per-tool wall time (`qwen_tool_call_duration_ms`) would round out the
metric set. Currently the SDK doesn't surface tool-call timestamps;
deriving from event ring-buffer timestamps is approximate. Defer
until either (a) an SDK update exposes the data or (b) a real need
appears.

### Q3 — pino-to-OTel log bridge

**Status:** Open.

OTel has a logs SDK that could ingest pino's stream and emit logs as
OTel log records. This would unify metrics+traces+logs under one
exporter. Worth a small spike; if it works without bloating the
common path, it's a one-line addition. If it breaks the
zero-OTel-deployment property, skip.

### Q4 — Histogram cardinality budget

**Status:** Open.

`tool_name` as a label has a small fixed range today (the Qwen tool
surface) but plugins can add tools. If plugin-emitted `tool_name`
values explode the cardinality budget, drop the label or aggregate
plugin tools under a single `tool_name="plugin"` bucket. Revisit when
RDR-002 plugins ship.

## Related decisions and prior art

- RDR-001 §Observability — established pino as mandatory.
- RDR-001 §Critical Pins — no bare console.* in src/. Carries
  through to all metric/trace code.
- RDR-002 — plugins consume the plugin-logger helper described here.
- RDR-004 — fleet management agent emits its own `/metrics` independently;
  same Grafana dashboard joins by `backend_id` label.
- pino: https://github.com/pinojs/pino
- prom-client: https://github.com/siimon/prom-client
- OpenTelemetry Node SDK: https://opentelemetry.io/docs/instrumentation/js/
- Langfuse: https://langfuse.com/docs/sdk/typescript
- OTel `gen_ai.*` semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/

## References

- `mcp-bridges/qwen-agent-server/src/session.ts` `log.info(...)` —
  current pino call sites; the metric inventory above derives from
  these events.
- `mcp-bridges/qwen-agent-server/src/pool.ts` `log.info(...)` — pool
  events feeding `qwen_pool_*` metrics.
- `mcp-bridges/qwen-agent-server/tests/integration/round-trip.test.ts`
  — once metrics ship, this test asserts the `qwen_turn_cache_hit_ratio`
  histogram saw a value > 0.9 on turn 2 (matches the empirical 98%
  observed during the soak).
