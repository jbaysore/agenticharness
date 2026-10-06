// Child host used only by the opt-in real restart acceptance script.
import { createHarness } from "../src/server.mjs";
const app = await createHarness({ port: 0, startProviders: false });
await app.controller.refreshProviders();
process.send?.({ runtime: app.runtime });
