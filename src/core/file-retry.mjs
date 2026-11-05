import { setTimeout as delay } from "node:timers/promises";

// Windows readers and antivirus scanners can briefly deny rename/delete.
// Retry the same operation so replacement remains atomic and ordered.
export async function retryFileOperation(operation, {
  timeoutMs = 5000,
  platform = process.platform,
  now = () => performance.now(),
  sleep = delay,
} = {}) {
  const deadline = now() + timeoutMs;
  let backoff = 25;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const remaining = deadline - now();
      if (platform !== "win32" || remaining <= 0 ||
          !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await sleep(Math.min(backoff, remaining));
      backoff = Math.min(backoff * 2, 250);
    }
  }
}
