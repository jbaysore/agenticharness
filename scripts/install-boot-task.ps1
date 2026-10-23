param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$NodePath,
  [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgenticHarness'),
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$DataDir = [IO.Path]::GetFullPath($DataDir)
$taskName = 'Agentic Harness'
$serviceScript = Join-Path $Root 'scripts\service-start.ps1'
foreach ($file in @($serviceScript, (Join-Path $Root 'scripts\launch.mjs'), (Join-Path $Root 'dist\index.html'))) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required Harness file is missing: $file. Build or extract the complete app first." }
}
if (-not $NodePath) {
  $NodePath = Join-Path $Root 'bin\node.exe'
  if (-not (Test-Path -LiteralPath $NodePath)) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
}
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run the boot-task installer from PowerShell opened with Run as Administrator.' }

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing) {
  $backup = Join-Path $DataDir ('boot-task-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.xml')
  Export-ScheduledTask -TaskName $taskName -TaskPath '\' | Set-Content -LiteralPath $backup -Encoding UTF8
}
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument (
  '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $serviceScript +
  '" -Root "' + $Root + '" -NodePath "' + $NodePath + '" -DataDir "' + $DataDir + '"'
) -WorkingDirectory $Root
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = 'PT30S'
$logon = New-ScheduledTaskTrigger -AtLogOn -User $userId
$logon.Delay = 'PT15S'
# Match the other project boot tasks: same Windows user, no stored password.
# Only the supervisor runs in session 0; launch.mjs starts the host on the desktop.
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger @($boot, $logon) -Principal $principal -Settings $settings -Description 'Starts Harness in the background after boot; waits for the signed-in desktop required by coding agents and retries if the host exits.' -Force | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $taskName -TaskPath '\' }
Write-Output "Registered '$taskName' for boot and sign-in using $Root."
