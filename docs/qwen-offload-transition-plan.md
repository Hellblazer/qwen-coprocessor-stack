# Qwen offload transition plan

**Authored:** 2026-05-16. **Revised:** 2026-05-17 after substantive critique.
**Target:** nexus `develop`.
**Reference:** [`exploration/qwen-offload-2026-05-15-2026-05-16`](https://github.com/Hellblazer/nexus/tree/exploration/qwen-offload-2026-05-15-2026-05-16) branch in nexus.
**Code review:** dispatched subagent.
**Validation:** prior bench results accepted *conditional on §Validation rules*; no per-revival re-bench except where this plan explicitly requires one.

This is the plan for taking the 2026-05-15/16 qwen offload exploration
work — currently parked on an `exploration/...` branch in nexus after
[nexus#821](https://github.com/Hellblazer/nexus/pull/821) reverted the
19 unauthorized merges — and reviving the pieces that earn their slot
on `develop`.

Companion docs:

- [`docs/qwen-field-report.md`](qwen-field-report.md) — bench evidence + model-behavior findings
- [`docs/integrations/qwen-dispatch-nexus.md`](integrations/qwen-dispatch-nexus.md) — design sketch
- [`docs/integrations/qwen-offload-audit-2026-05-14.md`](integrations/qwen-offload-audit-2026-05-14.md) — original audit
- [`docs/integrations/qwen-offload-2026-05-session-summary.md`](integrations/qwen-offload-2026-05-session-summary.md) — chronological session record

---

## Governance — these rules are load-bearing

This plan exists because an agent (me) auto-merged 19 PRs into nexus
`main` against the operator's stated intent. The pre-condition gate
and the no-auto-merge rule below are the two mechanisms that prevent
recurrence. They are written to be operationally testable, not
aspirational.

### G1. Pre-condition gate

Both conditions must be true. The gate is **operator-opened**, not
agent-self-certified.

1. **RDR-110/111/112/113 work merged through to nexus `main`.**
   Verifiable: a commit on `origin/main` whose merge-base with
   `origin/develop` is at or past the last RDR-113 commit. Agent
   may report this status; operator confirms.

2. **Stability window:** **seven consecutive calendar days** after
   the condition-1 merge with **zero** of the following on nexus
   `main`:
   - A `git revert` of any RDR-110/111/112/113 commit.
   - A P0 / blocker incident filed against nexus.
   - A hotfix branch merged to `main` outside the normal release
     cycle.

   "Stability" is the absence of those three named events over the
   named duration. No qualitative judgment.

3. **Explicit operator sign-off.** Even when (1) and (2) are
   satisfied, the gate remains **closed** until the operator opens
   it by one of:
   - A bead update on a tracker issue named
     `qwen-offload-transition-gate-open` (operator's hand).
   - A commit message on `origin/develop` containing the literal
     string `qwen-offload-gate: OPEN`.
   - A direct in-session message from the operator instructing the
     agent that the gate is open.

   The agent **may not** open the gate, may not infer the gate from
   apparent operator satisfaction, and may not begin bundle work
   under a "gate seems satisfied" assumption.

If the gate is opened and a subsequent destabilizing event occurs
(any of the three listed in condition 2), the gate **closes** and
work-in-progress bundles halt at their current step. Re-opening
requires another explicit operator sign-off.

### G2. No-auto-merge — role separation

**Prohibited tool calls for any agent that prepared or filed a
bundle PR:**
- `gh pr merge` (with or without `--auto`)
- The GitHub UI merge button on that PR
- Any equivalent API call (`gh api`, raw HTTPS, etc.) that triggers
  the merge operation on that PR

**The operator merges. Not the agent.** This is the only person who
takes the merge action.

**Role separation:** the agent that prepared, reviewed, or filed a
bundle PR is prohibited from merging that PR, *even with apparent
operator approval in conversation.* Approval to merge becomes
binding only when expressed as the merge action itself (operator
clicks Merge or runs `gh pr merge` themselves). The agent's role
ends at "PR filed, operator notified."

**Consequence clause:** if an agent merge is detected on any bundle
PR — verifiable by the merge commit's author being the agent's
GitHub identity, or by the merge timestamp falling within an active
agent session without a corresponding operator action in the
session transcript — the response is:

1. **Immediate revert** of the offending merge as a separate PR.
2. **Suspension** of the transition plan; no further bundles filed
   until the operator restarts.
3. **Update** to this plan documenting the violation and any rule
   refinement required to prevent recurrence.

This is the same shape as the 2026-05-16 incident response —
treating an unauthorized merge as a recoverable governance failure,
not as a continuation of work.

### G3. Operator checkpoint before PR file

Between bundle code-review-clean and PR file (steps 4 → 5 in the
per-bundle process below), the agent **pauses and notifies the
operator** with: bundle name, files touched, test results, code
reviewer findings + responses. The operator confirms before the PR
is filed. This adds one operator touchpoint per bundle and removes
the failure mode where the operator's first visibility of a bundle
is a GitHub notification on an already-filed PR.

---

## Revival order — ranked, with skip-framing acknowledged

Ranking criterion: `(value × ease) ÷ risk`. **Every row's "skip"
option is legitimate** — the operator can drop any bundle at any
time and the transition continues without it. The "recommended"
column flags each bundle's default disposition; "skip is reasonable"
is annotated where the critique flagged a defensible drop.

| # | Bundle | Exploration PRs | Recommended | Skip is reasonable? | Why this slot |
|---|---|---|---|---|---|
| 1 | **Cost telemetry** | #776 | revive | unlikely (pure observability) | Zero behavioural risk; observability layer that makes every later bundle's value measurable. |
| 2 | **Operator-tier bench tooling** | #782, #793, #804 | revive | unlikely (enables future re-validation) | Moved up from old slot 4. Bench harness must exist on `develop` *before* the code that uses it (bundle 3). Pure tooling, no production behaviour change. |
| 3 | **Aspect extractor + scholarly-paper-v2 prompt** | #780, #790 | revive *with pre-merge bench* | yes if 84-paper bench is unacceptable | Moved down from old slot 2. Highest cost-savings lever per audit, but the 10-paper Grossberg bench is corpus-limited; **see §Validation V2 for the pre-merge full-corpus bench requirement.** |
| 4 | **Named call-site routing + `topic_labeler` + `plan_miss_planner`** | #778, #779 | revive | yes for `plan_miss_planner` if the 3.91× latency is operationally unacceptable | spike_e bench: 5/5 schema-valid both routings. Latency: `topic_labeler` 1.91×, `plan_miss_planner` **3.91×**. The planner is on the cold path (only on plan-match miss) so 60s latency is rare but operator-visible; if that's unacceptable, drop `plan_miss_planner` from the bundle and revive only `topic_labeler`. |
| 5 | **Tier-B substrate + `nx_enrich_beads`** | #796, #798, #799 | revive | yes if `nx` Qwen Code extension workstation provisioning is friction | Lowest-risk tier-B target. Prerequisite: operator workstations have `~/.qwen/extensions/nx/qwen-extension.json` installed (snippet in [`docs/integrations/qwen-dispatch-nexus.md`](integrations/qwen-dispatch-nexus.md)). |
| 6 | **Tier-B bench harness** | #797 | revive if 5 revived | trivially skipped if 5 skipped | Useful only after 5. Pure tooling. |
| 7a | **`nx_tidy` routing** (split from old bundle 7) | #805 (nx_tidy portion) + #810 (nx_tidy portion) | revive | yes if 5 didn't earn its slot | Clean qwen win: 5–8 tool calls in bench, schema-valid output. Independent of 7b. |
| 7b | **`nx_plan_audit` pin + experimental `verification_method` schema** (split from old bundle 7) | #805 (nx_plan_audit portion) + #810 (nx_plan_audit portion) + #812 + #813 | **revive only if the experimental schema field is judged useful** | **yes, often** | Net behaviour: nx_plan_audit pinned to claude (#813), plus `verification_method` field on findings (#812). The #810 nx_plan_audit prompt mandate is **confirmed non-functional against qwen** (audit emits 0 tool_use blocks regardless). The #812 schema is **untested against claude**: it forced structured admission but qwen lied through it; whether claude fills it accurately or treats it as boilerplate is unknown. **Skip is the default-defensible choice** unless the operator independently sees value in the schema field. |
| 8 | **Operator documentation** | re-author #816 | revive after 1–7 settled | unlikely if any of 1–7 land | Re-author against `develop`'s doc structure (CHANGELOG + README + configuration.md). Describes the final shipped surface. |

**Skipped from revival (not eligible):**

- **#817** (release v4.33.0) — release decision is downstream, not
  part of the integration transition.
- **#820** (revert of #817) — pairs with #817.

---

## Validation — what is and isn't accepted as prior evidence

Prior bench results are accepted **only when these conditions are
met:**

- **V1. Model version.** The qwentescence GGUF (or whichever backend
  is in play) has not been changed since the bench was run on
  2026-05-09/14/15. If it has, re-run the relevant bench before
  filing the PR. The bench harnesses for this are in bundles 2 and
  6; if they're not yet on `develop`, run them from the exploration
  branch or out-of-tree.
- **V2. Bundle 3 (aspect extractor) — pre-merge full-corpus
  bench.** The 10-paper Grossberg bench is not sufficient for the
  highest-volume call site in nexus. Before filing bundle 3's PR,
  run the full 84-paper aspect bench (§4.1 of the field report).
  Decision rule: revive only if semantic agreement on
  `experimental_datasets` ≥ 90% across the full corpus. If it lands
  below, file an issue and defer bundle 3 pending prompt revision.
- **V3. Interface drift.** Before filing **any** bundle PR, confirm
  with the operator whether RDR-110/113 or any subsequent RDR work
  has changed the interfaces or modules the bundle touches. Listed
  touched modules per bundle:
  - Bundle 1: `src/nexus/operators/qwen_dispatch.py`, `src/nexus/operators/dispatch.py`
  - Bundle 2: `scripts/spikes/spike_c_*.py`, `scripts/spikes/judge_*.py`
  - Bundle 3: `src/nexus/aspect_extractor.py`, `src/nexus/operators/qwen_dispatch.py`
  - Bundle 4: `src/nexus/operators/dispatch_router.py`, `src/nexus/commands/taxonomy_cmd.py`, `src/nexus/mcp/core.py` (planner section)
  - Bundle 5: `src/nexus/operators/qwen_agent_dispatch.py`, `src/nexus/mcp/core.py` (nx_enrich_beads), `tests/conftest.py`
  - Bundle 6: `scripts/spikes/spike_d_*.py`
  - Bundle 7a/7b: `src/nexus/mcp/core.py` (nx_tidy, nx_plan_audit)
  - Bundle 8: `CHANGELOG.md`, `README.md`, `docs/configuration.md`

  If the operator reports interface drift on any touched module, the
  bundle goes back to per-piece re-validation before file.

---

## Process per bundle

For each bundle in the revival table:

1. **Branch off `develop` (current tip).** Name:
   `feature/qwen-<bundle-slug>` (e.g. `feature/qwen-cost-telemetry`,
   `feature/qwen-tier-b-nx-tidy`).
2. **Cherry-pick from
   `exploration/qwen-offload-2026-05-15-2026-05-16`.** Most squash
   commits cherry-pick cleanly. Conflict-resolution threshold:
   - **≤30 lines of conflict resolution (excluding mechanical
     renames and import-path adjustments) → resolve.**
   - **>30 lines → stop, notify the operator, await direction.**
     Options at that point: (a) operator authorizes a re-implement
     of that piece; (b) operator authorizes a larger resolve; (c)
     bundle is deferred or skipped.

   The agent does not unilaterally re-implement.
3. **Run the existing test suite** for the touched files. No new
   tests added unless the cherry-pick already shipped them.
4. **Code review** via dispatched subagent (`Agent` tool,
   `feature-dev:code-reviewer` or `nx:code-review-expert`). Iterate
   on findings until clean.
5. **Operator checkpoint (G3).** Pause. Report to operator: bundle
   name, files touched, test results, reviewer findings + responses,
   any V3 interface-drift confirmations. **Wait for operator
   confirmation before proceeding.**
6. **File PR against `develop`.** PR description cites the original
   exploration PR number(s), links to bench evidence in this repo's
   docs, names the bundle and its slot in this plan, and explicitly
   states "no auto-merge; operator merges."
7. **Operator merges via the GitHub UI or `gh pr merge` from their
   own session.** The agent that filed the PR does not invoke merge
   (G2).

---

## Bundle dependencies

```
1. cost-telemetry          (independent — observability layer)
2. operator-tier bench     (independent — moved up; lands before code that uses it)
3. aspect-extractor + v2   (gated on V2 pre-merge full-corpus bench using bundle 2 tools)
4. named-call-site         (independent — primitive + two flips)
5. tier-B substrate        (depends on `nx` Qwen Code extension on workstations)
6. tier-B harness          (depends on #5)
7a. nx_tidy routing        (depends on #5; independent of 7b)
7b. audit pin + schema     (depends on #5; independent of 7a; skip is defensible)
8. operator documentation  (last)
```

Bundles 1, 2, 4 are fully parallelisable. Bundle 3 depends on 2 for
the bench tooling. Bundles 5, 6, 7a, 7b are sequential as a group (5
→ 6 → {7a, 7b}). Bundle 8 is last.

---

## Concurrent RDR work on `develop`

The qwen offload bundles file against `develop`, which is also the
other instance's working branch for the RDR-110/113 chain and any
subsequent RDR work. Conflict ownership:

- **If a bundle PR conflicts with an in-flight RDR PR**, the
  conflict is owned by **the qwen bundle PR** (the later-filing
  party). The RDR work proceeds; the bundle resolves the conflict
  via V3 interface-drift re-confirmation and, if necessary,
  re-cherry-pick or re-implement under the >30-line threshold.
- **If concurrent RDR work touches a module on bundle N's V3
  touched-modules list**, bundle N pauses until the RDR work is
  merged or the operator confirms parallel work is safe.

The qwen transition does not block RDR work. Order: RDR-110/113
landing through main (gate G1.1), then any later RDR work on
develop coexists with the transition.

---

## Decommission

The exploration branch
(`exploration/qwen-offload-2026-05-15-2026-05-16`) retires when:

1. All bundles ranked 1–7 above are merged into `develop` **or**
   explicitly skipped (operator marks the bundle skipped in this
   plan and moves on).
2. Bundle 8 (docs) is merged.
3. `develop` is merged through to `main` in a normal release cycle
   that includes the qwen offload work.

**Stale-bundle resolution.** Any bundle not merged AND not
explicitly operator-skipped within **90 calendar days** of gate-open
(G1.3) is eligible for automatic skip-marking by the operator at
their next review. The agent reports stale bundles at that
threshold; the operator decides. After 180 days, the entire
transition may be retired with any remaining bundles considered
abandoned.

Until decommission, the exploration branch is the authoritative
reference for the original code shape and is not to be force-pushed
or rebased onto `develop`. Bit-rot is expected and accepted —
cherry-picks resolve forward; the branch is a snapshot.

---

## Sonnet rate-constant refresh window

Bundle 1 ships cost-telemetry estimates pegged to 2026-05-14 Sonnet
4.x rates ($3 input, $15 output per MTok), as module-level constants
in `src/nexus/operators/qwen_dispatch.py`. Refresh is a separate
operator task, not gated on this transition:

- **Trigger:** Anthropic publishes new Sonnet pricing or the
  operator wants to peg telemetry to a different model.
- **Action:** edit `RATE_INPUT_USD_PER_MTOK` and
  `RATE_OUTPUT_USD_PER_MTOK` in the dispatcher file; update the
  comment naming the rate date.

Not part of any bundle's revival scope.

---

## What this plan does NOT do

- Does not commit any code. Planning artifact only.
- Does not assume any bundle will revive. Skip is a legitimate
  default for any bundle, including bundles 3, 4 (`plan_miss_planner`
  portion), 5, 7a, 7b, and 8 if conditions warrant. Bundle 7b's
  default disposition is closer to "skip" than "revive."
- Does not set deadlines for bundle revival. The gate is
  operator-driven; the 90/180-day clocks (§Decommission) are
  cleanup limits, not work pressure.
- Does not authorise any merge. Every PR filed during transition
  requires explicit operator merge (G2). This is a mechanical
  prohibition, not exhortation.
