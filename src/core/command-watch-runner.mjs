import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandLaunch, captureOutput } from "./commands.mjs";
import { subscriptionEnvironment } from "../security/environment.mjs";

const dir = process.argv[2];
const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
const launch = commandLaunch(request.shell, request.command);
const output = captureOutput(200_000);
let tail = "",
  outputBytes = 0,
  lastOutputAt = null,
  finished = false,
  drain;
const atomic = (name, contents) => {
  const temporary = join(dir, `${name}.tmp`);
  writeFileSync(temporary, contents);
  renameSync(temporary, join(dir, name));
};
const snapshot = () => {
  try {
    atomic(
      "heartbeat.json",
      JSON.stringify({
        at: Date.now(),
        outputBytes,
        lastOutputAt,
        output: tail,
      }),
    );
  } catch {}
};
const child = spawn(launch.command, launch.args, {
  cwd: request.cwd,
  env: subscriptionEnvironment(),
  windowsHide: true,
  ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
});
child.stdout?.setEncoding("utf8");
child.stderr?.setEncoding("utf8");
const take = (chunk) => {
  output.push(chunk);
  outputBytes += Buffer.byteLength(chunk);
  lastOutputAt = Date.now();
  tail = (tail + chunk).slice(-8000);
};
child.stdout?.on("data", take);
child.stderr?.on("data", take);
// Watched commands are noninteractive; do not leave an unread stdin pipe open.
child.stdin?.on("error", () => {});
child.stdin?.end();
snapshot();
const beat = setInterval(snapshot, 2000);
beat.unref?.();
const finish = (exitCode, error) => {
  if (finished) return;
  finished = true;
  clearInterval(beat);
  clearTimeout(drain);
  if (error) take(`\n${error}`);
  snapshot();
  try {
    atomic("output.txt", output.text());
    atomic(
      "result.json",
      JSON.stringify({ exitCode: exitCode ?? 1, truncated: output.truncated }),
    );
  } catch {}
  process.exit(0);
};
child.on("error", (error) => finish(1, error.message));
child.on("close", (code) => finish(code ?? 1));
// A background descendant can inherit stdout after the shell exits. Capture
// the final buffered output, but do not let those pipes hide the shell result.
child.on("exit", (code, signal) => {
  drain = setTimeout(
    () => finish(code ?? 1, signal ? `Command ended by ${signal}.` : null),
    2000,
  );
});
