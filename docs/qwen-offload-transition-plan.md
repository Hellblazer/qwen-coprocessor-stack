# Qwen offload transition plan

**Authored:** 2026-05-16.
**Target:** nexus `develop`.
**Reference:** [`exploration/qwen-offload-2026-05-15-2026-05-16`](https://github.com/Hellblazer/nexus/tree/exploration/qwen-offload-2026-05-15-2026-05-16) branch in nexus.
**Code review:** dispatched subagent (no per-PR external review needed).
**Validation:** prior bench results accepted; no per-revival re-bench unless a bundle's behaviour changes during cherry-pick.

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

## Pre-condition gate

**This plan is fully blocked until both of these conditions are
true:**

1. The RDR-110/111/112/113 remediation chain (the other instance's
   work on nexus `develop`) is landed AND merged through to `main`.
2. Nexus stability/reliability has been observed for at least one
   rolling work cycle after that merge — no rollbacks, no major
   regressions, no pending hotfixes.

The qwen offload work does not touch any of the same code paths as
the RDR-110/113 work (the file-overlap audit confirmed
orthogonality), but the gate is about *nexus stability as a whole*,
not just file conflicts. Revival starts only after the integration
branch is calm.

---

## Revival order — ranked by `(value × ease) ÷ risk`

| # | Bundle | PRs (from exploration) | Why this slot |
|---|---|---|---|
| 1 | **Cost telemetry** | #776 | Pure observability, zero behavioural risk. Single small PR. Lands first so the value of everything that follows is measurable from day one. |
| 2 | **Aspect extractor + scholarly-paper-v2 prompt** | #780, #790 | Highest cost-savings lever per the audit — per-document on ingest is the heaviest `claude -p` shell-out in nexus. Bench: 100% semantic on `experimental_datasets`, 93% on `experimental_baselines`. Default-unchanged opt-in via `NEXUS_ASPECT_BACKEND=qwen` + `NEXUS_SCHOLARLY_PAPER_VERSION=v2`. |
| 3 | **Named call-site routing + `topic_labeler` + `plan_miss_planner`** | #778, #779 | Reusable `pick_dispatcher_for(call_site)` primitive in `dispatch_router`, plus two low-risk routings. spike_e bench: 5/5 schema-valid on both. Default unchanged. |
| 4 | **Operator-tier bench tooling** | #782, #793, #804 | spike_c harness + `--prompt-override` + generalised `judge_parity_diffs.py`. Not behaviour-changing for production but enables re-validation on future qwen model upgrades. |
| 5 | **Tier-B substrate + `nx_enrich_beads`** | #796, #798, #799 | The MCP-stdio supervisor integration. Requires the `nx` Qwen Code extension to be installed (snippet documented in this repo). `nx_enrich_beads` is the lowest-risk tier-B target — bench-validated; default claude with `NEXUS_TIER_B_DISPATCHER=qwen_agent` opt-in. |
| 6 | **Tier-B bench harness** | #797 | Only useful once #5 has landed. Enables re-validation of tier-B routings. |
| 7 | **`nx_tidy` + `nx_plan_audit` routing with audit pinned** | #805, #810, #812, #813 | `nx_tidy` works on qwen (5–8 tool calls in bench). `nx_plan_audit` doesn't, gets pinned to claude as part of the same bundle. Net behavioural effect: one new working routing + one explicit pin + one schema-honesty improvement (`verification_method` on findings). |
| 8 | **Operator documentation** | re-author #816 | Re-author against `develop`'s doc structure rather than cherry-picking #816 (which targeted main and assumed main's doc layout). Add CHANGELOG entries, README section, configuration.md reference. Last to land so it can describe the final state. |

**Skipped from revival:**

- #817 (release v4.33.0) — release decision is downstream, not part
  of the integration transition.
- #820 (revert of #817) — pairs with #817.

---

## Process per bundle

For each bundle in the table above:

1. **Branch off `develop` (current tip).** Name:
   `feature/qwen-<bundle-slug>` (e.g. `feature/qwen-cost-telemetry`,
   `feature/qwen-aspect-extractor-v2`).
2. **Cherry-pick from `exploration/qwen-offload-2026-05-15-2026-05-16`.**
   Most squash-merge commits will cherry-pick cleanly; if a
   cherry-pick conflicts (because `develop` has evolved during the
   gate wait), re-implement that piece on the new branch using the
   exploration commit as the reference. Do not force the cherry-pick.
3. **Run the existing test suite** for the touched files. No new
   tests added unless the cherry-pick introduces them — the
   exploration commits already shipped test coverage for the code
   they introduced.
4. **Code review** via dispatched subagent (`Agent` tool,
   `feature-dev:code-reviewer` or similar). Iterate on findings
   until clean.
5. **File PR against `develop`.** PR description cites the original
   exploration PR number, links to the bench evidence in this repo's
   docs, names the bundle and its slot in this transition plan.
6. **Operator merges when satisfied.** **No auto-merge.** No
   exceptions.

---

## Bundle dependencies

```
1. cost-telemetry          (independent — pure observability layer)
2. aspect-extractor + v2   (depends on nothing; lands second for value reasons)
3. named-call-site         (independent — primitive + two flips)
4. operator-tier bench     (cherry-picks from spike_c — independent)
5. tier-B substrate        (depends on the `nx` Qwen Code extension being installed
                            at ~/.qwen/extensions/nx/qwen-extension.json on operator
                            workstations; otherwise standalone)
6. tier-B harness          (depends on #5 — the spike imports qwen_agent_dispatch)
7. tier-B remainder        (depends on #5 + #6 — extends the substrate)
8. docs                    (last — describes the final shipped surface)
```

Bundles 1–4 are parallelisable (no inter-dependencies — operator can
land any of them in any order if convenient). Bundles 5–7 are
sequential. Bundle 8 is last regardless.

---

## Decommission

The exploration branch retires when:

1. All bundles ranked 1–7 above are merged into `develop` **or**
   explicitly skipped (i.e. operator decides a bundle's value isn't
   worth the effort post-revival → mark it skipped in this doc and
   move on).
2. Bundle 8 (docs) is merged.
3. `develop` is merged through to `main` in a normal release cycle
   that includes the qwen offload work.

Until then, the exploration branch is the authoritative reference
for the original code shape and is not to be force-pushed or rebased
onto `develop`. Bit-rot is expected and accepted — cherry-picks
resolve forward; the branch is a snapshot.

---

## What this plan does NOT do

- Does not commit any code. This is a planning artifact only.
- Does not assume any bundle will revive. Operator can drop any of
  them at any time during the transition (including by reading this
  plan back and saying "skip 7"). The plan is a default, not a
  commitment.
- Does not set deadlines. The pre-condition gate is open-ended; the
  RDR-110/113 timeline drives the start, and per-bundle pace is
  operator-driven from there.
- Does not authorise any merge. Every PR filed during transition
  requires explicit operator per-PR consent before merge. This is a
  process rule, not a convention to drift on.
