import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const types = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const imageName = /^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$/i;
const prefix = "/api/browser/screenshots/";

// Playwright saves screenshots outside the repository. Give agents a short,
// same-origin URL instead of asking them to repeat the image's base64 bytes.
export function screenshotLinks(result, outputDir) {
  const links = new Set();
  for (const block of result?.content ?? []) {
    if (block.type !== "text") continue;
    for (const match of block.text.matchAll(/\[[^\]\r\n]+\]\(([^)\r\n]+)\)/g)) {
      const file = match[1].replaceAll("\\", "/");
      let name;
      if (/^(?:output\/)?[^/]+$/.test(file))
        name = file.replace(/^output\//, "");
      else if (dirname(resolve(file)) === resolve(outputDir))
        name = basename(file);
      if (name && imageName.test(name))
        links.add(prefix + encodeURIComponent(name));
    }
  }
  if (!links.size) return result;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text:
          "Display the saved screenshot in chat with this short Markdown image link. Do not paste base64 data:\n" +
          [...links]
            .map((url) => `[![Browser screenshot](${url})](${url})`)
            .join("\n"),
      },
    ],
  };
}

// Called after the server's normal browser authentication and origin checks.
export async function serveBrowserScreenshot(req, res, dataDir, encodedName) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }
  try {
    const name = decodeURIComponent(encodedName);
    const match = imageName.exec(name);
    if (!match) throw new Error("Invalid screenshot name");
    const root = await realpath(join(dataDir, "browser", "output"));
    const file = await realpath(join(root, name));
    if (dirname(file) !== root)
      throw new Error("Screenshot outside output directory");
    const content = await readFile(file);
    res.writeHead(200, {
      "Content-Type": types[match[1].toLowerCase()],
      "Content-Length": content.length,
      "Content-Disposition": `inline; filename="${name}"`,
    });
    return res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(req.method === "HEAD" ? undefined : "Screenshot not found");
  }
}
