const stopped = new Set([
  "complete",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "cleared",
  "waiting",
]);

export function goalStopped(status) {
  return stopped.has(status);
}

export function goalStatus(status) {
  return goalStopped(status) || ["starting", "active"].includes(status)
    ? status
    : "unknown";
}

// Native sessions belong to their provider, even after a chat changes mode or
// provider. A saved legacy Goal is unconfirmed until resumed or explicitly stopped.
export function sessionGoals(chat) {
  return Object.entries(chat?.sessions ?? {}).flatMap(([provider, session]) => {
    if (!["codex", "claude"].includes(provider)) return [];
    const goal = session?.goal;
    const legacy =
      chat.mode === "goal" &&
      (typeof session === "string" ? session : session?.id);
    if (!goal && !legacy) return [];
    return [{ provider, ...goal, status: goalStatus(goal?.status) }];
  });
}

export function blockingGoals(chat) {
  return sessionGoals(chat).filter((goal) => !goalStopped(goal.status));
}

// A Goal the user paused, or one a usage limit stopped, can pick up where it
// left off. Codex keeps the objective natively; Claude needs the saved one.
const resumable = new Set(["paused", "usageLimited", "waiting"]);

export function resumableGoals(chat) {
  return sessionGoals(chat).filter(
    (goal) =>
      resumable.has(goal.status) &&
      (goal.provider === "codex" || Boolean(goal.objective)),
  );
}

const watchContinuing = (watch) =>
  Boolean(watch?.armed) &&
  (["registering", "pending", "settling", "retrying"].includes(watch.status) ||
    watch.delivery === "pending");

// The bottom of a Goal chat offers resume only for the Goal the latest turn
// left unfinished. An older provider's pause stays saved, and a Goal parked
// on an armed CI watch continues on its own, so neither becomes another box.
export function resumeOffers(chat) {
  if (chat?.activeRun) return [];
  const continuing = (chat?.watches ?? []).some(watchContinuing);
  const latest = chat?.runs?.[0];
  return resumableGoals(chat).filter((goal) => {
    if (goal.provider === "cursor") return false;
    if (continuing && goal.status === "waiting") return false;
    if (!latest) return chat?.mode === "goal" && goal.provider === chat.provider;
    return Boolean(goal.runId) && goal.runId === latest.id;
  });
}
