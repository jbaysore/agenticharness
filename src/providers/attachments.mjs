import { readFile } from "node:fs/promises";

const images = (ctx) =>
  (ctx.attachments ?? []).filter((f) => f.type.startsWith("image/"));
export function prefaceText(ctx, body = ctx.text ?? "") {
  const preface = [ctx.addendum, ctx.handoff].filter(Boolean).join("\n\n");
  if (!preface) return body;
  return `${preface}\n\nCurrent request:\n${body}`;
}
const request = (ctx) => prefaceText(ctx);

export function codexInput(ctx) {
  return [
    { type: "text", text: request(ctx) },
    ...images(ctx).map((f) => ({ type: "localImage", path: f.path })),
  ];
}

export const claudeGoalObjective = (ctx) => ctx.goalObjective ?? ctx.session?.goal?.objective ?? ctx.text;
// The SDK's /goal surface does not reliably run its native Stop evaluator.
// Harness owns Claude continuation and completion, with the full objective
// outside the latest user message so a status question cannot replace it.
export function claudeGoalContext(ctx) {
  if (ctx.mode !== "goal") return "";
  const objective = claudeGoalObjective(ctx);
  return [
    `Full Harness Goal (binding objective):\n${objective}`,
    ctx.addendum, ctx.handoff,
    ctx.text && ctx.text !== objective ? `Latest message for this Goal:\n${ctx.text}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function claudeContent(ctx) {
  const text = ctx.mode === "goal"
    ? (ctx.text || "Continue the full saved Harness Goal from the system instructions.")
    : prefaceText(ctx);
  const files = images(ctx);
  if (!files.length) return text;
  return [
    { type: "text", text },
    ...(await Promise.all(
      files.map(async (f) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: f.type,
          data: (await readFile(f.path)).toString("base64"),
        },
      })),
    )),
  ];
}

export async function cursorPrompt(ctx, capabilities = {}) {
  const blocks = [
    {
      type: "text",
      text: [ctx.instructions, prefaceText(ctx)].filter(Boolean).join("\n\n"),
    },
  ];
  if (capabilities.image)
    blocks.push(
      ...(await Promise.all(
        images(ctx).map(async (f) => ({
          type: "image",
          mimeType: f.type,
          data: (await readFile(f.path)).toString("base64"),
        })),
      )),
    );
  return blocks;
}
