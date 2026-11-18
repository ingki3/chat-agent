/**
 * Orphan check (#170): starts one render through a real launcher (argv[2]: `fake` = the stand-in that ignores pipe
 * EOF under the unsandboxed launcher, `real` = the headless shell under the production launcher, on a document that
 * never stops), prints its process group, members and folder as one JSON line once it runs, then waits. The test
 * (`artifact-export.test.ts`) SIGKILLs this process and checks the watchdog cleans up without it.
 */
import { snapshot } from "../../../src/isolation/sandbox.js";
import { Renderer, exportDocument } from "../../../src/artifacts/export.js";
import {
  findBrowser,
  sandboxedLauncher,
  unsandboxedLauncher,
  type Launcher,
} from "../../../src/artifacts/browser.js";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const real = process.argv[2] === "real";
const base: Launcher = real && process.platform === "darwin" ? sandboxedLauncher : unsandboxedLauncher;
const launcher: Launcher = (s) => {
  const l = base(s);
  const pgid = l.child.pid!;
  // Give the watchdog a moment to start the browser, then report who is running.
  setTimeout(() => {
    void snapshot(pgid, 2000, true).then((procs) => {
      process.stdout.write(
        `${JSON.stringify({ host: process.pid, pgid, members: procs.map((p) => p.pid), workDir: s.workDir })}\n`,
      );
    });
  }, 1500);
  return l;
};
const r = new Renderer({
  browser: real ? findBrowser() : process.execPath,
  launcher,
  limits: { timeoutMs: 60_000, settleMs: 0 },
  egress: {
    lookup: async () => ["93.184.216.34"],
    connect: () => net.connect({ host: "127.0.0.1", port: 9 }),
  },
  test: real
    ? {}
    : {
        args: () => [path.join(here, "fake-browser.mjs"), "orphan"],
        probe: async () => [{ pid: 1, rss: 1 }],
      },
});
const doc = exportDocument("html", "t", "<!doctype html><script>for(;;){}</script>")!;
await r.render({ format: "pdf", doc, scripts: true });
