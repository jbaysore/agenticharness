param(
  [ValidateSet('Start', 'Watch', 'Status', 'Stop')]
  [string]$Action = 'Start',
  [ValidateRange(2, 604800)]
  [int]$DurationSeconds = 86400,
  [string]$DataDirectory,
  [string]$RunDirectory
)

# Opt-in desktop diagnostics. No app settings, scheduled tasks or startup entries
# are changed. Watch runs in a separate hidden process and stops after one day.
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This diagnostic runs on Windows.' }
if (-not $DataDirectory) {
  $DataDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgenticHarness\diagnostics\console-window-trace'
}
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
$activeFile = Join-Path $DataDirectory 'active.json'

function Read-TraceStatus {
  if (-not (Test-Path -LiteralPath $activeFile)) { return $null }
  $active = Get-Content -Raw -LiteralPath $activeFile | ConvertFrom-Json
  $statusFile = Join-Path $active.runDirectory 'status.json'
  $status = if (Test-Path -LiteralPath $statusFile) {
    Get-Content -Raw -LiteralPath $statusFile | ConvertFrom-Json
  } else { $null }
  $process = Get-Process -Id $active.processId -ErrorAction SilentlyContinue
  $sameProcess = $process -and ([Math]::Abs(($process.StartTime.ToUniversalTime() - [DateTime]::Parse($active.processStartedUtc).ToUniversalTime()).TotalSeconds) -lt 2)
  [pscustomobject]@{
    running = [bool]($sameProcess -and (-not $status -or $status.state -eq 'running'))
    processId = $active.processId
    runDirectory = $active.runDirectory
    status = $status
  }
}

if ($Action -eq 'Status') {
  $status = Read-TraceStatus
  if ($status) { $status | ConvertTo-Json -Depth 5 }
  else { [pscustomobject]@{ running = $false; message = 'No logger has been started.' } | ConvertTo-Json }
  exit
}

if ($Action -eq 'Stop') {
  $status = Read-TraceStatus
  if ($status -and $status.running) {
    [IO.File]::WriteAllText((Join-Path $status.runDirectory 'stop.request'), [DateTime]::UtcNow.ToString('o'))
    $process = Get-Process -Id $status.processId -ErrorAction SilentlyContinue
    if ($process) { [void]$process.WaitForExit(5000) }
  }
  $status = Read-TraceStatus
  if ($status) { $status | ConvertTo-Json -Depth 5 }
  else { [pscustomobject]@{ running = $false } | ConvertTo-Json }
  exit
}

if ($Action -eq 'Start') {
  $existing = Read-TraceStatus
  if ($existing -and $existing.running) {
    $existing | ConvertTo-Json -Depth 5
    exit
  }
  [void][IO.Directory]::CreateDirectory($DataDirectory)
  $RunDirectory = Join-Path $DataDirectory ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  [void][IO.Directory]::CreateDirectory($RunDirectory)
  $arguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $PSCommandPath), '-Action', 'Watch',
    '-DataDirectory', ('"{0}"' -f $DataDirectory),
    '-RunDirectory', ('"{0}"' -f $RunDirectory),
    '-DurationSeconds', [string]$DurationSeconds
  )
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $child = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $RunDirectory 'output.log') `
    -RedirectStandardError (Join-Path $RunDirectory 'errors.log')
  [IO.File]::WriteAllText($activeFile, ([pscustomobject]@{
    processId = $child.Id
    processStartedUtc = $child.StartTime.ToUniversalTime().ToString('o')
    runDirectory = $RunDirectory
  } | ConvertTo-Json))
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while ([DateTime]::UtcNow -lt $deadline -and -not $child.HasExited -and -not (Test-Path -LiteralPath (Join-Path $RunDirectory 'status.json'))) {
    Start-Sleep -Milliseconds 100
    $child.Refresh()
  }
  $status = Read-TraceStatus
  if (-not $status.running -or -not $status.status) {
    $details = Get-Content -Raw -LiteralPath (Join-Path $RunDirectory 'errors.log') -ErrorAction SilentlyContinue
    throw "The logger did not start. $details"
  }
  $status | ConvertTo-Json -Depth 5
  exit
}

# Only the child process enters Watch. Keep its files within this logger's own
# run directory. Stop uses a sentinel, never a potentially reused process ID.
$RunDirectory = [IO.Path]::GetFullPath($RunDirectory)
if (-not $RunDirectory.StartsWith($DataDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The run directory must be inside the diagnostic data directory.'
}
$mutex = New-Object Threading.Mutex($false, 'Local\AgenticHarness.ConsoleWindowTrace')
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { throw 'A console-window logger is already running.' }
  Add-Type -Path (Join-Path $PSScriptRoot 'console-window-trace.cs') -ReferencedAssemblies System.Web.Extensions, System.Core
  [Harness.Diagnostics.ConsoleWindowTrace]::Run($RunDirectory, $DurationSeconds)
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
