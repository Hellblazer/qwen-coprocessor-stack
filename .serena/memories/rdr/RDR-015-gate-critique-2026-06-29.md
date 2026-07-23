# RDR-015 Gate Critique — 2026-06-29

**Outcome**: PASSED with 4 Significant issues

## Significant Issues

1. **Finding 1 n=1 idle-reap**: Single measurement (t+29m alive, t+30m gone) used to drop idle reaper from scope. Should be labeled as single-observation and noted as version-dependent (v0.15.x). Low practical risk (tsserver fallback footprint ~88MB/root is manageable) but the claim "MEASURED" overstates confidence.

2. **Finding 3 60s jdtls sample**: "Steady after ~5s warm-up" is implausible for full jdtls workspace indexing. jdtls indexes asynchronously post-initialization. The 1.7 GB/jdtls figure likely captures post-init RSS before background indexing peak. Cap limit calibration based on this measurement should be treated as a conservative starting point for per-host tuning, not a calibrated value. The direction (cap warranted) is correct; the number needs tuning in practice.

3. **LRU key (last_activity) not verified**: The cap's LRU eviction assumes daemon.json's `last_activity` field is updated on tool use. This was not verified in research. If it's only set at broker start, LRU degrades to FIFO. Should be verified at implementation.

4. **"Ops-side reaper" wording in Bright Line**: Confusing given the idle reaper was explicitly dropped. Should say "ops-side cap" or "ops-side eviction lever."

## Observations

1. No fallback for non-Java broker accumulation if the 30-min self-reap assumption fails.
2. Which keepalive hosts the cap is not specified (Mac keepalive vs box keepalive — agent-lsp runs on the Claude Code host (Mac), so the Mac keepalive is the right home).
3. The "4d10h orphaned typescript-language-server" evidence retracted as claude-owned LSP (verified ppid). Those processes have their own lifecycle concerns outside RDR-015 scope.
