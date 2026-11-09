import * as filesystem from "node:fs/promises";
import { dirname } from "node:path";
import { retryFileOperation } from "./file-retry.mjs";

const writes = new Map();

// One bounded queue per file, shared by all chats. A slow disk must not retain
// unlimited diagnostics or hold up provider work. Callers handle write errors.
export function appendDiagnosticRecord(
  path,
  record,
  { maxBytes = 2 * 1024 * 1024, maxPending = 128, io = filesystem } = {},
) {
  const line = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(line) > Math.min(maxBytes, 128 * 1024))
    return Promise.resolve(false);
  const state = writes.get(path) ?? { pending: 0, tail: Promise.resolve() };
  if (state.pending >= maxPending) return Promise.resolve(false);
  state.pending++;
  const next = state.tail
    .catch(() => {})
    .then(async () => {
      await io.mkdir(dirname(path), { recursive: true });
      const size = await io.stat(path).then(
        (info) => info.size,
        (error) => {
          if (error.code !== "ENOENT") throw error;
          return 0;
        },
      );
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await retryFileOperation(() => io.rm(path + ".3", { force: true }));
        for (let n = 2; n >= 0; n--)
          await retryFileOperation(() =>
            io.rename(n ? path + "." + n : path, path + "." + (n + 1)),
          ).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
      }
      await io.appendFile(path, line, { mode: 0o600 });
      return true;
    });
  state.tail = next;
  writes.set(path, state);
  next
    .finally(() => {
      state.pending--;
      if (!state.pending && writes.get(path) === state) writes.delete(path);
    })
    .catch(() => {});
  return next;
}

export async function waitForDiagnostics(promise, timeoutMs = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function flushDiagnostics(timeoutMs = 2000) {
  return waitForDiagnostics(
    Promise.allSettled([...writes.values()].map((state) => state.tail)),
    timeoutMs,
  );
}
