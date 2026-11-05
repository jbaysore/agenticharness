param(
  [ValidateSet('Start', 'Watch', 'Status', 'Stop', 'Report')]
  [string]$Action = 'Start',
  [ValidateRange(2, 604800)]
  [int]$DurationSeconds = 86400,
  [string]$DataDirectory,
  [string]$RunDirectory,
  [switch]$CaptureCommandLines
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
  $sameProcess = $false
  $fresh = $false
  try {
    if ($process -and $process.StartTime) {
      $sameProcess = [Math]::Abs(($process.StartTime.ToUniversalTime() - [DateTime]::Parse($active.processStartedUtc).ToUniversalTime()).TotalSeconds) -lt 2
    }
    if ($status) {
      $fresh = $status.state -eq 'running' -and
        ([DateTime]::UtcNow - [DateTime]::Parse($status.heartbeatUtc).ToUniversalTime()).TotalSeconds -lt 20 -and
        [DateTime]::Parse($status.expiresUtc).ToUniversalTime() -gt [DateTime]::UtcNow
    }
  } catch {
    # A reused/protected PID or malformed old status must not look healthy.
  }
  [pscustomobject]@{
    running = [bool]($sameProcess -and $fresh)
    processMatches = [bool]$sameProcess
    processId = $active.processId
    runDirectory = $active.runDirectory
    status = $status
  }
}

if ($Action -eq 'Report') {
  if (-not $RunDirectory) {
    $active = Read-TraceStatus
    if (-not $active) { throw 'No capture exists. Start a capture first.' }
    $RunDirectory = $active.runDirectory
  }
  $captureRoot = [IO.Path]::GetFullPath($RunDirectory)
  if (-not $captureRoot.StartsWith($DataDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The run directory must be inside the diagnostic data directory.'
  }
  $visible = New-Object Collections.Generic.List[object]
  $shells = New-Object Collections.Generic.List[object]
  Get-ChildItem -LiteralPath $captureRoot -Filter 'events*.jsonl' | Sort-Object LastWriteTime | ForEach-Object {
    Get-Content -LiteralPath $_.FullName | ForEach-Object {
      try { $entry = $_ | ConvertFrom-Json } catch { return }
      if ($entry.type -eq 'powershell-start') {
        $shells.Add([pscustomobject]@{ utc=$entry.utc; processId=$entry.process.id; parent=$entry.process.parent; session=$entry.process.session; details=$entry.process.powerShell })
      }
      if ($entry.type -eq 'window' -and $entry.window.console -and ($entry.window.visible -or $entry.window.foreground)) {
        # Report only allowlisted metadata, including for older/raw captures.
        $ancestry = @($entry.window.ancestry | Select-Object id,parent,session,name,role,createdUtc,powerShell)
        $candidates = @($entry.recentPowerShell | ForEach-Object {
          [pscustomobject]@{ processId=$_.process.id; details=$_.process.powerShell; ancestry=@($_.ancestry | Select-Object id,parent,session,name,role,createdUtc,powerShell) }
        })
        $visible.Add([pscustomobject]@{ utc=$entry.utc; kind=$entry.kind; handle=$entry.window.handle; className=$entry.window.className; titleKind=$entry.window.titleKind; visible=$entry.window.visible; foreground=$entry.window.foreground; ancestry=$ancestry; recentPowerShellCandidates=$candidates })
      }
    }
  }
  [pscustomobject]@{ runDirectory=$captureRoot; visibleConsoleEvents=$visible.Count; powerShellStarts=$shells.Count; visible=@($visible | Select-Object -Last 50); recentPowerShellStarts=@($shells | Select-Object -Last 50) } | ConvertTo-Json -Depth 12
  exit
}

if ($Action -eq 'Status') {
  $status = Read-TraceStatus
  if ($status) { $status | ConvertTo-Json -Depth 5 }
  else { [pscustomobject]@{ running = $false; message = 'No logger has been started.' } | ConvertTo-Json }
  exit
}

if ($Action -eq 'Stop') {
  $status = Read-TraceStatus
  if ($status -and $status.processMatches) {
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
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $PSCommandPath), '-Action', 'Watch',
    '-DataDirectory', ('"{0}"' -f $DataDirectory),
    '-RunDirectory', ('"{0}"' -f $RunDirectory),
    '-DurationSeconds', [string]$DurationSeconds
  )
  if ($CaptureCommandLines) { $arguments += '-CaptureCommandLines' }
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
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $directoryHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($DataDirectory.TrimEnd('\').ToUpperInvariant()))).Replace('-', '') }
finally { $hashAlgorithm.Dispose() }
$mutex = New-Object Threading.Mutex($false, ('Local\AgenticHarness.ConsoleWindowTrace.' + $directoryHash))
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { throw 'A console-window logger is already running.' }
  Add-Type -Path (Join-Path $PSScriptRoot 'console-window-trace.cs') -ReferencedAssemblies System.Web.Extensions, System.Core
  [Harness.Diagnostics.ConsoleWindowTrace]::Run($RunDirectory, $DurationSeconds, [bool]$CaptureCommandLines)
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
