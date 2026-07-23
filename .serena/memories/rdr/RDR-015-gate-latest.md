# RDR-015 Re-Gate Critique — 2026-07-01

**Outcome**: PASSED (with 2 Significant issues)
**Prior outcome**: BLOCKED (2 Critical + 3 Significant, 2026-06-29/30)

## Prior Issues Status

- C1 (retract daemon-stop FIFO cap): RESOLVED — explicitly retracted in Decision, Out-of-scope, Finding 3 reframe, Finding 4 ✓
- C2 (scope warm reuse to TS/Go): RESOLVED — explicit TS/Go scope in Decision preamble, In-scope item 1, Finding 1 header + scope correction box, Finding 4 ✓
- S1 (Consequences/Negative "held up to 30 min" for jdtls): RESOLVED in Consequences/Negative ("held only for the spawn's lifetime, not 30 min") ✓
- S2 (reframe Finding 3 as concurrent-spawn, retract eviction lever): RESOLVED — reframe header in Finding 3, "eviction lever RETRACTED" explicit ✓
- S3 (Consequences/Neutral "gated on that cap"): RESOLVED — removed, replaced with "NOT automatically bounded / operators bound manually" ✓
- Finding 1 TS scope + Finding 4 added: RESOLVED ✓

## New Significant Issues (introduced by revision)

### SIG-1: Finding 2 not updated to reflect Finding 4
Finding 2 body still says "burst of distinct Java roots within the 30 min window," "peak simultaneous Java brokers," and "resident-broker cap is the only candidate mitigation" for Java footprint. Finding 4 establishes that jdtls is in-process, not a broker, and the 30 min window and broker cap don't apply to jdtls. Finding 2 has NO scope correction notice, unlike Finding 1 (which got a scope correction box) and Finding 3 (which got a reframe header). A reader stopping at Finding 2 forms the wrong model.

### SIG-2: Finding 3 extrapolation bullet retains "30 min idle window" for Java
Extrapolation bullet: "6 concurrent Java roots ≳ ~10 GB, held up to the 30 min idle window." Jdtls is in-process and dies at teardown (spawn duration, not 30 min). The reframe header corrects the mechanism but the body text was not updated. This contradicts Finding 4 and Consequences/Negative.

## No Critical Issues
Decision, Consequences, Out-of-scope are all correct and internally consistent. Deferral of spawn-concurrency cap is honest (explicit, with reason, trigger condition, and interim operator guidance).

## Observations
- mil.1 integration (~2 GB plateau) is correct: 1.7 GB labeled as floor (60s short-sample), ~2 GB planning figure from Finding 4 mil.1, range "~0.8–2 GB" in Decision is consistent.
- Docs deliverable is concrete enough: formula K × ~2 GB, cache recipe, TS/Go auto guidance.
- Approach item 3 says "optionally set AGENT_LSP_BROKER_TIMEOUT_MS" — soft ambiguity in a "no code" RDR; low risk since intent is clear.
