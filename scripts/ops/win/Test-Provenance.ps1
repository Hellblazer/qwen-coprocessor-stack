<#
.SYNOPSIS
    RDR-016 (model & runtime provenance) box-side manifest verification.

.DESCRIPTION
    Loads models/MANIFEST.json (or a copy of it on the box), finds the
    artifacts[] entry with the given -Id, resolves each files[] entry under
    -Root, hashes it, and compares to the manifest's recorded sha256. Prints
    OK / MISMATCH / MISSING / UNSAFE per file and a summary. Exits 0 only if
    every checked file was OK; exits 2 otherwise (including "artifact id not
    found", "manifest not found", and any UNSAFE path).

    This script NEVER writes to the manifest. Stamping `verified_on` is a
    Mac-side operation (`provenance.py verify --listing`, after running
    Get-ProvenanceListing.ps1 on the box and copying the listing back) — see
    RDR-016 Approach item 3/item 1 (`hash-listing` / `import-listing`).

    For `kind: "runtime"` entries, files[] items whose `path` starts with
    `zip:` (the zip-member-path convention for archive contents) are skipped
    — this script only resolves and hashes real filesystem paths under
    -Root; it does not open zip archives.

    PATH SAFETY (code-review 2026-08-15): a manifest is a trusted committed
    file today, but this script treats it as untrusted input defense-in-
    depth against a poisoned/corrupted manifest (see the related path-
    traversal finding against provenance.py's fetch path). Any files[].path
    that contains a ".." segment, starts with "/" or "\", or starts with a
    drive letter (e.g. "C:") is refused outright — never resolved or hashed
    — and reported as UNSAFE rather than silently Join-Path'd (which on
    Windows would happily escape -Root for an absolute or ".."-laden path).

    DEPLOYMENT: see the header of Get-ProvenanceListing.ps1 for the scp
    commands that copy this script (alongside the other two) to
    D:\claude-coordination\ on the box. Not deployed by this repo automatically.

.PARAMETER Manifest
    Path to models/MANIFEST.json (or a box-local copy of it).

.PARAMETER Id
    The artifacts[].id to verify (e.g. "llama-b10078-vulkan-win-x64").

.PARAMETER Root
    Directory the manifest's relative files[].path entries are resolved
    against (e.g. D:\models or D:\llama-b10078).

.PARAMETER TargetHost
    Label recorded for informational purposes only (default "box") — this
    script does not write to the manifest, so -TargetHost does not change
    any stored state; it exists for symmetry with Get-ProvenanceCheckPath.ps1
    and to make output/log lines self-describing when both scripts' output
    is collected centrally. Named TargetHost, not Host, to avoid shadowing
    the PowerShell automatic $Host variable.

.NOTES
    PowerShell 5.1 target (box has no pwsh 7, no python — RDR-016 F4).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Manifest,

    [Parameter(Mandatory = $true)]
    [string]$Id,

    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $false)]
    [string]$TargetHost = 'box'
)

$ErrorActionPreference = 'Stop'

function Test-SafeRelPath {
    param([string]$RelPath)

    if ([string]::IsNullOrEmpty($RelPath)) {
        return $false
    }
    # Absolute forms: leading slash/backslash, or a drive letter ("C:...").
    if ($RelPath.StartsWith('/') -or $RelPath.StartsWith('\')) {
        return $false
    }
    if ($RelPath -match '^[A-Za-z]:') {
        return $false
    }
    # Traversal: a ".." path segment anywhere, either separator style.
    $normalized = $RelPath -replace '\\', '/'
    if ($normalized -match '(^|/)\.\.($|/)') {
        return $false
    }
    return $true
}

if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) {
    Write-Error "Manifest not found: $Manifest"
    exit 2
}
if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    Write-Error "Root not found or not a directory: $Root"
    exit 2
}

$manifestJson = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json

$artifact = $manifestJson.artifacts | Where-Object { $_.id -eq $Id } | Select-Object -First 1
if ($null -eq $artifact) {
    Write-Error "Artifact id not found in manifest: $Id"
    exit 2
}

$resolvedRoot = (Resolve-Path -LiteralPath $Root).ProviderPath.TrimEnd('\', '/')

$okCount = 0
$mismatchCount = 0
$missingCount = 0
$skipCount = 0
$unsafeCount = 0

Write-Output "Verifying artifact '$Id' ($($artifact.kind)) against $resolvedRoot [host=$TargetHost]"

foreach ($fileEntry in $artifact.files) {
    $relPath = [string]$fileEntry.path

    if ($artifact.kind -eq 'runtime' -and $relPath -like 'zip:*') {
        Write-Output "SKIP     (zip member, not a filesystem path) $relPath"
        $skipCount++
        continue
    }

    if (-not (Test-SafeRelPath -RelPath $relPath)) {
        Write-Output "UNSAFE   $relPath (contains '..', or is absolute/drive-rooted; refusing to resolve outside -Root)"
        $unsafeCount++
        continue
    }

    $winRelPath = $relPath -replace '/', '\'
    $fullPath = Join-Path -Path $resolvedRoot -ChildPath $winRelPath

    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        Write-Output "MISSING  $relPath"
        $missingCount++
        continue
    }

    $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = ([string]$fileEntry.sha256).ToLowerInvariant()

    if ($actualHash -eq $expectedHash) {
        Write-Output "OK       $relPath"
        $okCount++
    } else {
        Write-Output "MISMATCH $relPath (expected $expectedHash, got $actualHash)"
        $mismatchCount++
    }
}

Write-Output ''
Write-Output "Summary: $okCount OK, $mismatchCount MISMATCH, $missingCount MISSING, $unsafeCount UNSAFE, $skipCount SKIP (of $($artifact.files.Count) files)"

if ($mismatchCount -eq 0 -and $missingCount -eq 0 -and $unsafeCount -eq 0) {
    exit 0
} else {
    exit 2
}
