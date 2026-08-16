<#
.SYNOPSIS
    RDR-016 (model & runtime provenance) box-side hash listing.

.DESCRIPTION
    Recursively SHA256-hashes every file under -Root and emits one line per
    file in the same shape as `shasum -a 256`:

        <sha256 lowercase>  <relative path, forward slashes>

    (two spaces between hash and path). Lines are sorted by relative path.
    This is the box half of the Mac<->box round trip in
    scripts/ops/provenance/provenance.py (`hash-listing` / `import-listing`):
    the box cannot run provenance.py (no python on the box, RDR-016 F4), so it
    produces this listing and the Mac imports it.

    DEPLOYMENT (do not deploy from here — this file is not copied by any
    script in this repo): copy to the box coordination directory alongside
    the existing keepalive coordination files.

        scp "scripts/ops/win/Get-ProvenanceListing.ps1" qwentescence:D:/claude-coordination/Get-ProvenanceListing.ps1
        scp "scripts/ops/win/Test-Provenance.ps1"        qwentescence:D:/claude-coordination/Test-Provenance.ps1
        scp "scripts/ops/win/Get-ProvenanceCheckPath.ps1" qwentescence:D:/claude-coordination/Get-ProvenanceCheckPath.ps1

.PARAMETER Root
    Directory to hash recursively (e.g. D:\models or D:\llama-b10078).

.PARAMETER Out
    Optional path to write the listing to, ASCII-encoded with LF line
    endings (NOT `Out-File`, which defaults to UTF-16 + CRLF on PS 5.1 and
    would silently break the `sha256  relpath` contract the Mac side parses
    byte-for-byte). When omitted, the listing is written to stdout only.

.EXAMPLE
    .\Get-ProvenanceListing.ps1 -Root D:\models -Out D:\claude-coordination\models-listing.txt

.NOTES
    PowerShell 5.1 target (box has no pwsh 7, no python — RDR-016 F4).
    Large files (50-100 GB GGUF shards) are handled by Get-FileHash's own
    streaming FileStream read; this script does not buffer whole files.
    Progress goes to stderr only (Write-Progress / Write-Verbose); stdout is
    reserved for the listing so it can be piped/redirected cleanly.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $false)]
    [string]$Out
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    Write-Error "Root not found or not a directory: $Root"
    exit 1
}

# Resolve to a full path so relative-path math below is stable regardless of
# how -Root was spelled (trailing slash, relative, etc.).
$resolvedRoot = (Resolve-Path -LiteralPath $Root).ProviderPath
# Trim a single trailing separator so substring-based relpath math is exact.
$resolvedRoot = $resolvedRoot.TrimEnd('\', '/')

Write-Verbose "Enumerating files under $resolvedRoot"
$files = Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File -Force

$total = $files.Count
if ($total -eq 0) {
    Write-Warning "No files found under $resolvedRoot"
}

$results = New-Object System.Collections.Generic.List[string]
$i = 0
foreach ($f in $files) {
    $i++
    Write-Progress -Activity 'Hashing files for provenance listing' `
        -Status "$i / $total : $($f.Name)" `
        -PercentComplete $(if ($total -gt 0) { [math]::Floor(($i / $total) * 100) } else { 0 })
    Write-Verbose "Hashing $($f.FullName)"

    # Get-FileHash streams the file; safe for 50-100 GB GGUF shards without
    # loading them into memory.
    $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

    # Relative path, forward slashes — the cross-platform contract with the
    # Mac-side shasum-shaped listing and provenance.py's parser.
    $full = $f.FullName
    if ($full.Length -gt $resolvedRoot.Length -and $full.Substring(0, $resolvedRoot.Length) -eq $resolvedRoot) {
        $rel = $full.Substring($resolvedRoot.Length).TrimStart('\', '/')
    } else {
        $rel = $full
    }
    $rel = $rel -replace '\\', '/'

    $results.Add("$hash  $rel")
}
Write-Progress -Activity 'Hashing files for provenance listing' -Completed

$sorted = $results | Sort-Object

# stdout: always the listing (one line per file), so this script composes
# with a pipeline even when -Out is not given.
$sorted | Write-Output

if ($PSBoundParameters.ContainsKey('Out')) {
    # UTF-8, no BOM, LF — written with WriteAllText — Out-File / Set-Content
    # on PS 5.1 default to UTF-16LE with CRLF and would corrupt the listing
    # contract. Plain ASCII (the original choice here) would silently mangle
    # any non-ASCII filename to '?', corrupting the relpath itself rather
    # than just the encoding — UTF-8 round-trips every filename the box's
    # filesystem can actually hold. `New-Object ... $false` selects the
    # no-BOM constructor overload; a BOM would land as extra bytes before
    # the first hash and break the fixed-width sha256-then-two-spaces parse
    # on both the PS and Python sides.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $body = [string]::Join("`n", $sorted)
    if ($sorted.Count -gt 0) {
        $body += "`n"
    }
    [System.IO.File]::WriteAllText($Out, $body, $utf8NoBom)
    Write-Verbose "Wrote $($sorted.Count) lines to $Out"
}
