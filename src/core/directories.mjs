import * as filesystem from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse } from "node:path";

const order = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Folder selection can navigate beyond projects, but never reads file contents.
export async function browseDirectories(path = homedir(), io = filesystem) {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path))
    throw new Error("Choose an absolute folder path.");
  try {
    const current = await io.realpath(path);
    if (!(await io.stat(current)).isDirectory())
      throw new Error("Choose a folder, not a file.");
    const entries = await io.readdir(current, { withFileTypes: true });
    const directories = (
      await Promise.all(
        entries.map(async (entry) => {
          const target = join(current, entry.name);
          const directory =
            entry.isDirectory() ||
            (entry.isSymbolicLink() &&
              (await io.stat(target).then(
                (info) => info.isDirectory(),
                () => false,
              )));
          return directory ? { name: entry.name, path: target } : null;
        }),
      )
    )
      .filter(Boolean)
      .sort((a, b) => order.compare(a.name, b.name));
    const breadcrumbs = [];
    for (let at = current; ; at = dirname(at)) {
      breadcrumbs.unshift({ name: basename(at) || parse(at).root, path: at });
      if (dirname(at) === at) break;
    }
    const roots =
      process.platform === "win32"
        ? (
            await Promise.all(
              Array.from(
                { length: 26 },
                (_, i) => String.fromCharCode(65 + i) + ":\\",
              ).map(
                async (root) =>
                  await io.stat(root).then(
                    (info) =>
                      info.isDirectory() ? { name: root, path: root } : null,
                    () => null,
                  ),
              ),
            )
          ).filter(Boolean)
        : [{ name: "/", path: "/" }];
    return {
      path: current,
      parent: dirname(current) === current ? null : dirname(current),
      breadcrumbs,
      directories,
      roots: [{ name: "Home", path: homedir() }, ...roots],
    };
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code))
      throw new Error(
        "This folder cannot be opened. Choose a folder you have permission to access.",
      );
    if (["ENOENT", "ENOTDIR"].includes(error.code))
      throw new Error("This folder no longer exists or is unavailable.");
    throw error;
  }
}
