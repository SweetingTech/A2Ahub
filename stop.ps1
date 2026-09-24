$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath($PSScriptRoot)
$port = if ($env:PORT) { [int]$env:PORT } else { 4317 }
$listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listener) { Write-Host "A2Ahub is not listening on port $port."; exit 0 }
foreach ($owner in ($listener.OwningProcess | Select-Object -Unique)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
    if ($process.Name -eq 'node.exe' -and $process.CommandLine.Contains((Join-Path $projectPath 'server\index.js'))) {
        Stop-Process -Id $owner
        Write-Host "Stopped A2Ahub on port $port."
    } else {
        Write-Host "Port $port belongs to a process not identifiable as this project. Stop it in its terminal with Ctrl+C."
    }
}
