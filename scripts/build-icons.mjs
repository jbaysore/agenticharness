// Regenerate committed PNG/ICO assets from the editable SVG using local Edge.
// Normal app builds copy these assets and do not need a browser.
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const icons = new URL("../src/ui/icons/", import.meta.url);
const svg = await readFile(new URL("harness.svg", icons), "utf8");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  const source =
    "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  async function render(size, opaque = false) {
    const base64 = await page.evaluate(
      async ({ source, size, opaque }) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        if (opaque) {
          context.fillStyle = "#141414";
          context.fillRect(0, 0, size, size);
        }
        context.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { source, size, opaque },
    );
    return Buffer.from(base64, "base64");
  }

  for (const size of [192, 512])
    await writeFile(new URL(`harness-${size}.png`, icons), await render(size));
  await writeFile(
    new URL("apple-touch-icon.png", icons),
    await render(180, true),
  );

  // Windows ICO directory followed by a PNG for each shell/browser scale.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const images = [];
  let offset = header.length;
  for (const [index, size] of sizes.entries()) {
    const png = await render(size);
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    images.push(png);
    offset += png.length;
  }
  await writeFile(
    new URL("harness.ico", icons),
    Buffer.concat([header, ...images]),
  );
  console.log("Generated Harness PNG and Windows icons from harness.svg.");
} finally {
  await browser.close();
}
