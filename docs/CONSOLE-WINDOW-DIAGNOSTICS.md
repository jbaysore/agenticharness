# Capture flashing console windows on Windows

Run this from a Harness checkout in an ordinary signed-in Windows PowerShell session:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\trace-console-windows.ps1
```

This starts a separate hidden, passive logger for 24 hours. It continues after the chat or launching terminal ends. It does not change app settings, launch agents, install a startup task, move focus, or stop other processes. Use `-DurationSeconds 3600` for a shorter capture.

The command reports its process ID and run directory under `%LOCALAPPDATA%\AgenticHarness\diagnostics\console-window-trace`. Each run has `events.jsonl`, `status.json` and `errors.log`. Window events include UTC time, title, visibility, focus, executable and cached parent ancestry. The logger also watches title changes and maintains a short process history to identify children whose parents exit quickly. Git activity is summarized every 30 seconds instead of writing every repository check separately.

Logs stay local. They include window titles and launch commands; common credential arguments and encoded PowerShell commands are masked. Each run rotates its event log at 8 MiB with three backups (approximately 32 MiB total). Review logs before sharing them.

Check or stop the active capture from any checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\trace-console-windows.ps1 -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\trace-console-windows.ps1 -Action Stop
```

Stop signals only this logger and leaves its records intact. It also stops automatically after its duration and does not start again after sign-out or reboot. For diagnosis, note the approximate time when a window flashes, then inspect nearby `window` events and their `ancestry`. A `process-summary` alone proves process activity, not that a visible window appeared. An inaccessible or already-exited process can have incomplete metadata; session 0 processes cannot account for a window on the signed-in desktop.
