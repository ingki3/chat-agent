/**
 * #215 ordering check: one render over the stand-in browser (unsandboxed launcher). Once the browser runs, the memory
 * limit fires and its group SIGKILL is made to miss the browser (it reaches the watchdog only, as a signal landing
 * mid-`fork` can on macOS). The host waits until the watchdog's exit has been seen (the render is no longer live) and
 * then exits at once — the `exit` hook (`closeRenderers`, as in `index.ts`) runs, no reap timer ever does (they are
 * put off far beyond). It prints one JSON line first. argv[2]: the file the browser writes its pid to.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Renderer, closeRenderers, exportDocument } from "../../../src/artifacts/export.js";
import {
  reapingRenderCount,
  setRenderReapForTests,
  unsandboxedLauncher,
  type Launcher,
} from "../../../src/artifacts/browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pidFile = process.argv[2]!;
process.on("exit", closeRenderers);
setRenderReapForTests({ everyMs: 600_000 });

const browserPid = () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) || 0 : 0);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
let pgid = 0;
let groupSignals = 0;
let browserAfterMiss: boolean | undefined;
const real = process.kill.bind(process);
process.kill = ((target: number, sig?: string | number) => {
  if (pgid && target === -pgid && sig === "SIGKILL") {
    groupSignals++;
    if (browserAfterMiss === undefined) {
      const res = real(pgid, "SIGKILL"); // the watchdog only: the browser is missed
      browserAfterMiss = alive(browserPid());
      return res;
    }
  }
  return real(target, sig);
}) as typeof process.kill;

const launcher: Launcher = (s) => {
  const l = unsandboxedLauncher({ ...s, env: { ...s.env, PIDFILE: pidFile } });
  pgid = l.child.pid!;
  // Registered before the render's own exit handler: look only once that one has run too.
  l.child.once("exit", () =>
    setImmediate(() => {
      process.stdout.write(
        `${JSON.stringify({ pgid, browserAfterMiss, watchdogExited: true, reaping: reapingRenderCount(), groupSignals })}\n`,
      );
      process.exit(0);
    }),
  );
  return l;
};
const r = new Renderer({
  browser: process.execPath,
  launcher,
  limits: { timeoutMs: 60_000, settleMs: 0 },
  egress: {
    lookup: async () => ["93.184.216.34"],
    connect: () => net.connect({ host: "127.0.0.1", port: 9 }),
  },
  test: {
    args: (base) => [
      path.join(here, "fake-browser.mjs"),
      "orphan",
      ...base.filter((a) => a.startsWith("--user-data-dir=")),
    ],
    // The memory limit, once the browser runs.
    probe: async () => [{ pid: 1, rss: alive(browserPid()) ? 1 << 30 : 1 }],
  },
});
setTimeout(() => process.exit(3), 30_000); // bounded
await r.render({ format: "pdf", doc: exportDocument("markdown", "t", "x")!, scripts: false });
await new Promise(() => {});
