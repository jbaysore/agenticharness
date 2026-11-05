// Coalesce event bursts. A request during a read schedules one fresh read so
// callers after a mutation never settle with a pre-mutation snapshot.
export function refreshQueue(read, apply) {
  let pending, dirty;
  return () => {
    dirty = true;
    pending ??= Promise.resolve().then(async () => {
      let value;
      do {
        dirty = false;
        value = await read();
        apply(value);
      } while (dirty);
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}
