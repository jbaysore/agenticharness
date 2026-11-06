import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandLaunch, captureOutput } from "./commands.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";

const dir = process.argv[2];
const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
const launch = commandLaunch(request.shell, request.command);
const output = captureOutput(200_000);
const child = spawn(launch.command, launch.args, {
  cwd: request.cwd,
  env: subscriptionEnvironment(),
  windowsHide: true,
  ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
});
child.stdout?.setEncoding("utf8");
child.stderr?.setEncoding("utf8");
child.stdout?.on("data", (chunk) => output.push(chunk));
child.stderr?.on("data", (chunk) => output.push(chunk));
const beat = setInterval(() => {
  try {
    writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ at: Date.now() }));
  } catch {}
}, 2000);
beat.unref?.();
const finish = (exitCode, error) => {
  clearInterval(beat);
  try {
    writeFileSync(join(dir, "output.txt"), error ? `${output.text()}${error}` : output.text());
    const temporary = join(dir, "result.json.tmp");
    writeFileSync(
      temporary,
      JSON.stringify({ exitCode: exitCode ?? 1, truncated: output.truncated }),
    );
    renameSync(temporary, join(dir, "result.json"));
  } catch {}
  process.exit(0);
};
child.on("error", (error) => finish(1, error.message));
child.on("close", (code) => finish(code ?? 1));
