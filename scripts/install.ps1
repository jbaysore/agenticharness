param([switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$harnessSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$harnessVersion = (Get-Content -LiteralPath (Join-Path $harnessSource 'package.json') -Raw | ConvertFrom-Json).version
$harnessDestination = Join-Path $env:LOCALAPPDATA "Programs\AgenticHarness\$harnessVersion"
if (-not (Test-Path -LiteralPath (Join-Path $harnessSource 'bin\node.exe'))) { throw 'Install from the complete Windows release package.' }
New-Item -ItemType Directory -Path $harnessDestination -Force | Out-Null
if ($harnessSource -ne [IO.Path]::GetFullPath($harnessDestination)) {
  Get-ChildItem -LiteralPath $harnessSource -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $harnessDestination -Recurse -Force }
}
& (Join-Path $harnessDestination 'scripts\taskbar-shortcut.ps1') -Root $harnessDestination | Out-Null
if (-not $NoLaunch) { Start-Process -FilePath $harnessShortcut.TargetPath -ArgumentList $harnessShortcut.Arguments -WindowStyle Hidden }
Write-Output ('Installed Agentic Harness ' + $harnessVersion)
