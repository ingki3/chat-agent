/**
 * Orphan check (#170): starts one render through a real launcher (argv[2]: `fake` = the stand-in that ignores pipe
 * EOF under the unsandboxed launcher, `real` = the headless shell under the production launcher, on a document whose
 * infinite loop is started over DevTools and confirmed running), prints its process group, members and folder as one
 * JSON line once that is so, then waits. The test (`artifact-export.test.ts`) SIGKILLs this process and checks the
 * watchdog cleans up without it.
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
let pgid = 0;
let workDir = "";

/** Reports once the group has the watchdog and the browser (polled, bounded by the test's own timeout). */
async function report(extra: Record<string, unknown> = {}) {
  for (;;) {
    const procs = await snapshot(pgid, 2000, true);
    if (procs.length >= 2) {
      const members = procs.map((p) => p.pid);
      process.stdout.write(`${JSON.stringify({ host: process.pid, pgid, members, workDir, ...extra })}\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const launcher: Launcher = (s) => {
  const l = base(s);
  pgid = l.child.pid!;
  workDir = s.workDir;
  if (!real) void report();
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
    ? {
        // The page has loaded and runs its script; then its loop is started and the browser is seen busy in it (a
        // second evaluation cannot be answered while the loop runs).
        afterLoad: async (send) => {
          const ready = (await send("Runtime.evaluate", { expression: "typeof spin" })) as {
            result?: { value?: unknown };
          };
          if (ready.result?.value !== "function") throw new Error("document not running");
          await send("Runtime.evaluate", { expression: "setTimeout(spin, 0); 1" });
          const answered = await Promise.race([
            send("Runtime.evaluate", { expression: "2" }).then(() => true),
            new Promise<false>((res) => setTimeout(() => res(false), 1000)),
          ]);
          await report({ spinning: !answered });
          await new Promise(() => {}); // never returns: the render stays in flight
        },
      }
    : {
        args: () => [path.join(here, "fake-browser.mjs"), "orphan"],
        probe: async () => [{ pid: 1, rss: 1 }],
      },
});
const doc = exportDocument(
  "html",
  "t",
  "<!doctype html><p>spin</p><script>window.spin = () => { for (;;) {} };</script>",
)!;
await r.render({ format: "pdf", doc, scripts: true });
