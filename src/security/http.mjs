import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export class Authentication {
  constructor(store) {
    this.store = store;
    this.pairings = new Map();
    this.attempts = new Map();
  }
  pairing() {
    const code = randomBytes(24).toString("base64url");
    this.pairings.set(hash(code), Date.now() + 10 * 60 * 1000);
    return code;
  }
  pair(code, ip) {
    const attempt = this.attempts.get(ip);
    if (attempt && attempt.count >= 10 && Date.now() - attempt.at < 300000)
      throw new Error("Too many attempts. Wait five minutes.");
    const key = hash(String(code)),
      expiry = this.pairings.get(key);
    if (!expiry || expiry < Date.now()) {
      this.attempts.set(ip, {
        count: (attempt?.count ?? 0) + 1,
        at: Date.now(),
      });
      throw new Error(
        "Pairing code expired or incorrect. Generate a new code on the host.",
      );
    }
    this.pairings.delete(key);
    this.attempts.delete(ip);
    const token = randomBytes(32).toString("base64url"),
      sessions = this.store.setting("browser-sessions") ?? {};
    for (const [k, v] of Object.entries(sessions))
      if (v.expiresAt < Date.now()) delete sessions[k];
    sessions[hash(token)] = {
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
    this.store.setting("browser-sessions", sessions);
    return token;
  }
  authenticated(req) {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("harness_session="))
      ?.slice(16);
    if (!cookie) return false;
    const session = (this.store.setting("browser-sessions") ?? {})[
      hash(cookie)
    ];
    return !!session && session.expiresAt > Date.now();
  }
  logout(req) {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("harness_session="))
      ?.slice(16);
    if (cookie) {
      const sessions = this.store.setting("browser-sessions") ?? {};
      delete sessions[hash(cookie)];
      this.store.setting("browser-sessions", sessions);
    }
  }
}
// A browser on the host PC itself needs no pairing: it reached the loopback-only
// port directly, with the local host name. Tunnel traffic also arrives over
// loopback, but carries the public host name and Cloudflare's headers.
export function onHost(req, localOrigin) {
  const host = new URL(localOrigin).host;
  return (
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
    [host, host.replace("127.0.0.1", "localhost")].includes(req.headers.host) &&
    !req.headers["cf-connecting-ip"] &&
    !req.headers["cf-access-jwt-assertion"]
  );
}
export function safeOrigin(req, localOrigin, publicOrigin) {
  const origins = [
    localOrigin,
    localOrigin.replace("127.0.0.1", "localhost"),
    publicOrigin,
  ].filter(Boolean);
  if (!origins.some((origin) => new URL(origin).host === req.headers.host))
    return false;
  if (req.headers.origin && !origins.includes(req.headers.origin)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  return true;
}
export async function readJson(req, max = 512 * 1024) {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
    throw new Error("Expected application/json");
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
