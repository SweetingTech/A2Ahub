# Starts both local apps at Windows sign-in. Safe to run again.
$ErrorActionPreference = 'Stop'
$launchDir = Join-Path $env:LOCALAPPDATA 'A2A-RepoManager-Startup'
$logDir = Join-Path $launchDir 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$mutex = New-Object System.Threading.Mutex($false, 'Local\A2ARepoManagerStartup')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }
try {
    $node = 'C:\nvm4w\nodejs\node.exe'
    $env:Path = 'C:\nvm4w\nodejs;C:\Users\BigDSweetz\AppData\Local\pnpm;' + $env:Path
    $env:REPO_MANAGER_OPEN_BROWSER = 'false'
    $apps = @(
        @{ Name = 'A2Ahub'; Root = 'C:\Users\BigDSweetz\Desktop\Projects\A2Ahub'; Entry = 'server\index.js' },
        @{ Name = 'RepoManager'; Root = 'C:\Users\BigDSweetz\Desktop\Projects\Repo-Manager-Gui'; Entry = 'scripts\dev.mjs' }
    )
    foreach ($app in $apps) {
        try {
            $entry = Join-Path $app.Root $app.Entry
            if (-not (Test-Path -LiteralPath $entry)) { throw "Missing entry point: $entry" }
            $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
                $_.CommandLine -and $_.CommandLine.IndexOf($app.Root, [StringComparison]::OrdinalIgnoreCase) -ge 0
            }
            if ($running) {
                Add-Content (Join-Path $logDir 'startup.log') "$(Get-Date -Format o) $($app.Name): already running."
                continue
            }
            $proc = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') -WorkingDirectory $app.Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$($app.Name).stdout.log") -RedirectStandardError (Join-Path $logDir "$($app.Name).stderr.log") -PassThru
            Start-Sleep -Seconds 2
            if ($proc.HasExited) { throw "Exited with code $($proc.ExitCode); see app logs." }
            Add-Content (Join-Path $logDir 'startup.log') "$(Get-Date -Format o) $($app.Name): started PID $($proc.Id)."
        } catch {
            Add-Content (Join-Path $logDir 'startup.log') "$(Get-Date -Format o) $($app.Name): ERROR $_"
        }
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
