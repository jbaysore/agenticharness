import { createServer } from "node:http";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { Store } from "./core/store.mjs";
import {
  CHAT_MODES,
  Controller,
  PERMISSION_MODES,
} from "./core/controller.mjs";
import {
  Authentication,
  onHost,
  safeOrigin,
  readJson,
} from "./security/http.mjs";
import { accessVerifier } from "./security/access.mjs";
import {
  projectPath,
  repositoryState,
  repositoryDiff,
  readRepositoryFile,
} from "./core/repository.mjs";
import { historyCall, historyTools } from "./core/history.mjs";
import { Browser, isBrowserTool } from "./core/browser.mjs";
import { serveBrowserScreenshot } from "./core/browser-images.mjs";
import { cursorAuth } from "./providers/cursor.mjs";
import { Terminals } from "./core/terminals.mjs";
import { backup, DatabaseSync } from "node:sqlite";
import { APP_VERSION } from "./core/version.mjs";
import { importLocalHistory } from "./core/import-history.mjs";
import {
  delegationStats,
  describeRules,
  readRules,
  saveRules,
} from "./core/rules.mjs";
import {
  createSkill,
  deleteSkill,
  listSkills,
  updateSkill,
} from "./core/skills.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Names the browser client on disk, so an open page can tell it was rebuilt.
const clientBuild = () =>
  Promise.all(
    ["app.js", "app.css"].map((file) => stat(join(root, "dist", file))),
  ).then(
    (files) => files.map((f) => `${f.size}-${Math.round(f.mtimeMs)}`).join("."),
    () => null,
  );
export async function createHarness({
  dataDir = process.env.HARNESS_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? homedir(), "AgenticHarness"),
  port = Number(process.env.HARNESS_PORT ?? 47831),
  publicOrigin = process.env.HARNESS_PUBLIC_ORIGIN ?? null,
  remoteIdentityHash = process.env.HARNESS_REMOTE_IDENTITY_HASH ?? null,
  access = process.env.HARNESS_ACCESS_TEAM_DOMAIN
    ? {
        teamDomain: process.env.HARNESS_ACCESS_TEAM_DOMAIN,
        audience: process.env.HARNESS_ACCESS_AUDIENCE,
      }
    : null,
  accessKeys,
  tunnel = process.env.HARNESS_TUNNEL_CONFIG
    ? {
        exe: process.env.HARNESS_TUNNEL_EXE,
        config: process.env.HARNESS_TUNNEL_CONFIG,
      }
    : null,
  startProviders = true,
  seedProject = process.env.HARNESS_INITIAL_PROJECT,
} = {}) {
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Remote origin must be an HTTPS origin without a path");
    publicOrigin = url.origin;
  }
  const ownerSignedIn =
    access?.teamDomain && access.audience && remoteIdentityHash
      ? accessVerifier({ ...access, emailHash: remoteIdentityHash }, accessKeys)
      : null;
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(dataDir, "connection-probe"), { recursive: true });
  const store = new Store(join(dataDir, "workspace.sqlite"));
  if (seedProject)
    store.addProject(basename(seedProject), await projectPath(seedProject));
  const auth = new Authentication(store),
    instanceId = randomUUID(),
    controlToken = randomBytes(32).toString("base64url");
  let localOrigin, controller, close;
  const clients = new Set();
  const terminals = new Terminals((type, data) =>
    controller?.event(null, null, type, data),
  );
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify(value));
  };
  const projectRoot = (projectId, index) => {
    const project = store.project(projectId);
    if (!project) throw new Error("Project not found");
    if (
      index === null ||
      index === undefined ||
      index === "" ||
      index === "primary"
    )
      return project.path;
    const ref = project.repositories[Number(index)];
    if (!ref) throw new Error("Repository not found");
    return ref.path;
  };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    try {
      if (!safeOrigin(req, localOrigin, publicOrigin))
        return json(res, 403, {
          error: "Unrecognized host or cross-site request",
        });
      // The owner's verified Access sign-in is enough on its own remotely.
      let owner = false;
      if (publicOrigin && req.headers.host === new URL(publicOrigin).host) {
        if (!(await ownerSignedIn?.(req.headers["cf-access-jwt-assertion"])))
          return json(res, 403, {
            error:
              "Sign in through Cloudflare Access as the Windows host owner.",
          });
        owner = true;
      }
      const url = new URL(req.url, localOrigin),
        path = url.pathname,
        method = req.method;
      if (path === "/health" && method === "GET")
        return json(res, 200, {
          app: "Agentic Harness",
          version: APP_VERSION,
          instanceId,
          build: await clientBuild(),
        });
      if (path === "/internal/launch" && method === "POST") {
        if (req.headers.authorization !== "Bearer " + controlToken)
          return json(res, 401, { error: "Invalid local launch capability" });
        return json(res, 200, {
          url: localOrigin + "/#pair=" + auth.pairing(),
        });
      }
      if (path === "/internal/shutdown" && method === "POST") {
        if (req.headers.authorization !== "Bearer " + controlToken)
          return json(res, 401, { error: "Invalid local shutdown capability" });
        json(res, 200, { stopping: true });
        setTimeout(() => close(), 50);
        return;
      }
      // Cursor reaches Harness's own tools through history-mcp.mjs and this bridge.
      if (path === "/internal/tools" && method === "GET") {
        const token = req.headers.authorization?.replace(/^Bearer /, "");
        if (!controller.bridgeTokens.has(token))
          return json(res, 401, { error: "History capability expired" });
        return json(res, 200, {
          tools: [
            ...historyTools,
            ...(controller.bridgeBrowser.get(token)?.tools ?? []),
          ],
        });
      }
      if (path === "/internal/history" && method === "POST") {
        const token = req.headers.authorization?.replace(/^Bearer /, ""),
          chatId = controller.bridgeTokens.get(token);
        if (!chatId)
          return json(res, 401, { error: "History capability expired" });
        const body = await readJson(req),
          browser = controller.bridgeBrowser.get(token);
        if (browser && isBrowserTool(body.name))
          return json(res, 200, {
            mcp: await browser.call(body.name, body.arguments ?? {}),
          });
        const result = historyCall(
          store,
          chatId,
          body.name,
          body.arguments ?? {},
        );
        if (body.name === "rename_chat" && result.renamed)
          controller.event(chatId, null, "chat", store.conversation(chatId));
        controller.event(chatId, store.activeRun(chatId)?.id ?? null, "work", {
          kind: "history-tool",
          name: body.name,
          scope: store.conversation(chatId).scope,
          sources: Array.isArray(result)
            ? result.map((r) => r.source).filter(Boolean)
            : [result.source].filter(Boolean),
        });
        return json(res, 200, result);
      }
      if (path.startsWith("/api/")) {
        if (
          !["GET", "HEAD"].includes(method) &&
          req.headers["x-harness-client"] !== "1"
        )
          return json(res, 403, { error: "Missing same-origin client header" });
        if (path === "/api/pair" && method === "POST") {
          const body = await readJson(req),
            token = auth.pair(body.code, req.socket.remoteAddress);
          const secure =
            req.headers.host === new URL(publicOrigin ?? localOrigin).host &&
            !!publicOrigin;
          return json(
            res,
            200,
            { ok: true },
            {
              "Set-Cookie": `harness_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? "; Secure" : ""}`,
            },
          );
        }
        if (!owner && !onHost(req, localOrigin) && !auth.authenticated(req))
          return json(res, 401, {
            error: "Pair this browser with the Windows host",
          });
        if (path.startsWith("/api/browser/screenshots/"))
          return serveBrowserScreenshot(
            req,
            res,
            dataDir,
            path.slice("/api/browser/screenshots/".length),
          );
        if (path === "/api/logout" && method === "POST") {
          auth.logout(req);
          return json(
            res,
            200,
            { ok: true },
            {
              "Set-Cookie":
                "harness_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            },
          );
        }
        if (path === "/api/browsers/revoke" && method === "POST") {
          store.setting("browser-sessions", {});
          return json(res, 200, { ok: true });
        }
        if (path === "/api/pairing-code" && method === "POST")
          return json(res, 200, {
            code: auth.pairing(),
            expiresInMinutes: 10,
            remoteOrigin: publicOrigin,
          });
        if (path === "/api/settings") {
          if (method === "GET") return json(res, 200, store.settings());
          if (method === "PATCH") {
            const settings = store.saveSettings(await readJson(req));
            controller.event(null, null, "settings", settings);
            return json(res, 200, settings);
          }
        }
        if (path === "/api/state" && method === "GET")
          return json(res, 200, {
            ...store.snapshot(),
            providers: controller.providers,
            terminals: terminals.list(),
            remoteOrigin: publicOrigin,
            version: APP_VERSION,
            rules: describeRules(readRules(store), controller.providers),
            delegation: delegationStats(store),
            skills: listSkills(store),
          });
        if (path === "/api/rules" && method === "PUT") {
          const rules = saveRules(
            store,
            await readJson(req),
            controller.providers,
          );
          controller.event(null, null, "rules", {});
          return json(res, 200, describeRules(rules, controller.providers));
        }
        if (path === "/api/skills" && method === "POST") {
          const skill = createSkill(store, await readJson(req));
          controller.event(null, null, "skills", {});
          return json(res, 201, skill);
        }
        const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
        if (skillMatch) {
          if (method === "PATCH") {
            const skill = updateSkill(
              store,
              skillMatch[1],
              await readJson(req),
            );
            controller.event(null, null, "skills", {});
            return json(res, 200, skill);
          }
          if (method === "DELETE") {
            const removed = deleteSkill(store, skillMatch[1]);
            controller.event(null, null, "skills", {});
            return json(res, 200, removed);
          }
        }
        if (path === "/api/providers/refresh" && method === "POST")
          return json(res, 200, {
            providers: await controller.refreshProviders(),
          });
        if (path === "/api/providers/cursor/confirm" && method === "POST") {
          const body = await readJson(req);
          if (body.disabled !== true)
            throw new Error(
              "Confirm on-demand usage is disabled in the Cursor account settings",
            );
          const current = await cursorAuth();
          if (!current.connected) throw new Error("Sign in to Cursor first");
          store.setting("cursor-billing", {
            fingerprint: current.fingerprint,
            disabled: true,
            verifiedAt: Date.now(),
            source: "user-confirmed provider dashboard",
          });
          return json(res, 200, {
            providers: await controller.refreshProviders(),
          });
        }
        if (path === "/api/events" && method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          const after = Number(
            req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
          );
          if (!Number.isSafeInteger(after) || after < 0) {
            res.end();
            return;
          }
          const replay = store.events(after, 2001);
          if (replay.length > 2000)
            res.write(
              `event: resync\ndata: ${JSON.stringify({ lastEventId: store.latestEventId() })}\n\n`,
            );
          else
            for (const event of replay)
              res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          clients.add(res);
          const heartbeat = setInterval(
            () => res.write(": heartbeat\n\n"),
            20000,
          );
          req.on("close", () => {
            clients.delete(res);
            clearInterval(heartbeat);
          });
          return;
        }
        if (path === "/api/projects" && method === "POST") {
          const body = await readJson(req),
            path = await projectPath(body.path),
            project = store.addProject(
              String(body.name ?? basename(path)).slice(0, 100),
              path,
            );
          controller.event(null, null, "projects", {});
          return json(res, 201, project);
        }
        let match;
        if (
          (match = path.match(/^\/api\/actions\/([-\w]{16,100})$/)) &&
          method === "GET"
        )
          return json(res, 200, { run: store.runForAction(match[1]) ?? null });
        if (
          (match = path.match(/^\/api\/projects\/([^/]+)\/references$/)) &&
          method === "POST"
        ) {
          const body = await readJson(req),
            path = await projectPath(body.path);
          return json(
            res,
            200,
            store.addReference(match[1], {
              name: String(body.name ?? basename(path)).slice(0, 100),
              path,
              reason: String(body.reason ?? "Upstream reference").slice(
                0,
                1000,
              ),
            }),
          );
        }
        if (path === "/api/chats" && method === "POST") {
          const body = await readJson(req);
          if (!store.project(body.projectId))
            throw new Error("Choose a project first");
          const chat = store.createConversation({
            projectId: body.projectId,
            provider: body.provider ?? "codex",
            model: body.model ?? "",
            effort: body.effort ?? null,
            permissions: PERMISSION_MODES.includes(body.permissions)
              ? body.permissions
              : "auto",
            mode: CHAT_MODES.includes(body.mode) ? body.mode : "default",
          });
          controller.event(chat.id, null, "chat", chat);
          return json(res, 201, chat);
        }
        if ((match = path.match(/^\/api\/chats\/([^/]+)$/))) {
          const id = match[1];
          if (!store.conversation(id))
            return json(res, 404, { error: "Conversation not found" });
          if (method === "GET")
            return json(res, 200, store.conversationSnapshot(id));
          if (method === "PATCH") {
            const body = await readJson(req),
              fields = {};
            if (body.title !== undefined)
              fields.title = String(body.title).slice(0, 120);
            if (Object.hasOwn(body, "scope"))
              return json(res, 409, {
                error:
                  "History scope is fixed for this conversation. Change the default for new conversations in Connections & usage.",
              });
            if (body.archived !== undefined) {
              if (controller.active.has(id))
                throw new Error("Stop the turn before archiving this chat");
              store.setArchived(id, body.archived === true);
            }
            if (Object.hasOwn(body, "permissions"))
              controller.setPermissions(id, body.permissions);
            if (Object.hasOwn(body, "mode")) controller.setMode(id, body.mode);
            const chat = store.updateConversation(id, fields);
            controller.event(id, null, "chat", chat);
            return json(res, 200, chat);
          }
        }
        if (
          (match = path.match(/^\/api\/chats\/([^/]+)\/read$/)) &&
          method === "POST"
        ) {
          const chat = store.conversation(match[1]);
          if (!chat) return json(res, 404, { error: "Conversation not found" });
          if (chat.unread) {
            store.markRead(chat.id);
            controller.event(chat.id, null, "chat", { read: true });
          }
          return json(res, 200, { ok: true });
        }
        if (
          (match = path.match(/^\/api\/chats\/([^/]+)\/messages$/)) &&
          method === "POST"
        )
          return json(res, 202, controller.send(match[1], await readJson(req)));
        if (
          (match = path.match(/^\/api\/chats\/([^/]+)\/cancel$/)) &&
          method === "POST"
        )
          return json(res, 200, controller.cancel(match[1]));
        if (
          (match = path.match(/^\/api\/approvals\/([^/]+)$/)) &&
          method === "POST"
        )
          return json(
            res,
            200,
            controller.answer(match[1], await readJson(req)),
          );
        if (path === "/api/search" && method === "GET")
          return json(
            res,
            200,
            store.search(url.searchParams.get("q") ?? "", {
              projectId: url.searchParams.get("projectId") ?? undefined,
            }),
          );
        if (path === "/api/repository" && method === "GET")
          return json(
            res,
            200,
            await repositoryState(
              projectRoot(
                url.searchParams.get("projectId"),
                url.searchParams.get("repo"),
              ),
            ),
          );
        if (path === "/api/diff" && method === "GET")
          return json(
            res,
            200,
            await repositoryDiff(
              projectRoot(
                url.searchParams.get("projectId"),
                url.searchParams.get("repo"),
              ),
              url.searchParams.get("file"),
            ),
          );
        if (path === "/api/file" && method === "GET")
          return json(
            res,
            200,
            await readRepositoryFile(
              projectRoot(
                url.searchParams.get("projectId"),
                url.searchParams.get("repo"),
              ),
              url.searchParams.get("file"),
            ),
          );
        if (path === "/api/comments" && method === "POST") {
          const body = await readJson(req),
            chat = store.conversation(body.conversationId);
          if (!chat) throw new Error("Conversation not found");
          const root = projectRoot(chat.project_id, body.repo),
            diff = await repositoryDiff(root, body.file);
          if (diff.revision !== body.revision)
            return json(res, 409, {
              error:
                "The diff changed. Refresh it before attaching this comment.",
            });
          if (
            !Number.isInteger(body.line) ||
            body.line < 1 ||
            typeof body.body !== "string" ||
            !body.body.trim() ||
            body.body.length > 20000
          )
            throw new Error("Provide a line number and review comment");
          const id = store.addComment({ ...body, repository: root });
          return json(res, 201, { id });
        }
        if (path === "/api/artifacts" && method === "POST") {
          const body = await readJson(req),
            chat = store.conversation(body.conversationId);
          if (!chat) throw new Error("Choose a conversation first");
          const root = projectRoot(chat.project_id, body.repo);
          await readRepositoryFile(root, body.file);
          const id = randomUUID();
          store.db
            .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)")
            .run(
              id,
              chat.id,
              chat.project_id,
              root,
              body.file,
              String(body.title ?? basename(body.file)).slice(0, 120),
              store.now(),
            );
          return json(res, 201, { id });
        }
        if (path === "/api/notes" && method === "GET")
          return json(res, 200, store.notes(url.searchParams.get("projectId")));
        if (path === "/api/notes" && method === "POST") {
          const body = await readJson(req);
          if (
            !store.project(body.projectId) ||
            !body.content?.trim() ||
            !Array.isArray(body.evidence) ||
            !body.evidence.length
          )
            throw new Error("A project note needs content and source evidence");
          return json(res, 201, { id: store.addNote(body) });
        }
        if (
          (match = path.match(/^\/api\/notes\/([^/]+)\/stale$/)) &&
          method === "POST"
        ) {
          store.db.prepare("UPDATE notes SET stale=1 WHERE id=?").run(match[1]);
          return json(res, 200, { ok: true });
        }
        if (path === "/api/terminals" && method === "GET")
          return json(res, 200, terminals.list());
        if (path === "/api/terminals" && method === "POST") {
          const body = await readJson(req),
            project = store.project(body.projectId);
          if (!project) throw new Error("Project not found");
          return json(res, 201, terminals.create(project));
        }
        if (
          (match = path.match(
            /^\/api\/terminals\/([^/]+)\/(input|resize|close)$/,
          )) &&
          method === "POST"
        ) {
          const body = await readJson(req);
          if (match[2] === "input") terminals.write(match[1], body.data);
          if (match[2] === "resize")
            terminals.resize(match[1], body.cols, body.rows);
          if (match[2] === "close") await terminals.close(match[1]);
          return json(res, 200, { ok: true });
        }
        if (path === "/api/activity" && method === "GET")
          return json(
            res,
            200,
            store.db
              .prepare(
                "SELECT * FROM events WHERE conversation_id=? AND type IN ('work','handoff','run') ORDER BY id DESC LIMIT 150",
              )
              .all(url.searchParams.get("chatId"))
              .map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
          );
        if (path === "/api/history/import" && method === "POST") {
          const result = await importLocalHistory(store, {
            cursorRoot: join(homedir(), ".cursor", "projects"),
            codexRoot: join(homedir(), ".codex"),
            claudeRoot: join(homedir(), ".claude", "projects"),
            importedPath: join(dataDir, "imported"),
          });
          return json(res, 200, result);
        }
        if (path === "/api/export" && method === "GET") {
          const data = {
            version: 1,
            exportedAt: new Date().toISOString(),
            projects: store.projects(),
            conversations: store.conversations().map((c) => ({
              ...c,
              messages: store.messages(c.id),
              comments: store.comments(c.id),
              runs: store.db
                .prepare(
                  "SELECT * FROM runs WHERE conversation_id=? ORDER BY created_at",
                )
                .all(c.id),
              artifacts: store.db
                .prepare("SELECT * FROM artifacts WHERE conversation_id=?")
                .all(c.id),
              events: store.db
                .prepare(
                  "SELECT * FROM events WHERE conversation_id=? ORDER BY id",
                )
                .all(c.id)
                .map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
            })),
            notes: store.projects().flatMap((p) => store.notes(p.id)),
            skills: listSkills(store),
          };
          return json(res, 200, data, {
            "Content-Disposition":
              'attachment; filename="harness-history.json"',
          });
        }
        if (path === "/api/backup" && method === "POST") {
          await mkdir(join(dataDir, "backups"), { recursive: true });
          const filename =
              "harness-" +
              new Date().toISOString().replaceAll(":", "-") +
              "-" +
              randomUUID().slice(0, 8) +
              ".sqlite",
            path = join(dataDir, "backups", filename);
          await backup(store.db, path);
          const saved = new DatabaseSync(path);
          saved
            .prepare("DELETE FROM settings WHERE key='browser-sessions'")
            .run();
          saved.close();
          return json(res, 201, {
            filename,
            path,
            createdAt: new Date().toISOString(),
            browserPairingsExcluded: true,
          });
        }
        return json(res, 404, { error: "Endpoint not found" });
      }
      if (method !== "GET" && method !== "HEAD")
        return json(res, 405, { error: "Method not allowed" });
      const assets = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/app.css": ["app.css", "text/css"],
        "/favicon.ico": ["icons/harness.ico", "image/vnd.microsoft.icon"],
        "/icons/harness.svg": ["icons/harness.svg", "image/svg+xml"],
        "/icons/harness-192.png": ["icons/harness-192.png", "image/png"],
        "/icons/harness-512.png": ["icons/harness-512.png", "image/png"],
        "/icons/apple-touch-icon.png": [
          "icons/apple-touch-icon.png",
          "image/png",
        ],
        "/manifest.webmanifest": [
          "manifest.webmanifest",
          "application/manifest+json",
        ],
      };
      const font = /^\/fonts\/[\w-]+\.woff2$/.test(path)
        ? [path.slice(1), "font/woff2"]
        : null;
      const asset = Object.hasOwn(assets, path) ? assets[path] : font;
      if (!asset) return json(res, 404, { error: "Not found" });
      const [filename, contentType] = asset;
      let content = await readFile(join(root, "dist", filename));
      // The page names its scripts by build, so no cache between here and a
      // remote browser can hand back an old one, and is never stored itself.
      if (filename === "index.html") {
        const build = await clientBuild();
        if (build)
          content = String(content).replace(
            /"\/app\.(js|css)"/g,
            `"/app.$1?v=${build}"`,
          );
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("CDN-Cache-Control", "no-store");
      } else
        res.setHeader(
          "Cache-Control",
          asset === font ? "public, max-age=31536000, immutable" : "no-cache",
        );
      res.setHeader("Content-Type", contentType);
      res.end(content);
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actualPort = server.address().port;
  localOrigin = `http://127.0.0.1:${actualPort}`;
  controller = new Controller(store, {
    probePath: join(dataDir, "connection-probe"),
    bridgeUrl: localOrigin,
    browser: startProviders ? new Browser(dataDir) : null,
  });
  controller.on("event", (event) => {
    const data = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 2 * 1024 * 1024) {
        client.end();
        clients.delete(client);
      } else client.write(data);
    }
  });
  const runtime = {
    pid: process.pid,
    port: actualPort,
    origin: localOrigin,
    instanceId,
    controlToken,
  };
  await writeFile(join(dataDir, "runtime.json"), JSON.stringify(runtime), {
    mode: 0o600,
  });
  if (startProviders) controller.refreshProviders().catch(() => {});
  let closing, tunnelProcess, tunnelRetry;
  // The tunnel only exists while this host does; requests are still checked above.
  const runTunnel = () => {
    tunnelProcess = spawn(
      tunnel.exe,
      ["tunnel", "--no-autoupdate", "--config", tunnel.config, "run"],
      { windowsHide: true, stdio: "ignore" },
    );
    tunnelProcess.on("error", (error) =>
      console.error("Remote tunnel could not start: " + error.message),
    );
    tunnelProcess.on("exit", () => {
      if (!closing) tunnelRetry = setTimeout(runTunnel, 5000);
    });
  };
  if (tunnel && publicOrigin && ownerSignedIn) runTunnel();
  close = () =>
    (closing ??= (async () => {
      clearTimeout(tunnelRetry);
      tunnelProcess?.kill();
      await controller.close();
      await terminals.closeAll();
      for (const client of clients) client.end();
      server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    })());
  return {
    server,
    store,
    controller,
    auth,
    terminals,
    runtime,
    dataDir,
    close,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await createHarness();
  console.log(`Agentic Harness is running at ${app.runtime.origin}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
