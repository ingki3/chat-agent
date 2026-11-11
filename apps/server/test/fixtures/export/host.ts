/**
 * Host-survival check (#51): runs renders against `fake-browser.mjs` in each misbehaving mode inside this process
 * and prints what came back. An unhandled rejection or uncaught exception would end this process early (non-zero
 * exit, no output) — the test (`artifact-export.test.ts`) runs it as a separate Node process for that reason.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Renderer, exportDocument } from "../../../src/artifacts/export.js";
import type { Launcher } from "../../../src/artifacts/browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fake-browser.mjs");
const modes = process.argv.slice(2);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-host-")));
const out: Record<string, { result: string; alive: boolean; ms: number }> = {};

for (const mode of modes) {
  let pid: number | undefined;
  const launcher: Launcher = (s) => {
    const child = spawn(process.execPath, [fake, mode], {
      cwd: s.workDir,
      env: {},
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    pid = child.pid;
    return { child, input: child.stdio[3] as Writable, output: child.stdio[4] as Readable };
  };
  const r = new Renderer({
    browser: process.execPath,
    launcher,
    tmpDir: tmp,
    limits: { timeoutMs: 1500, maxReplyBytes: 1024 * 1024, settleMs: 0 },
    // The fake is not a real browser: no memory check against it.
    test: { probe: async () => [{ pid: pid!, rss: 1 }] },
  });
  const started = Date.now();
  const res = await r.render({ format: "pdf", doc: exportDocument("markdown", "t", "x")!, scripts: false });
  await r.close();
  let alive: boolean;
  try {
    process.kill(pid!, 0);
    alive = true;
  } catch {
    alive = false;
  }
  out[mode] = {
    result: res.ok ? `ok:${res.body.toString("latin1")}` : res.code,
    alive,
    ms: Date.now() - started,
  };
}
// Give any stray rejection the chance to surface before reporting.
await new Promise((r) => setTimeout(r, 300));
const leftovers = fs.readdirSync(tmp);
fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ out, leftovers }));
