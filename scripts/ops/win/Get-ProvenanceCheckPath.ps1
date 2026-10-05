<#
.SYNOPSIS
    RDR-016 (model & runtime provenance) cheap keepalive membership check.

.DESCRIPTION
    Exit 0 iff -Path's basename OR relative path matches a files[].path
    entry belonging to a manifest artifact with status == "verified" and
    -TargetHost present in that artifact's verified_on[]; otherwise exit 1
    with a one-line reason on stdout. Does NOT hash anything — this is the
    cheap per-respawn check the keepalive runs before launching a model
    (RDR-016 Approach item 5); a full re-hash is Test-Provenance.ps1 /
    `provenance.py verify`, run on demand, not per respawn.

    AMBIGUITY (code-review 2026-08-15, bd qwen-coprocessor-stack-qdz):
    basename+size can legitimately collide across manifest entries (a stale
    retro-manifest entry left in place after a re-quantize is exactly the
    shape this RDR's own workflow produces). When more than one candidate
    entry matches, this script does NOT take the first one blindly: it
    accepts only if every matching candidate shares the same sha256 (i.e.
    the ambiguity is cosmetic — same content, different artifact records);
    otherwise it refuses and lists the candidate artifact ids, telling the
    caller to pass -Id to disambiguate. Pass -Id once the caller knows which
    artifact id it expects (the keepalive can cache this after a fetch/
    register) to skip the whole-manifest scan. Pass -Size to additionally
    require the on-disk file's expected size to match the manifested size
    before a candidate counts.

    Intended caller: the Mac keepalive, over ssh, before launching a model:

        ssh -n qwentescence 'powershell -File D:\claude-coordination\Get-ProvenanceCheckPath.ps1 -Manifest D:\claude-coordination\MANIFEST.json -Path D:\models\qwen3-coder-next\Qwen3-Coder-Next-UD-Q4_K_XL.gguf -TargetHost box -Id qwen3-coder-next-q4kxl'

    DEPLOYMENT: see the header of Get-ProvenanceListing.ps1 for the scp
    commands that copy this script (alongside the other two) to
    D:\claude-coordination\ on the box. Not deployed by this repo automatically.

.PARAMETER Manifest
    Path to models/MANIFEST.json (or a box-local copy of it).

.PARAMETER Path
    The model (or mmproj) file path the keepalive is about to launch.

.PARAMETER Id
    Optional artifacts[].id to narrow the search to. When given, only that
    artifact's files[] are considered — the whole-manifest basename scan
    (and its ambiguity risk) is skipped entirely. Recommended once the
    caller knows the expected artifact id.

.PARAMETER Size
    Optional expected file size in bytes (Int64). When given, a files[]
    entry only counts as a candidate if its manifested `size` equals this
    value.

.PARAMETER TargetHost
    Host label to require in the matched artifact's verified_on[] (default
    "box" — this script is meant to run on the box). Named TargetHost, not
    Host, to avoid shadowing the PowerShell automatic $Host variable.

.NOTES
    PowerShell 5.1 target (box has no pwsh 7, no python — RDR-016 F4).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Manifest,

    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $false)]
    [string]$Id,

    [Parameter(Mandatory = $false)]
    [Nullable[Int64]]$Size,

    [Parameter(Mandatory = $false)]
    [string]$TargetHost = 'box'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
    Write-Output "NOT VERIFIED: manifest not found: $Manifest"
    exit 1
}

$manifestJson = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json

$targetBasename = Split-Path -Path $Path -Leaf
$targetRel = ($Path -replace '\\', '/')

# Candidates: one object per matching (artifact.id, fileEntry) pair, across
# every artifact that is verified for -TargetHost (and, if -Id was given,
# restricted to that single artifact).
$candidates = New-Object System.Collections.Generic.List[object]

foreach ($artifact in $manifestJson.artifacts) {
    if ($artifact.status -ne 'verified') {
        continue
    }
    if (-not $artifact.verified_on -or -not ($artifact.verified_on -contains $TargetHost)) {
        continue
    }
    if ($PSBoundParameters.ContainsKey('Id') -and $artifact.id -ne $Id) {
        continue
    }

    foreach ($fileEntry in $artifact.files) {
        # Adopted entries (provenance.py adopt) record the HF path in `path` and the
        # on-disk name in `local_path`; the served filename is whichever exists on
        # disk, so match against both (mirrors cmd_check_path in provenance.py).
        $entryPath = [string]$fileEntry.path
        $candidatePaths = @($entryPath)
        if ($null -ne $fileEntry.local_path -and [string]$fileEntry.local_path -ne '') {
            $candidatePaths += [string]$fileEntry.local_path
        }
        $pathMatched = $false
        foreach ($cp in $candidatePaths) {
            $cpBasename = Split-Path -Path $cp -Leaf
            $cpRel = ($cp -replace '\\', '/')
            if ($cpBasename -eq $targetBasename -or $cpRel -eq $targetRel) { $pathMatched = $true; break }
        }
        if (-not $pathMatched) {
            continue
        }

        if ($PSBoundParameters.ContainsKey('Size')) {
            $entrySize = $null
            if ($null -ne $fileEntry.size) {
                $entrySize = [Int64]$fileEntry.size
            }
            if ($entrySize -ne $Size) {
                continue
            }
        }

        $candidates.Add([PSCustomObject]@{
            ArtifactId = $artifact.id
            Sha256     = ([string]$fileEntry.sha256).ToLowerInvariant()
        })
    }
}

if ($candidates.Count -eq 0) {
    Write-Output "NOT VERIFIED: $Path has no manifest entry with status=verified and '$TargetHost' in verified_on"
    exit 1
}


# @() forces array semantics even for a single match — a bare
# Select-Object -Unique result collapses to a scalar string when there is
# exactly one distinct value, and a scalar's .Count is not something to
# depend on across PowerShell versions.
$distinctHashes = @($candidates | Select-Object -ExpandProperty Sha256 -Unique)

if ($distinctHashes.Count -eq 1) {
    # Every candidate — even if there are several artifact records — agrees
    # on content. Not ambiguous. Silent success (cheap path, no chatter on
    # the happy path the keepalive hits every respawn).
    exit 0
}

$candidateIds = ($candidates | Select-Object -ExpandProperty ArtifactId -Unique) -join ', '
Write-Output "NOT VERIFIED: $Path matches $($candidates.Count) manifest entries with different content (ids: $candidateIds) -- ambiguous; pass -Id to disambiguate"
exit 1
