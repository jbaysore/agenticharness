import { build } from "esbuild";
import { mkdir, copyFile, cp } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/ui/app.jsx"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/app.js",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile("src/ui/index.html", "dist/index.html");
await copyFile("src/ui/manifest.webmanifest", "dist/manifest.webmanifest");
await cp("src/ui/icons", "dist/icons", { recursive: true });
console.log("Built the browser client.");
