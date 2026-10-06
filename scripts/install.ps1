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
$harnessShell = New-Object -ComObject WScript.Shell
$harnessShortcut = $harnessShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agentic Harness.lnk'))
$harnessShortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$harnessShortcut.Arguments = '"' + (Join-Path $harnessDestination 'Launch Harness.vbs') + '"'
$harnessShortcut.WorkingDirectory = $harnessDestination
$harnessShortcut.Description = 'Open your subscription-backed coding workspace'
$harnessShortcut.Save()
if (-not $NoLaunch) { Start-Process -FilePath $harnessShortcut.TargetPath -ArgumentList $harnessShortcut.Arguments -WindowStyle Hidden }
Write-Output ('Installed Agentic Harness ' + $harnessVersion)
