import { mkdir, copyFile, cp, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
const exec = promisify(execFile),
  root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const name = `Agentic-Harness-${pkg.version}-windows-x64`,
  stage = join(root, "release", name);
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Build the Windows x64 package on Windows x64.");
await exec(process.execPath, [join(root, "scripts", "build.mjs")], {
  cwd: root,
  windowsHide: true,
});
await mkdir(join(stage, "bin"), { recursive: true });
for (const path of ["src", "dist", "docs", "scripts"])
  await cp(join(root, path), join(stage, path), { recursive: true });
for (const path of [
  "package.json",
  "package-lock.json",
  "Launch Harness.vbs",
  "Install Harness.vbs",
  "Stop Harness.vbs",
  "README.md",
  "AGENTS.md",
])
  await copyFile(join(root, path), join(stage, path));
await copyFile(process.execPath, join(stage, "bin", "node.exe"));
const license = await fetch(
  `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
);
if (!license.ok)
  throw new Error("Could not fetch the license for the bundled Node runtime");
await writeFile(join(stage, "bin", "NODE-LICENSE.txt"), await license.text());
const npmCli = join(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
await exec(
  process.execPath,
  [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"],
  { cwd: stage, windowsHide: true, maxBuffer: 1024 * 1024 },
);
await writeFile(
  join(stage, "BUILD.json"),
  JSON.stringify(
    {
      version: pkg.version,
      node: process.version,
      arch: process.arch,
      commit: (
        await exec("git", ["rev-parse", "HEAD"], {
          cwd: root,
          windowsHide: true,
        })
      ).stdout.trim(),
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
const zip = join(root, "release", name + ".zip");
// No source-path deletion: Compress-Archive replaces only this named release zip.
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
await exec(
  "powershell.exe",
  [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `Compress-Archive -LiteralPath ${quote(stage)} -DestinationPath ${quote(zip)} -CompressionLevel Fastest -Force`,
  ],
  { windowsHide: true, maxBuffer: 1024 * 1024 },
);
console.log(zip);
const hash = createHash("sha256");
for await (const chunk of createReadStream(zip)) hash.update(chunk);
await writeFile(zip + ".sha256", hash.digest("hex") + "  " + name + ".zip\n");
