import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile),
  exe = join(process.env.ProgramFiles, "Tailscale", "tailscale.exe");
const dataDir =
  process.env.HARNESS_DATA_DIR ??
  join(process.env.LOCALAPPDATA, "AgenticHarness");
const run = async (args) =>
  (await exec(exe, args, { windowsHide: true, timeout: 30000 })).stdout;
const status = JSON.parse(await run(["status", "--json"]));
if (status.BackendState !== "Running")
  throw new Error("Open Tailscale and sign in before enabling remote access.");
const dns = status.Self.DNSName.replace(/\.$/, ""),
  login = status.User?.[status.Self.UserID]?.LoginName;
if (!login || !status.CertDomains?.includes(dns))
  throw new Error(
    "The signed-in owner and Tailscale HTTPS support must be available.",
  );
const port = 9443,
  authority = dns + ":" + port,
  origin = "https://" + authority,
  target = "http://127.0.0.1:47831";
const before = JSON.parse(await run(["serve", "status", "--json"]));
const handlers = before.Web?.[authority]?.Handlers;
if (
  before.AllowFunnel?.[authority] ||
  (handlers && Object.values(handlers).some((h) => h.Proxy !== target)) ||
  (before.TCP?.[port] && !handlers)
)
  throw new Error(
    "HTTPS port 9443 belongs to another service; choose a free port without replacing it.",
  );
await mkdir(dataDir, { recursive: true });
await writeFile(
  join(dataDir, "remote-before.json"),
  JSON.stringify(before, null, 2),
);
await run(["serve", "--bg", "--https=" + port, target]);
const after = JSON.parse(await run(["serve", "status", "--json"]));
if (
  after.AllowFunnel?.[authority] ||
  after.Web?.[authority]?.Handlers?.["/"]?.Proxy !== target
)
  throw new Error("Private HTTPS proxy validation failed.");
let config = {};
try {
  config = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await writeFile(
  join(dataDir, "config.json"),
  JSON.stringify(
    {
      ...config,
      publicOrigin: origin,
      remoteIdentityHash: createHash("sha256")
        .update(login.toLowerCase())
        .digest("hex"),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    origin,
    private: true,
    publicFunnel: false,
    ownerOnly: true,
    hostRestartRequired: true,
  }),
);
