# Qwen offload transition plan

**Authored:** 2026-05-16. **Revised:** 2026-05-17 (rev 2 after second-pass substantive critique).
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
   - A P0 / blocker incident filed against nexus (in beads or in
     GitHub issues; operator names which tracker is authoritative
     at gate-open time).
   - Any merge to `main` whose branch name contains the literal
     substring `hotfix`, `emergency`, or `urgent`, **or** whose
     associated PR carried a `P0` / `blocker` label at any point.

   "Stability" is the absence of those three named events over the
   named duration. No qualitative judgment. The third condition is
   intentionally strict — every hotfix-style merge resets the
   window, regardless of operator-perceived severity. If this
   produces too many false positives in practice, the operator
   loosens the rule by editing this plan, not by interpreting it
   permissively at gate-check time.

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

### G2. No-auto-merge — role separation + branch-protection backstop

This rule has two layers: an enumerated prohibition (defense in
depth) and a branch-protection backstop (the actual mechanical
guarantee). The prohibition without the backstop is exhortation;
the backstop without the prohibition leaves the agent in an
unclear role. Both must be in place.

**Layer 1 — prohibited actions for any agent that prepared or
filed a bundle PR:**

- `gh pr merge` (with or without `--auto`)
- The GitHub UI merge button on that PR
- Any equivalent API call (`gh api`, `gh api graphql`, raw HTTPS,
  GitHub Mobile, etc.) that triggers the merge operation on that
  PR
- **`git merge` followed by `git push origin develop` (or `main`)**
  — landing the bundle's commits on the target branch via direct
  push, bypassing the PR merge mechanism. This includes
  `git push --force` with a locally-merged history.
- Any other technique whose effect is "the bundle's commits appear
  on `origin/develop` or `origin/main` as a result of an
  agent-initiated action."

The list is intentionally over-specified. If an action would put
the bundle's commits on a protected branch and the actor is the
agent, the action is prohibited.

**Layer 2 — branch-protection prerequisite (mechanical
guarantee):**

Before the first bundle PR is filed, the operator confirms that
nexus `develop` and `main` carry the following branch-protection
rules on GitHub:

- **`develop`**: require pull requests for all changes; block
  direct push; require status checks to pass before merging.
- **`main`**: same as `develop`, plus restrict merges to
  designated operator-administered identities.

The operator confirms via reply or by linking the branch-protection
settings page. The plan does not proceed until this is confirmed.
The branch-protection rules are the actual mechanism — they
prevent the direct-push path even if an agent ignores the Layer 1
prohibition. Layer 1 still applies because Layer 2 doesn't cover
every imaginable bypass (e.g., an operator account compromise);
defense in depth.

**Role separation:** the agent that prepared, reviewed, or filed a
bundle PR is prohibited from merging that PR, *even with apparent
operator approval in conversation.* Approval to merge becomes
binding only when expressed as the merge action itself (operator
clicks Merge or runs `gh pr merge` themselves). The agent's role
ends at "PR filed, operator notified."

**Detection — assigned and scheduled, not passive:**

At each G3 checkpoint (before filing a new bundle PR), the
operator runs:

```
git fetch origin
git log --merges --since="<previous G3 timestamp>" \
  --author='<agent-identity-email>' \
  origin/develop origin/main
```

If the command returns any commits, the consequence clause fires.
Detection is the operator's scheduled action; the consequence
clause does not depend on the agent self-reporting a violation.

**Consequence clause:** if an agent merge is detected (per the
detection rule above, or by any other operator-initiated review):

1. **Immediate revert** of the offending merge as a separate PR.
2. **Suspension** of the transition plan; no further bundles filed
   until the operator restarts.
3. **Update** to this plan documenting the violation and any rule
   refinement required to prevent recurrence.

This is the same shape as the 2026-05-16 incident response —
treating an unauthorized merge as a recoverable governance failure,
not as a continuation of work.

### G3. Operator checkpoint before PR file

Between bundle code-review-clean (process step 4) and PR file
(process step 6), the agent **pauses at step 5 and notifies the
operator** with:

- Bundle name + slot in revival order
- Files touched
- Test results
- Code reviewer findings + responses
- **Cherry-pick threshold report** (from process step 2):
  - Total conflict-resolution lines
  - Lines excluded as mechanical-rename/import-path
  - Per-excluded-block: file + line range + reason for exclusion
- **Concurrent RDR check**: any RDR PRs landed on `develop` that
  touch this bundle's V3 module list since the last G3 checkpoint
- **Detection result (G2)**: output of the `git log --merges
  --author='<agent-identity>'` command since the previous G3,
  attesting no agent merges have occurred

The operator confirms before the PR is filed. This adds one
operator touchpoint per bundle and removes the failure mode where
the operator's first visibility of a bundle is a GitHub
notification on an already-filed PR.

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
| 3 | **Aspect extractor + scholarly-paper-v2 prompt** | #780, #790 | revive *with pre-merge bench* | yes if 84-paper bench fails the ≥90% rule, **OR** if the **5–12× per-paper ingest latency** (field report §1.4) is operationally unacceptable for the ingest hot path | Moved down from old slot 2. Highest cost-savings lever per audit, but the 10-paper Grossberg bench is corpus-limited; **see §Validation V2 for the pre-merge full-corpus bench requirement.** Latency skip path explicitly named to match bundle 4's framing. |
| 4 | **Named call-site routing + `topic_labeler` + `plan_miss_planner`** | #778, #779 | revive | yes for `plan_miss_planner` if the 3.91× latency is operationally unacceptable | spike_e bench: 5/5 schema-valid both routings. Latency: `topic_labeler` 1.91×, `plan_miss_planner` **3.91×**. The planner is on the cold path (only on plan-match miss) so 60s latency is rare but operator-visible; if that's unacceptable, drop `plan_miss_planner` from the bundle and revive only `topic_labeler`. |
| 5 | **Tier-B substrate + `nx_enrich_beads`** | #796, #798, #799 | revive | yes if `nx` Qwen Code extension workstation provisioning is friction | Lowest-risk tier-B target. Prerequisite: operator workstations have `~/.qwen/extensions/nx/qwen-extension.json` installed (snippet in [`docs/integrations/qwen-dispatch-nexus.md`](integrations/qwen-dispatch-nexus.md)). |
| 6 | **Tier-B bench harness** | #797 | revive if 5 revived | trivially skipped if 5 skipped | Useful only after 5. Pure tooling. |
| 7a | **`nx_tidy` routing** (split from old bundle 7) | #805 (nx_tidy portion) + #810 (nx_tidy portion) | revive | yes if 5 didn't earn its slot | Clean qwen win: 5–8 tool calls in bench, schema-valid output. Independent of 7b. **See §Bundle 7 split mechanics — #805 and #810 are each single commits covering both tools; achieving the split requires partial-commit application, not standard cherry-pick.** |
| 7b | **`nx_plan_audit` pin + experimental `verification_method` schema** (split from old bundle 7) | #805 (nx_plan_audit portion) + #810 (nx_plan_audit portion) + #812 + #813 | **revive only if the experimental schema field is judged useful** | **yes, often** | Net behaviour: nx_plan_audit pinned to claude (#813), plus `verification_method` field on findings (#812). The #810 nx_plan_audit prompt mandate is **confirmed non-functional against qwen** (audit emits 0 tool_use blocks regardless). The #812 schema is **untested against claude**: it forced structured admission but qwen lied through it; whether claude fills it accurately or treats it as boilerplate is unknown. **Skip is the default-defensible choice** unless the operator independently sees value in the schema field. **See §Bundle 7 split mechanics — partial-commit application required.** |
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
   commits cherry-pick cleanly.

   **Pre-cherry-pick concurrent-RDR check.** Before invoking
   `git cherry-pick`, run:

   ```
   git fetch origin
   git log --since="<previous-bundle's-G3-timestamp>" \
     origin/develop -- <bundle's-V3-touched-modules>
   ```

   If any commits are returned, pause and notify the operator
   before proceeding — concurrent RDR work may have shifted the
   target modules' interfaces.

   **Conflict-resolution threshold:**

   - **≤30 lines of conflict resolution → resolve.** Excluded from
     the count: lines that meet the precise definition of
     "mechanical change" below.
   - **>30 lines → stop, notify the operator, await direction.**
     Options at that point: (a) operator authorizes a re-implement
     of that piece; (b) operator authorizes a larger resolve; (c)
     bundle is deferred or skipped.

   **Mechanical change — precise definition.** A line counts as
   mechanical (excluded from the 30-line budget) if **all three**
   of the following hold:

   1. The change is a token-for-token substitution with no
      surrounding logic edit (e.g. `from nexus.old.module import X`
      → `from nexus.new.module import X`; `OldClassName(...)` →
      `NewClassName(...)`).
   2. The substitution would be expressible as a `sed`
      one-liner — no understanding of surrounding semantics is
      needed to perform it correctly.
   3. The change does not affect control flow, type signatures, or
      data shape.

   If any of (1)–(3) is in doubt, the line is **not** mechanical
   and counts toward the threshold. At the G3 checkpoint the agent
   reports total conflict-resolution lines, lines excluded as
   mechanical, and the per-block reason for each exclusion — so
   the operator surfaces the threshold call.

   **The agent does not unilaterally re-implement.**
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

## Bundle 7 split mechanics — partial-commit application

PR #805 in the exploration is a single squash commit that routes
*both* `nx_tidy` and `nx_plan_audit` through `qwen_agent_dispatch`.
PR #810 is likewise a single squash commit covering both tools'
prompt revisions. The 7a/7b split is therefore not achievable by
standard `git cherry-pick`; it requires partial-commit application.

**Process for bundle 7a (`nx_tidy` only):**

1. Branch off `develop`. Cherry-pick the full #805 squash commit.
2. **On the same branch**, revert only the lines/sections in
   `src/nexus/mcp/core.py` that touch `nx_plan_audit`. Leave the
   `nx_tidy` routing intact. Same for the conftest env-isolation
   additions — keep them; they are shared infrastructure.
3. Cherry-pick the full #810 squash commit. Revert the
   nx_plan_audit prompt-mandate portions; keep the nx_tidy
   prompt-mandate portions.
4. The selective-revert lines count toward the 30-line threshold
   the same as any conflict-resolution lines. If the count
   exceeds 30, the bundle pauses for operator direction. Lines
   that are pure deletion of nx_plan_audit-specific code (no logic
   re-wiring) count as mechanical per the definition above.

**Process for bundle 7b (`nx_plan_audit` pin + schema):**

Symmetric — cherry-pick #805 and #810, revert the `nx_tidy`
portions, keep the `nx_plan_audit` portions. Then cherry-pick #812
(`verification_method` schema) and #813 (pin to claude) cleanly —
those are independent single-purpose commits.

**Ordering between 7a and 7b:** independent. Either can land
first. If both are pursued, the second one's cherry-picks will
re-encounter the shared infrastructure changes already on develop
from the first — these resolve as no-ops or trivial merges.

**If the partial-commit work exceeds the threshold for either
half**, the operator decides whether to (a) re-implement the
nx_tidy-only or audit-only change against develop's current tree
using the exploration commit as a reference, or (b) merge bundles
7a + 7b as the original single bundle 7. The plan does not assume
the split is always achievable; it expresses a preference.

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
explicitly operator-skipped within **90 calendar days of gate-open
time-in-open** (G1.3) is eligible for automatic skip-marking by the
operator at their next review. The agent reports stale bundles at
that threshold; the operator decides. After **180 days of
time-in-open**, the entire transition may be retired with any
remaining bundles considered abandoned.

**"Time-in-open" means wall-clock days while the gate is open.**
If the gate closes (destabilizing event per G1.2), the 90/180-day
clocks pause for the duration of the closure and resume on the
next gate-open. This prevents bundles being declared stale during
periods when work was prohibited.

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
- **Discovery:** the operator subscribes to Anthropic pricing
  changes via the Anthropic changelog / pricing page / billing
  email notifications. The agent does not monitor pricing and
  does not initiate refreshes. If the operator notices stale
  rates during normal use of the cost-telemetry log (e.g. the
  would-have-cost number doesn't match the operator's bill), that
  is also a trigger.
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
