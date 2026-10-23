param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$NodePath = (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  [string]$DataDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgenticHarness'),
  [ValidateRange(1, 3600)][int]$RetrySeconds = 30
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$launcher = Join-Path $Root 'scripts\launch.mjs'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node runtime is missing: $NodePath" }
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Harness launcher is missing: $launcher" }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
Set-Location -LiteralPath $Root
$env:HARNESS_DATA_DIR = $DataDir
# A startup task must not inherit a previous self-restart request.
$env:HARNESS_RESTART_REQUEST = ''
$log = Join-Path $DataDir 'startup.log'
function Write-StartupLog([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format o), $Message
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Output $line
}

Write-StartupLog 'Starting Harness background supervisor; agents require a signed-in Windows desktop.'
while ($true) {
  # The existing launcher reuses a healthy host, hands off from session 0 to
  # this user's desktop, and follows a safe self-restart without duplicating it.
  # Before sign-in that handoff fails; keep retrying for as long as necessary.
  $ErrorActionPreference = 'Continue'
  try {
    & $NodePath $launcher --supervise 2>&1 | ForEach-Object { Write-StartupLog ([string]$_) }
    $launcherExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = 'Stop'
  }
  Write-StartupLog "Harness launcher exited ($launcherExit); retrying in $RetrySeconds seconds."
  Start-Sleep -Seconds $RetrySeconds
}
