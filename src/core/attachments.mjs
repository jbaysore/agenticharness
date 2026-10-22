import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const validId = /^[a-f0-9-]{36}$/;

export function attachmentInfo(file) {
  return {
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size,
    url: `/api/attachments/${file.id}`,
  };
}

export function attachmentPath(dataDir, file) {
  if (!validId.test(file.id) || /[\\/]/.test(file.name))
    throw new Error("Invalid attachment");
  return join(dataDir, "attachments", file.id, file.name);
}

// Only raster formats are displayed inline or sent as native image blocks.
// Browser-supplied MIME types are not trusted (HTML and SVG stay downloads).
function imageType(bytes) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return "application/octet-stream";
}

export async function uploadAttachment(
  req,
  store,
  dataDir,
  projectId,
  encodedName,
) {
  if (!store.project(projectId)) throw new Error("Project not found");
  const name = decodeURIComponent(String(encodedName ?? ""))
    .split(/[\\/]/)
    .at(-1)
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error("Choose a file with a valid name");
  if (Number(req.headers["content-length"]) > MAX_FILE_SIZE)
    throw new Error("Files must be 20 MB or smaller");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FILE_SIZE) throw new Error("Files must be 20 MB or smaller");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks),
    file = { id: randomUUID(), projectId, name, type: imageType(bytes), size };
  const path = attachmentPath(dataDir, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  store.addAttachment(file);
  return attachmentInfo(file);
}

export function resolveAttachments(store, projectId, ids = [], dataDir) {
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_ATTACHMENTS ||
    new Set(ids).size !== ids.length
  )
    throw new Error("Attach up to 10 files per message");
  return ids.map((id) => {
    if (typeof id !== "string" || !validId.test(id))
      throw new Error("Invalid attachment ID");
    const file = store.attachment(id);
    if (!file || file.project_id !== projectId)
      throw new Error(
        "Attachment not found in this project. Upload the file again.",
      );
    return { ...attachmentInfo(file), path: attachmentPath(dataDir, file) };
  });
}

export function attachmentContext(files) {
  if (!files.length) return "";
  return (
    "\n\nFiles attached by the user (available on this host):\n" +
    files
      .map((f) => `- ${JSON.stringify(f.name)}: ${JSON.stringify(f.path)}`)
      .join("\n") +
    "\nRead the attached files as needed. Inspect attached images with your image tools if they are not shown directly."
  );
}

// Runs behind the API's authentication and origin checks.
export async function serveAttachment(req, res, store, dataDir, id) {
  res.setHeader("Cache-Control", "private, no-store");
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }
  try {
    const file = validId.test(id) && store.attachment(id);
    if (!file) throw new Error("Attachment not found");
    const root = await realpath(join(dataDir, "attachments")),
      path = await realpath(attachmentPath(dataDir, file));
    if (dirname(path) !== join(root, id))
      throw new Error("Invalid attachment path");
    const bytes = await readFile(path);
    res.writeHead(200, {
      "Content-Type": file.type,
      "Content-Length": bytes.length,
      "Content-Disposition": `${file.type.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : "Attachment not found");
  }
}
