# Post-mortem: RDR-007 — Unified agent dispatch contract

**Closed:** 2026-06-13 · **Outcome:** implemented · **PR:** #34 (merged to main) · **Epic:** `qwen-coprocessor-stack-azf` (12/12)

## What shipped vs. what was decided

Delivered exactly the scope-corrected Decision: the **two in-repo routers** consolidated onto one `AgentProvider` descriptor + `select()` registry pass + agentic `dispatch()` interface, with `pick_dispatcher_for` (nexus repo) handled by a published language-neutral spec rather than a code change. No scope drift from the accepted §Decision; the `### Approach` cross-walk (added at close to fix au3) maps all 4 Decision items + the published-spec deliverable onto the six implementation beads, and the phase-review-gate passed.

One net-new behavior (intended, P2): the MLX `schemaSynth` exclusion went from operator convention to enforced — unpinned `json_schema` chat no longer silently lands on an MLX backend that drops the schema.

## What went right

- **The Negative-1 mitigation is real, and we proved it.** The cross-language drift risk (TS `classifyOutcome` vs Python `classify_outcome`, verbatim ports) was mitigated by golden fixtures both hosts assert against identical files. The substantive-critic ran a *mutation analysis* (flip `>=`→`>` on the turn-limit boundary; drop the null→error guard) and confirmed each plausible drift FAILS a fixture on both hosts. The mitigation is not theater.
- **Stacked review caught the real issues, not style.** code-review-expert approved clean; substantive-critic surfaced the two seams that mattered (S1 fixture gap, S2 untested invariant). Consistent with the project pattern: the two reviewers catch different classes.

## Hard-won lessons (durable)

1. **The dispatch boundary is asymmetric — not all "shared pure logic" is cross-host.** The original P4b framing (bead text) assumed three pure surfaces — classify-outcome, prompt-render, exclusion-predicate — were all cross-host. They are not: `prompt-render` is Python-only (the TS dispatch *receives* a prompt; it has no renderer), and `task-classification` is TS-only (the Python eval spine doesn't route backends). Forcing a renderer onto TS or a router onto Python would have been dead code violating RF-1. The honest resolution: cross-host fixtures (classify-outcome + shapes) are the real drift tripwire; host-scoped surfaces are "normative-if-adopted" and asserted on their single implementing host. The azf.8 S2 carry-forward is what forced this reconciliation *before* fixtures were authored — a phase-boundary seam note paying off a phase later.
2. **A "shared spine" can be pure-logic-only without centralizing effects (RF-1 held).** The git-diff (against `base_commit`, source-only), process-group kill, and prediction file-write stayed local to each host. The contract is shapes + rules; the fixtures never encode an effect. This is the line that kept the two hosts independent while still verifiably conformant.
3. **An invariant that can only live in a host effect can't be fixture-covered — flag it explicitly.** The `extractPatch` base_commit rule (diff against base, not HEAD, or a committed fix scores a silent zero) is documented in JSDoc only on the TS side because the real TS impl is the out-of-scope `server.ts` wiring. The Python host already tests it (`test_extract_against_base_captures_committed_change`). Recorded as an accepted untested-contract-obligation on the wiring bead rather than pretending a fixture covers it.
4. **`tcsc` ≠ vitest, and units bite.** Recurring this arc: tests aren't tsc-checked (bead `ahd`), so always check `npm run build` exit code, not just green tests. And the TS `timeout` is milliseconds while the Python runner takes seconds — reconciled by emitting ms at the contract boundary and converting locally (an RF-1 host effect).

## Follow-ups left open (deliberate, out of RDR-007 scope)

- `r7u` (P3) — fold `no_tokenize` into the excludes `TaskKind` model. A future RDR; the P2 scope was deliberately the MLX schemaSynth guard only.
- `ahd` (P3) — qwen-agent-server test type-assertions are not tsc-checked (pre-existing latent; `tsconfig` include is `src/**` only).
- Future wiring: when `server.ts` gets the TS `extractPatch` closure, it MUST capture `base_commit` (not HEAD), return source-only, and land with an integration test (see azf.12 comment).

## Environment note

No `.venv` present this session despite the CLAUDE.md reference; used system `python3` (pytest 9.0.3). The `datasets` module is absent, so `test_subset::test_real_snapshot_matches_frozen_ids` errors at collection (network + module) — a pre-existing environmental gap, unrelated to RDR-007.
