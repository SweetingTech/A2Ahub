# Start only this checkout of A2Ahub as a native Windows background process.
[CmdletBinding()]
param([string]$LogDirectory)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$entry = Join-Path $repoRoot 'server\index.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "Missing entry point: $entry. Keep this launcher inside deployment\windows."
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container)) {
    throw "Dependencies are missing. Run npm ci in $repoRoot first."
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\index.html') -PathType Leaf)) {
    throw "Frontend build is missing. Run npm run build in $repoRoot first."
}
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $checkoutId = [BitConverter]::ToString($hasher.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($repoRoot.ToLowerInvariant())
    )).Replace('-', '').Substring(0, 16)
} finally { $hasher.Dispose() }
if (-not $LogDirectory) {
    $LogDirectory = Join-Path $env:LOCALAPPDATA "A2Ahub\launcher\$checkoutId"
}
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$mutex = New-Object System.Threading.Mutex($false, "Local\A2Ahub-Launcher-$checkoutId")
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { Write-Output 'Another A2Ahub launcher is active.'; return }
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    if ($running.Count) {
        Write-Output "A2Ahub already has a process for this checkout (PID $($running.ProcessId -join ', '))."
        return
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $LogDirectory "$stamp.stdout.log"
    $stderr = Join-Path $LogDirectory "$stamp.stderr.log"
    $process = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') `
        -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr -PassThru
    Start-Sleep -Seconds 2
    $process.Refresh()
    if ($process.HasExited) { throw "A2Ahub exited during startup. See $stderr" }
    Write-Output "Started A2Ahub (PID $($process.Id)). Logs: $LogDirectory"
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
