<!-- SPDX-License-Identifier: MIT -->
# Post-mortem: RDR-015 — codeIntel agent-lsp daemon lifecycle

**Closed:** 2026-09-20 · **Reason:** implemented · **Type:** Design ·
**Epic:** `qwen-coprocessor-stack-mil` · **PRs:** #104/#105/#106 (docs), merged 2026-09-17

## What shipped

Documentation of the real LSP lifecycle, and no code. `docs/USER_GUIDE.md` and
`docs/ARCHITECTURE.md` now state that TypeScript and Go get automatic warm
cross-spawn reuse through agent-lsp's per-(root, language) daemon-broker, which
survives supervisor teardown and self-reaps after roughly 30 minutes idle; that
jdtls does not, because it runs in-process under each spawn's `uvx agent-lsp`
as one shared instance across that spawn's Java roots and dies at teardown; and
that the cold-start amortizer for Java is therefore the committable
`.agent-lsp/cache.db.gz` symbol cache, not broker reuse. Operators bound
parallel Java use by hand against a measured ~2 GB per concurrent jdtls
(`mil.1`, ~1.9 GB on a large Maven repo).

The supervisor and the keepalives were not touched. That was the deliverable,
not an omission.

## What diverged

The RDR was accepted on 2026-06-29 around a code deliverable: a jdtls-weighted
FIFO cap on resident agent-lsp brokers, to live in the Mac keepalive and evict
the oldest-started Java broker via `agent-lsp daemon-stop` once a per-host limit
was exceeded. Beads were cut for the build (`mil.2`) and for two mandatory
reviews of the resulting diff (`mil.3`, `mil.4`).

Then `mil.1` went to measure the per-jdtls plateau that would calibrate the cap,
and found something else. Four probes against the same agent-lsp 0.15.0 and
jdtls 1.57.0, driven exactly as `applyCodeIntel` launches them, showed jdtls
never appears in `~/.cache/agent-lsp/daemons/` at all. It is not a broker. The
cap would have enumerated an empty registry and evicted nothing, forever, while
looking like it worked.

The RDR was re-opened on 2026-07-01, the re-gate came back BLOCKED on two
criticals, the design was corrected to the measured behaviour, and it was
re-gated and re-accepted on 2026-07-02 with the cap retracted and any
spawn-concurrency mitigation deferred to a future supervisor-side RDR — that
mitigation would have to live in the supervisor, which would cross the RDR-013
bright line and so needs its own design. `mil.2`, `mil.3` and `mil.4` were
closed as obsolete, each stating the retraction in its close reason. `mil.5`
and `mil.6` were rescoped from documenting warm reuse to documenting the
corrected split.

## Drift classification

**Unvalidated assumption.** Findings 1 and 2 measured broker survival and idle
self-reap against TypeScript and Go, and the design generalised that to jdtls
without measuring it. Java was the only language with material RAM and the
entire justification for the cap, so the one language the design depended on
was the one language never probed. Finding 3 compounded it: a 60-second sample
was read as a steady-state plateau when jdtls was still indexing
asynchronously, which made a floor look like a calibrated value.

The correction was caught by the bead whose job was to calibrate the mechanism,
one step before the build. That is late, but it is inside the process rather
than outside it — the cap was never written, so nothing had to be reverted.

## What to take from it

Measure the case the design depends on, not the case that is easy to measure.
TS and Go were convenient probes; Java was the one that mattered, and the two
behave differently enough that the whole deliverable evaporated when Java was
finally measured directly.

A second, smaller thing. The epic's acceptance criteria still read "Cap ships in
`scripts/ops/keepalive-coprocessor.sh` + plist, limit tuned against a measured
jdtls plateau" until this close, eleven weeks after the cap was retracted and
one day after the criteria were written. The RDR, the gate record and every
bead close reason all said the cap was gone; the epic's own success condition
still demanded it, and named the wrong keepalive besides. Retracting a
deliverable means editing every place that asserts it, including the tracker.
A stale acceptance criterion is how a correctly-closed epic still reads as a
silent scope reduction to the next auditor.

## Loose ends

`mil.7` (set `AGENT_LSP_BROKER_TIMEOUT_MS` for broker start-timeout headroom on
large cold TS/Go repos) and `mil.8` (pin an installed `agent-lsp` over
`uvx agent-lsp` to drop the per-spawn resolve) stay open at P4. Both are marked
"Deferred (optional, not this cycle)" in the RDR's own Approach and neither
gates the close.

The deferred spawn-concurrency cap is not tracked by a bead. It is gated on
measured need — heavy parallel first-class Java use contending with the served
model — and needs its own RDR when that need appears.
