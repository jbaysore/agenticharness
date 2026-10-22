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
  $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
  try {
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($session -eq 0) { throw 'Task Scheduler did not provide a signed-in Windows session.' }
    foreach ($entry in $request.environment.PSObject.Properties) {
      [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
    }
    Set-Location -LiteralPath $request.workingDirectory
    # Native stderr (including Node warnings) must not interrupt result capture.
    $ErrorActionPreference = 'Continue'
    $output = & $request.nodePath $request.scriptPath --no-browser 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    $result = @{ ok = ($code -eq 0); handedOff = $true; sessionId = $session }
    if ($code -ne 0) { $result.error = "Desktop launcher exited ($code): $output" }
  } catch {
    $result = @{ ok = $false; handedOff = $true; error = $_.Exception.Message }
  }
  $result | ConvertTo-Json -Compress | Set-Content -LiteralPath $request.responseFile -Encoding UTF8
  exit
}

if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) {
  @{ ok = $true; handedOff = $false } | ConvertTo-Json -Compress
  exit
}

$taskName = 'AgenticHarness-DesktopLaunch-' + [guid]::NewGuid().ToString('N')
$requestPath = Join-Path $DataDir ($taskName + '.request.json')
$responsePath = Join-Path $DataDir ($taskName + '.response.json')
try {
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
  $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument (
    '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $PSCommandPath + '" -RequestFile "' + $requestPath + '"'
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
} catch {
  @{ ok = $false; handedOff = $true; error = $_.Exception.Message } | ConvertTo-Json -Compress
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $requestPath,$responsePath -Force -ErrorAction SilentlyContinue
}
