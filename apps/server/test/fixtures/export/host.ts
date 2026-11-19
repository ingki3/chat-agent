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
import { CdpPipe, type Launcher } from "../../../src/artifacts/browser.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, "fake-browser.mjs");
const modes = process.argv.slice(2);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-host-")));
const out: Record<
  string,
  { result: string; alive: boolean; signal: string | null; order: ("kill" | "close")[] }
> = {};

// What the renderer did to the stand-in, in order (#207 review): a SIGKILL of its group, or a `Browser.close` it tried
// to send (sent or not — a closed pipe drops it). A broken browser must be killed before any polite close is tried;
// a time-based check could not tell that from a close and the 2 s backstop kill on a loaded machine.
let order: ("kill" | "close")[] = [];
let group: number | undefined;
const realKill = process.kill.bind(process);
process.kill = ((pid: number, sig?: string | number) => {
  if (group !== undefined && pid === -group && sig === "SIGKILL") order.push("kill");
  return realKill(pid, sig);
}) as typeof process.kill;
const realSend = CdpPipe.prototype.send;
CdpPipe.prototype.send = function (this: CdpPipe, ...a: Parameters<CdpPipe["send"]>) {
  if (a[0] === "Browser.close") order.push("close");
  return realSend.apply(this, a);
};

for (const mode of modes) {
  order = [];
  group = undefined;
  let pid: number | undefined;
  let ended: Promise<string | null> = Promise.resolve(null);
  const launcher: Launcher = (s) => {
    const child = spawn(process.execPath, [fake, mode], {
      cwd: s.workDir,
      env: {},
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    pid = child.pid;
    group = child.pid; // detached: the stand-in leads its own group
    ended = new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    return { child, input: child.stdio[3] as Writable, output: child.stdio[4] as Readable };
  };
  const r = new Renderer({
    browser: process.execPath,
    launcher,
    tmpDir: tmp,
    // The time limit is what `hang` checks; every other mode ends (or is ended) without it — its own, larger budget
    // there (#207: on a loaded machine the stand-in alone could take longer than 1.5 s to start).
    limits: { timeoutMs: mode === "hang" ? 1500 : 30_000, maxReplyBytes: 1024 * 1024, settleMs: 0 },
    // The fake is not a real browser: no memory check against it.
    test: { probe: async () => [{ pid: pid!, rss: 1 }] },
  });
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
    signal: await ended,
    order,
  };
}
// Give any stray rejection the chance to surface before reporting.
await new Promise((r) => setTimeout(r, 300));
const leftovers = fs.readdirSync(tmp);
fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ out, leftovers }));
