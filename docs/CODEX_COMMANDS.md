# Codex command startup on Windows

The delivery PC's repeated `timed out after 15000ms connecting runner pipe-in`
failures were reproduced on 2026-10-21 with Codex CLI 0.163.0-alpha.11. Harness
had inherited Windows service session 0 from its automation launcher. The legacy
sandbox helper never connected; MXC could run `cmd.exe` and ripgrep, but
PowerShell, Node, and other USER32-dependent programs exited with `0xC0000142`.
The same commands and binaries succeeded in the signed-in user's session,
under both the legacy sandbox and MXC.

The launcher now hands off a new service-session host to the same user's
interactive Windows token using a temporary hidden Task Scheduler action.
The task uses limited privileges, requires no password, has no trigger, and is
removed after startup. Existing healthy hosts are reused. A missing signed-in
session or a failed handoff is reported instead of silently starting a broken
service-session host. `--supervise` continues monitoring the resulting host.

On Windows, Harness's Codex app-server turns MXC off and selects the elevated
sandbox (`features.prefer_mxc=false`, `windows.sandbox="elevated"`). MXC runs
each sandboxed command on the interactive desktop, so its console takes focus.
Elevated commands run on a private desktop and stay off that screen. Permission
modes, managed restrictions, approval routing, and subscription billing
boundaries are preserved. The user's sandbox accounts and filesystem ACLs are
not rewritten. The unelevated sandbox is not selected, and the private desktop
stays on.

Provider command environments append the installed Codex desktop app's bundled
ripgrep directory to PATH. Existing PATH entries retain priority. Discovery
supports both readable WindowsApps installations and normal desktop accounts
that need `Get-AppxPackage` to locate their registered package. CLI-only
installations retain their existing PATH.

Run `npm run test:codex-commands` to check the installed runtime without starting
a model turn or using inference. It uses the same desktop handoff when invoked
from session 0, then checks PowerShell startup, Node stdout/stderr and exit codes,
ripgrep discovery, live output, workspace writes, and rejection of writes outside
the test workspace. The report is `.local/codex-command-acceptance.json`.

The source repair takes effect when the host restarts. Wait for every active chat
to finish before restarting; the local shutdown capability interrupts active work.
