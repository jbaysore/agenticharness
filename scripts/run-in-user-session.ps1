param(
  [string]$NodePath,
  [string]$ScriptPath,
  [string]$WorkingDirectory,
  [string]$DataDir,
  [string]$RequestFile
)
$ErrorActionPreference = 'Stop'

# Use an existing interactive token for the same Windows user. No password,
# elevation, recurring task, or change to the sandbox's permissions is needed.
if ($RequestFile) {
  $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  try {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($session -eq 0) { throw 'Task Scheduler did not provide a signed-in Windows session.' }
    foreach ($entry in $request.environment.PSObject.Properties) {
      [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
    }
    # Invoking Node with & can allocate a Windows Terminal window even when
    # PowerShell itself was hidden. Create the child without a console instead.
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $request.nodePath
    $start.Arguments = '"' + $request.scriptPath + '" --no-browser'
    $start.WorkingDirectory = $request.workingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $child = New-Object Diagnostics.Process
    try {
      $child.StartInfo = $start
      if (-not $child.Start()) { throw 'The desktop launcher did not start.' }
      # Drain both pipes concurrently; either stream can exceed its pipe buffer.
      $stdout = $child.StandardOutput.ReadToEndAsync()
      $stderr = $child.StandardError.ReadToEndAsync()
      if (-not $child.WaitForExit(25000)) {
        $child.Kill()
        $child.WaitForExit()
        throw 'The desktop launcher exceeded its 25-second startup limit.'
      }
      $output = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
      $code = $child.ExitCode
    } finally {
      $child.Dispose()
    }
    $result = @{ ok = ($code -eq 0); handedOff = $true; sessionId = $session }
    if ($code -ne 0) { $result.error = "Desktop launcher exited ($code): $output" }
  } catch {
    $result = @{ ok = $false; handedOff = $true; error = $_.Exception.Message }
  }
  $temporary = $request.responseFile + '.tmp'
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
  [IO.File]::Move($temporary, $request.responseFile)
  exit
}

if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) {
  @{ ok = $true; handedOff = $false } | ConvertTo-Json -Compress
  exit
}

$taskName = 'AgenticHarness-DesktopLaunch-' + [guid]::NewGuid().ToString('N')
$requestPath = Join-Path $DataDir ($taskName + '.request.json')
$responsePath = Join-Path $DataDir ($taskName + '.response.json')
$responseReceived = $false
try {
  $wrapper = Join-Path $PSScriptRoot 'run-in-user-session.vbs'
  if (-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) { throw "Hidden desktop launcher is missing: $wrapper" }
  $environment = @{ HARNESS_DATA_DIR = $DataDir }
  foreach ($entry in Get-ChildItem Env:HARNESS_*) {
    $environment[$entry.Name] = $entry.Value
  }
  $environment.HARNESS_DATA_DIR = $DataDir
  @{
    nodePath = $NodePath
    scriptPath = $ScriptPath
    workingDirectory = $WorkingDirectory
    environment = $environment
    responseFile = $responsePath
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $requestPath -Encoding UTF8
  # Task Scheduler's Hidden flag hides its listing, not a console window.
  # wscript is a GUI executable and creates PowerShell hidden from the outset.
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument (
    '//B //Nologo "' + $wrapper + '" "' + $PSCommandPath + '" "' + $requestPath + '"'
  ) -WorkingDirectory $WorkingDirectory
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath $responsePath)) {
    if ((Get-Date) -gt $deadline) {
      throw 'No desktop launch response. Sign in to Windows as the Harness user, then launch Harness again.'
    }
    Start-Sleep -Milliseconds 100
  }
  Get-Content -LiteralPath $responsePath -Raw
  $responseReceived = $true
} catch {
  @{ ok = $false; handedOff = $true; error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  # Do not stop a successful task's process tree: its detached host is meant
  # to outlive the handoff. Only a failed/timed-out handoff needs cancellation.
  if (-not $responseReceived) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $requestPath,$responsePath,($responsePath + '.tmp') -Force -ErrorAction SilentlyContinue
}
