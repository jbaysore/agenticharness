import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

// A process id is not an identity. The operating-system creation time changes
// when that id is reused, so a later kill can require both.
export function identitiesMatch(recorded, live) {
  if (!recorded || !live) return false;
  const pid = Number(recorded.pid);
  if (!Number.isInteger(pid) || pid <= 0 || Number(live.pid) !== pid)
    return false;
  const left = Date.parse(recorded.createdAt);
  const right = Date.parse(live.createdAt);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.floor(left / 1000) === Math.floor(right / 1000);
}

export async function processIdentity(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${id}'; if (-not $p) { exit 2 }; $p.CreationDate.ToUniversalTime().ToString('o')`,
        ],
        { windowsHide: true, timeout: 15_000 },
      );
      const createdAt = stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .at(-1);
      if (!Number.isFinite(Date.parse(createdAt))) return null;
      return { pid: id, createdAt };
    }
    const stat = await readFile(`/proc/${id}/stat`, "utf8");
    const uptime = Number(
      (await readFile("/proc/uptime", "utf8")).split(" ")[0],
    );
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    if (!Number.isFinite(uptime) || !Number.isFinite(ticks)) return null;
    const createdAt = new Date(
      Date.now() - uptime * 1000 + (ticks / 100) * 1000,
    ).toISOString();
    return { pid: id, createdAt };
  } catch {
    return null;
  }
}

export async function killProcessTree(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid process id.");
  if (process.platform === "win32") {
    await exec("taskkill", ["/pid", String(id), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-id, "SIGKILL");
  } catch {
    process.kill(id, "SIGKILL");
  }
}

export async function killIfMatched(
  recorded,
  { identity = processIdentity, kill = killProcessTree } = {},
) {
  let live = null;
  try {
    live = await identity(recorded?.pid);
  } catch {
    return { killed: false, failed: true };
  }
  if (!identitiesMatch(recorded, live)) return { killed: false };
  try {
    await kill(recorded.pid);
    return { killed: true };
  } catch {
    return { killed: false, failed: true };
  }
}
