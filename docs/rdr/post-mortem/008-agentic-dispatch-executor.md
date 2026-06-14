<!-- SPDX-License-Identifier: MIT -->
# Post-mortem — RDR-008: Agentic dispatch executor

**RDR:** [RDR-008](../RDR-008-agentic-dispatch-executor.md) · **Status:** closed (implemented) ·
**Accepted:** 2026-06-13 · **Closed:** 2026-06-14 · **Epic:** `qwen-coprocessor-stack-zot` ·
**PRs:** #39 (implementation) + #40 (status flip)

## Outcome

Shipped a small pluggable dispatcher framework on top of RDR-007's `Dispatch` contract, the
`qwen_dispatch` MCP operator, and a published language-neutral spec for nexus. Three phases, each
stacked-reviewed (code-review-expert + substantive-critic) to **0 Critical** before close. Discipline
held: registry + RDR-007 effect interfaces only — no plugin discovery/loading/lifecycle; bright line
intact (no durability/idempotency/checkpointing/replay; no `claude -p`). The RDR-007 golden fixture
(`agent-shapes.json`) stayed byte-unchanged the whole way.

## Shipped vs. the RDR

| §Approach item | Bead | Delivered as planned? |
|----------------|------|-----------------------|
| 1 — dispatcher registry + local-Qwen dispatcher + agent-cli registration | q8k | Yes |
| 2 — `qwen_dispatch` tool + `base_commit` contract + same-bead integration test | exn | Yes |
| 3 — published nexus spec + (a) linked issue + (b) conformance fixture | pwa | Yes (issue filed, see §Open threads) |

No silent scope reduction (P4 phase-review-gate cross-walk PASSED for all three). The caller-supplied
worktree strategy shipped as the default; the executor-managed strategy (materialize.py port) was
always scoped as a fast-follow (RF-5) — filed as `1gl`, not dropped.

## What the reviews caught (and the value of the stacked gate)

The two reviewers caught **different classes** of issue at every phase — the gate earned its place:

- **P1 / R1 — the silent producer (substantive-critic, Critical).** The registry shipped as a typed
  container with no production registration; every test exercised an anonymous fake, so the seam's
  ability to compose with the *real* `makeQwenSpawnDispatch` was unproven. Fix: added
  `createDefaultDispatcherRegistry` (the registration ceremony) + a test driving the real dispatcher
  through `resolve()`. Without this, "first dispatcher: local Qwen" would have been a hollow claim.
- **P2 / R2 — eviction masquerading as a clean error (code-review, Medium).** The poll adapter dropped
  `qwen_poll`'s error payload, so a session evicted from the pool (`task_id_not_found`) surfaced as a
  tidy `outcome:"error"` with an empty patch — indistinguishable from a genuine agent failure. Fixed to
  throw (infra failure ≠ dispatch outcome). Also: split the conflated `unregistered_kind` into a
  distinct `missing_agent_kind` (config error vs. registration gap).
- **P3 / R3 — "agreed" overclaimed (substantive-critic, Significant).** The spec called the freshly
  filed nexus issue an *agreed* signature; it had no nexus response. Reworded to "filed, pending nexus
  sign-off" — an honest two-party state. Also bound the error-code conformance test to an exported
  `DISPATCH_ERROR_CODES` so it tests the *code*, not a second copy of itself.

## The load-bearing design call

`base_commit` could not ride RDR-007's fixture-locked `AgentTask`, and a closure can't cross the MCP
boundary. Resolution: `ExtractPatch` gained a **required** `baseCommit` parameter (so the
silent-`HEAD`-zero path is unrepresentable at the type level), threaded through the dispatcher's
construction opts; the registry is built **per-call** because the base is per-run. The same-bead
integration test (agent commits its edits → `git diff HEAD` empty, `git diff <base>` non-empty) is the
runtime guard that the type system can't express.

## Known gaps carried forward (filed, not lost)

- **`j2r` — `turns=0` on success.** `PollResult.last_known` is populated only on the error path, so a
  normally-completed qwen-local run reports `turns: 0`. Surfaced honestly in the spec, the fixture
  note, and the adapter docstring; the P3 conformance fixture pins `turns=0` so it isn't vacuous.
  `j2r` adds `turns_completed` to the success poll.
- **`1gl` — executor-managed worktree.** The materialize.py port; the host-effect axis's proven second
  strategy. RF-5 fast-follow, intentionally out of close scope.

## Open threads

- **nexus #1174 — pending sign-off.** The qcs-side obligation (publish spec + on-host conformance
  fixture + filed issue) is complete; the operator signature is *proposed*, not yet *agreed*. Full
  two-party agreement is contingent on a nexus response. This is the one piece of RDR-008 that lives
  outside this repo's control and so could not be force-closed here.

## What would have hurt without the process

- Closing P1 on green tests alone would have shipped a registry no production path ever populated.
- Closing P2 without the same-bead integration test would have let the diff-vs-HEAD silent-zero ship
  unguarded — the exact failure RDR-007's close demanded a test for.
- Accepting "agreed" wording in P3 would have misrepresented an unacknowledged external dependency.

The volume gate ("is this worth full ceremony?") never fired — every phase had a real finding the
gate surfaced before it froze into a later phase.
