import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    hostname: { type: "string" },
    team: { type: "string" },
    audience: { type: "string" },
    email: { type: "string" },
  },
});
for (const name of ["hostname", "team", "audience", "email"])
  if (!values[name])
    throw new Error(
      "Usage: node scripts/remote-setup.mjs --hostname <harness.example.com> --team <Zero Trust team name> --audience <Access application AUD tag> --email <owner sign-in email>",
    );
const hostname = values.hostname.toLowerCase(),
  teamDomain = values.team.includes(".")
    ? values.team.toLowerCase()
    : values.team.toLowerCase() + ".cloudflareaccess.com",
  origin = "https://" + hostname,
  target = "http://127.0.0.1:47831",
  tunnelName = "agentic-harness";
const dataDir =
  process.env.HARNESS_DATA_DIR ??
  join(process.env.LOCALAPPDATA, "AgenticHarness");
const exe = [
  join(
    process.env["ProgramFiles(x86)"] ?? "",
    "cloudflared",
    "cloudflared.exe",
  ),
  join(process.env.ProgramFiles ?? "", "cloudflared", "cloudflared.exe"),
].find((p) => existsSync(p));
if (!exe)
  throw new Error(
    "Install cloudflared first: winget install Cloudflare.cloudflared",
  );
const home = join(homedir(), ".cloudflared");
if (!existsSync(join(home, "cert.pem")))
  throw new Error(
    `Authorize this PC for the domain first: "${exe}" tunnel login`,
  );
const run = async (args) =>
  (await exec(exe, args, { windowsHide: true, timeout: 60000 })).stdout;
// The host rejects every remote request without a valid Access token, so check the keys are reachable.
const keys = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
  signal: AbortSignal.timeout(10000),
});
if (!keys.ok || !(await keys.json()).keys?.length)
  throw new Error(`No Cloudflare Access team was found at ${teamDomain}.`);
const find = async () =>
  JSON.parse(
    await run(["tunnel", "list", "--output", "json", "--name", tunnelName]),
  )?.[0];
let tunnel = await find();
if (!tunnel) {
  await run(["tunnel", "create", tunnelName]);
  tunnel = await find();
}
const credentials = join(home, tunnel.id + ".json");
if (!existsSync(credentials))
  throw new Error(
    `Tunnel ${tunnelName} exists but its credentials are not on this PC. Delete it in Cloudflare and run setup again.`,
  );
// Without --overwrite-dns this fails rather than replacing a record that points elsewhere.
await run(["tunnel", "route", "dns", tunnelName, hostname]);
await mkdir(dataDir, { recursive: true });
const tunnelConfig = join(dataDir, "cloudflared.yml");
await writeFile(
  tunnelConfig,
  [
    "tunnel: " + tunnel.id,
    "credentials-file: " + JSON.stringify(credentials),
    "ingress:",
    "  - hostname: " + hostname,
    "    service: " + target,
    "  - service: http_status:404",
    "",
  ].join("\n"),
);
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
        .update(values.email.toLowerCase())
        .digest("hex"),
      access: { teamDomain, audience: values.audience },
      tunnel: { exe, config: tunnelConfig },
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    origin,
    accessTeam: teamDomain,
    ownerOnly: true,
    hostRestartRequired: true,
  }),
);
