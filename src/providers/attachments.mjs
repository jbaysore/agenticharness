import { readFile } from "node:fs/promises";

const images = (ctx) =>
  (ctx.attachments ?? []).filter((f) => f.type.startsWith("image/"));
const request = (ctx) =>
  [ctx.handoff, ctx.text].filter(Boolean).join("\n\nCurrent request:\n");

export function codexInput(ctx) {
  return [
    { type: "text", text: request(ctx) },
    ...images(ctx).map((f) => ({ type: "localImage", path: f.path })),
  ];
}

export async function claudeContent(ctx) {
  const text =
    ctx.mode === "goal" && !ctx.continuing ? "/goal " + ctx.text : request(ctx);
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
      text: [ctx.instructions, ctx.handoff, ctx.text]
        .filter(Boolean)
        .join("\n\n"),
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
