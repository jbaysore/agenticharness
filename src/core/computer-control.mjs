// Agents browse in the sidebar browser. Controlling the user's own screen,
// browser or desktop apps needs the user's approval, once per task.

export const COMPUTER_CONTROL_REASON_MAX = 1000;

// The user's global Codex config can enable these. Harness turns them off for
// its own app-server unless this run holds a grant. Plugin names contain no
// dots, so the keys go unquoted: Codex keeps quotes in a -c key literally.
export const CODEX_COMPUTER_CONTROL_OVERRIDES = [
  "plugins.computer-use@openai-bundled.enabled=false",
  "plugins.unified-computer-use@openai-bundled.enabled=false",
  "plugins.browser@openai-bundled.enabled=false",
  "mcp_servers.node_repl.enabled=false",
];

export const computerControlTool = {
  name: "request_computer_control",
  description:
    "Ask the user, once for this task, to let you control their computer: see the screen, send keyboard or mouse input, or drive their own browser or desktop apps. Use the Harness browser tool for web pages instead; it runs in the sidebar on a separate profile and needs no approval. Call this only when the sidebar browser, tests and logs cannot do the job. The user always answers this personally. When approved, Harness ends this turn and continues the task with computer control enabled until the task ends; stop working after the call. When declined, continue without it.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        minLength: 1,
        maxLength: COMPUTER_CONTROL_REASON_MAX,
        description:
          "What you need to do on the user's computer and why the sidebar browser cannot do it, in one or two plain sentences.",
      },
      apps: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 120 },
        maxItems: 10,
        description:
          "The apps or windows you will control, such as \"Chrome\" or \"Game Clipper\".",
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

export function checkComputerControl(input) {
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > COMPUTER_CONTROL_REASON_MAX)
    throw new Error(
      `Explain what you need in 1–${COMPUTER_CONTROL_REASON_MAX} characters.`,
    );
  if (input?.apps !== undefined && !Array.isArray(input.apps))
    throw new Error("List the apps as an array of names.");
  const apps = (input?.apps ?? [])
    .map((app) => (typeof app === "string" ? app.trim() : ""))
    .filter(Boolean)
    .slice(0, 10)
    .map((app) => app.slice(0, 120));
  return { reason, apps };
}

export const COMPUTER_CONTROL_INSTRUCTIONS =
  "Computer control: use the Harness browser tool for every web page, including localhost and signed-in sites. It runs in the Harness sidebar on its own profile, separate from the user's browser session. Never open, drive or read the user's own browser or desktop apps, send keyboard or mouse input, or capture the screen, whether through computer-use plugins, UI automation, or commands such as Start-Process or start with a browser, URL or GUI app, unless the user approved request_computer_control during this task. Request it only when the sidebar browser, tests and logs cannot do the job. An approval covers the current task only.";

export function computerControlGrantInstructions(grant) {
  return `Computer control is approved for this task only. Approved purpose: ${grant.reason}${grant.apps.length ? `\nApproved apps: ${grant.apps.join(", ")}` : ""}\nUse it only for that purpose, and prefer the sidebar browser for web pages.`;
}

export function computerControlContinuation(grant, requestText) {
  return [
    "The user approved computer control for this task. Continue the current task from this session's saved progress, using computer control only for the approved purpose. Do not repeat completed actions.",
    "Approved purpose:\n" + grant.reason,
    grant.apps.length && "Approved apps: " + grant.apps.join(", "),
    "Original request:\n" + requestText,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const COMPUTER_CONTROL_STOP =
  "Approved. Stop task work now. Harness is ending this turn and continues the task with computer control enabled.";

export const COMPUTER_CONTROL_DECLINED =
  "The user did not approve computer control. Do not control the screen, keyboard or mouse, or the user's own browser or desktop apps. Use the sidebar browser, tests or logs instead, and report anything that remains unverified.";
