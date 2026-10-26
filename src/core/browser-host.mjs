import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { chromium } from "playwright-core";

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
  });

// Mouse buttons and modifier bits as the page sends them, for CDP.
const buttons = ["left", "middle", "right"];
const SHOW_WIDTH = 1280,
  SHOW_HEIGHT = 900;

// The Chrome every agent shares, with no window of its own. Harness launches
// it on its own profile and a loopback DevTools port. Playwright MCP attaches
// to that port for the agents' tools, and the Browser panel watches the same
// pages through a screencast and sends the user's clicks and keys back.
export class BrowserHost extends EventEmitter {
  constructor(
    profileDir,
    { launch = chromium.launchPersistentContext.bind(chromium) } = {},
  ) {
    super();
    this.profileDir = profileDir;
    this.launch = launch;
    this.port = null;
    this.context = null;
    this.ids = new WeakMap();
    this.nextId = 1;
    this.current = null;
    this.viewers = new Set();
    this.cast = null;
  }
  async endpoint() {
    this.port ??= await freePort();
    return `http://127.0.0.1:${this.port}`;
  }
  get running() {
    return !!this.context;
  }
  // Chrome keeps the same port across restarts, so MCP's endpoint stays valid.
  start() {
    if (this.context) return Promise.resolve(this.context);
    this.starting ??= (async () => {
      await this.endpoint();
      const context = await this.launch(this.profileDir, {
        channel: "chrome",
        headless: true,
        viewport: null,
        args: [
          `--remote-debugging-port=${this.port}`,
          `--window-size=${SHOW_WIDTH},${SHOW_HEIGHT}`,
        ],
      });
      this.context = context;
      context.on("page", (page) => this.track(page, true));
      context.on("close", () => {
        if (this.context !== context) return;
        this.context = null;
        this.current = null;
        this.stopCast();
        this.emit("closed");
        this.changed();
      });
      for (const page of context.pages()) this.track(page, false);
      this.current ??= context.pages()[0] ?? null;
      this.changed();
      return context;
    })().finally(() => (this.starting = null));
    return this.starting;
  }
  id(page) {
    if (!this.ids.has(page)) this.ids.set(page, this.nextId++);
    return this.ids.get(page);
  }
  // A page that opens or navigates is the one being worked on, so the panel
  // follows it, as a window would bring it forward.
  track(page, follow) {
    this.id(page);
    if (follow) this.show(page);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        if (this.current !== page) this.show(page);
        else this.changed();
      }
    });
    page.on("load", () => this.changed());
    page.on("close", () => {
      if (this.current === page)
        this.show(this.context?.pages().at(-1) ?? null);
      else this.changed();
    });
  }
  show(page) {
    if (page === this.current) return;
    this.current = page;
    this.stopCast();
    if (this.viewers.size) this.startCast();
    this.changed();
  }
  async state() {
    const pages = this.context?.pages() ?? [];
    const tabs = await Promise.all(
      pages.map(async (page) => ({
        id: this.id(page),
        url: page.url(),
        title: await page.title().catch(() => ""),
        active: page === this.current,
      })),
    );
    return { type: "state", running: this.running, tabs };
  }
  changed() {
    clearTimeout(this.pendingState);
    this.pendingState = setTimeout(async () => {
      const state = await this.state();
      for (const viewer of this.viewers) viewer.state(state);
    }, 50);
  }
  async watch(viewer) {
    this.viewers.add(viewer);
    await this.start();
    viewer.state(await this.state());
    if (!this.cast) this.startCast();
    else if (this.lastFrame) viewer.frame(this.lastFrame);
    return () => {
      this.viewers.delete(viewer);
      if (!this.viewers.size) this.stopCast();
    };
  }
  startCast() {
    const page = this.current;
    if (!page || !this.context || this.cast) return;
    const cast = { page, session: null };
    this.cast = cast;
    this.lastFrame = null;
    this.context
      .newCDPSession(page)
      .then(async (session) => {
        if (this.cast !== cast) return session.detach().catch(() => {});
        cast.session = session;
        session.on("Page.screencastFrame", (frame) => {
          if (this.cast !== cast) return;
          this.lastFrame = {
            data: Buffer.from(frame.data, "base64"),
            width: frame.metadata.deviceWidth,
            height: frame.metadata.deviceHeight,
          };
          for (const viewer of this.viewers) viewer.frame(this.lastFrame);
          session
            .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
            .catch(() => {});
        });
        await session.send("Page.startScreencast", {
          format: "jpeg",
          quality: 70,
          maxWidth: SHOW_WIDTH,
          maxHeight: SHOW_HEIGHT,
        });
      })
      .catch(() => {
        if (this.cast === cast) this.cast = null;
      });
  }
  stopCast() {
    const cast = this.cast;
    this.cast = null;
    this.lastFrame = null;
    cast?.session?.detach().catch(() => {});
  }
  page(tab) {
    return this.context?.pages().find((page) => this.id(page) === tab);
  }
  // What the user does in the panel. The page is Chrome's, so these are the
  // user's own actions and need no approval.
  async input(message) {
    const page = this.current;
    switch (message.type) {
      case "navigate": {
        const target = page ?? (await (await this.start()).newPage());
        const url = /^[a-z][a-z0-9+.-]*:/i.test(message.url)
          ? message.url
          : "https://" + message.url;
        await target.goto(url).catch((error) => {
          if (!/net::ERR_ABORTED/.test(error.message)) throw error;
        });
        return;
      }
      case "select": {
        const chosen = this.page(message.tab);
        if (chosen) this.show(chosen);
        return;
      }
      case "new-tab":
        this.show(await (await this.start()).newPage());
        return;
      case "close-tab":
        await this.page(message.tab)?.close();
        return;
    }
    if (!page) return;
    switch (message.type) {
      case "back":
        await page.goBack().catch(() => {});
        return;
      case "forward":
        await page.goForward().catch(() => {});
        return;
      case "reload":
        await page.reload().catch(() => {});
        return;
      case "mouse": {
        const { action, x, y } = message,
          button = buttons[message.button] ?? "left";
        if (action === "move") await page.mouse.move(x, y);
        else if (action === "down") {
          await page.mouse.move(x, y);
          await page.mouse.down({
            button,
            clickCount: message.clickCount ?? 1,
          });
        } else if (action === "up")
          await page.mouse.up({ button, clickCount: message.clickCount ?? 1 });
        else if (action === "wheel") {
          await page.mouse.move(x, y);
          await page.mouse.wheel(message.deltaX ?? 0, message.deltaY ?? 0);
        }
        return;
      }
      case "key":
        // Keys Playwright does not know, such as an IME's "Process", are
        // skipped rather than failing the stream.
        await (
          message.action === "up"
            ? page.keyboard.up(message.key)
            : page.keyboard.down(message.key)
        ).catch(() => {});
        return;
      case "text":
        await page.keyboard.insertText(String(message.text ?? ""));
        return;
    }
    throw new Error("Unknown browser message");
  }
  async close() {
    this.stopCast();
    const context = this.context;
    this.context = null;
    await context?.close().catch(() => {});
  }
}
