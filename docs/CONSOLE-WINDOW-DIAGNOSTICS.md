# Capture flashing console windows on Windows

Run this from a Harness checkout in an ordinary signed-in Windows PowerShell session:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\trace-console-windows.ps1
```

This starts a separate hidden, passive logger for 24 hours. It continues after the chat or launching terminal ends. It does not change app settings, launch agents, install a startup task, move focus, or stop other processes. Use `-DurationSeconds 3600` for a shorter capture.

The command reports its process ID and run directory under `%LOCALAPPDATA%\AgenticHarness\diagnostics\console-window-trace`. Each run has `events.jsonl`, `status.json` and `errors.log`. Window events include UTC time, visibility, focus, executable and cached parent ancestry. WinEvent hooks catch brief appearances; 50 ms process snapshots retain parents that exit quickly. Git activity is summarized every 30 seconds instead of writing every repository check separately.

Each new `powershell.exe` or `pwsh.exe` gets a `powershell-start` event with its ancestry, launch mode, script filename for `-File`, window-style option, and SHA-256 command fingerprint. Encoded PowerShell payloads are decoded only in memory to compute the fingerprint and recognize Harness foreground commands, process-parent scans, and Codex package discovery. The decoded script is never stored by default. Known Harness host/launcher and Codex app-server parents are labeled. This covers PowerShell started by Harness, providers, scheduled tasks, and other applications on the desktop.

Logs stay local. Raw command lines and window titles are omitted by default; title fingerprints still detect title changes. `-CaptureCommandLines` explicitly enables the older masked command/title capture for a new run. Common credential arguments and encoded PowerShell commands are masked in that mode, but arbitrary script text may still be sensitive. Each run rotates its event log at 8 MiB with three backups (approximately 32 MiB total).

Check or stop the active capture from any checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\trace-console-windows.ps1 -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\trace-console-windows.ps1 -Action Report
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\trace-console-windows.ps1 -Action Stop
```

`Report` reads all rotated event files and returns counts plus the latest 50 visible console events and PowerShell starts. It emits only selected metadata, even when reading an older capture containing raw commands. `Status` requires a matching process identity, a recent heartbeat, and an unexpired capture; an abandoned status file does not mean logging is still running.

Stop signals only this logger and leaves its records intact. It also stops automatically after its duration and does not start again after sign-out or reboot. For diagnosis, inspect nearby visible/foreground `window` events and their `ancestry`. A `powershell-start` or `process-summary` alone proves process activity, not that a visible window appeared. A terminal host may own the window instead of PowerShell; `recentPowerShell` includes recent shell ancestry as timing candidates, not confirmed owners. An inaccessible or already-exited process can have incomplete metadata; session 0 processes cannot account for a window on the signed-in desktop.

Run outside the provider sandbox on the signed-in desktop. Check the `started` event for `station: WinSta0` and `desktop: Default`; sandboxed process enumeration can omit important ancestors. Use `-DataDirectory` for an isolated diagnostic/test directory, with matching options on Start, Status, Report, and Stop. Captures in separate data directories have separate mutexes.

The logger collects files after a chat ends, but it does not alert an agent or resume a chat. Reading a later popup requires a new user message. No model turn or inference is used by the logger.
