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

## Hidden background launches

The scheduled desktop handoff uses `wscript.exe` and `scripts/run-in-user-session.vbs` to create PowerShell hidden before a console can be allocated. PowerShell creates its Node child with `UseShellExecute=false` and `CreateNoWindow=true`, drains both output streams concurrently, and bounds startup to 25 seconds. Its existing JSON response and same-user interactive session are preserved. Task Scheduler's `Hidden` setting alone does not hide an executable's windows.

Terminal cleanup keeps node-pty's existing descendant termination behavior, with a compatibility patch adding `windowsHide:true` to its console-list helper fork. node-pty is pinned to 1.1.0. `npm ci` applies the patch; the build verifies it without rewriting dependencies. An unexpected dependency version or helper change fails explicitly so it can be reviewed. Install dependencies locally before building an older checkout; do not patch another worktree's shared dependency junction.

Run `npm run test:hidden-consoles` on Windows with a signed-in desktop to exercise five actual scheduled desktop launch actions plus PowerShell/Command Prompt commands, terminal closure, unused-terminal removal, descendant termination and host shutdown. The check starts its own isolated desktop trace, uses temporary interactive tasks and a detached provider-free fixture host, then stops the trace and removes its tasks. It exercises the desktop side of the handoff; creating a new service-session S4U task requires administrator rights and is not part of this check. Reports and logs remain under `.local/hidden-console-*`. A displayed console or foreground console event fails the check; a nonforeground pseudoconsole bookkeeping window alone does not. `--source-root <isolated checkout>` can compare an unmodified baseline; all baseline dependencies must also live in that isolated checkout. No inference is used.
