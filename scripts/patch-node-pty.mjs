// node-pty 1.1.0 forks its Windows console-list helper during terminal cleanup
// without hiding it. Keep this one-line compatibility patch reproducible across
// npm ci, production packages and prepared self-restart runtimes.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const original =
  "var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);";
const hidden = original.replace(");", ", { windowsHide: true });");

export async function patchNodePty(directory, { check = false } = {}) {
  const metadata = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  if (metadata.version !== "1.1.0") {
    throw new Error(
      `Review the hidden console-list helper patch before using node-pty ${metadata.version}.`,
    );
  }
  const file = join(directory, "lib", "windowsPtyAgent.js");
  const source = await readFile(file, "utf8");
  if (source.split(hidden).length === 2 && !source.includes(original)) return;
  if (source.split(original).length !== 2 || source.includes(hidden)) {
    throw new Error(
      "The node-pty Windows helper changed; review the hidden cleanup patch before continuing.",
    );
  }
  if (check)
    throw new Error(
      "The node-pty Windows helper is not hidden. Run npm ci before building Harness.",
    );
  await writeFile(file, source.replace(original, hidden));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const require = createRequire(import.meta.url);
  await patchNodePty(dirname(require.resolve("node-pty/package.json")), {
    check: process.argv.includes("--check"),
  });
}
