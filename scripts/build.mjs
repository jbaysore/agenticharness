import { build } from "esbuild";
import { mkdir, copyFile, cp, rm } from "node:fs/promises";
await rm("dist/fonts", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/ui/app.jsx"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/app.js",
  jsx: "automatic",
  // The fonts ship with the app, so the workspace looks the same offline.
  loader: { ".woff2": "file" },
  assetNames: "fonts/[name]-[hash]",
  publicPath: "/",
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile("src/ui/index.html", "dist/index.html");
await copyFile("src/ui/manifest.webmanifest", "dist/manifest.webmanifest");
await cp("src/ui/icons", "dist/icons", { recursive: true });
console.log("Built the browser client.");
