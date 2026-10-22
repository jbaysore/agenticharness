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

export async function claudeContent(ctx) {
  const text = prefaceText(
    ctx,
    ctx.mode === "goal" && (!ctx.continuing || ctx.startGoal)
      ? "/goal " + (ctx.goalObjective ?? ctx.text)
      : ctx.text,
  );
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
