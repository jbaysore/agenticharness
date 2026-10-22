const stopped = new Set([
  "complete",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "cleared",
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
