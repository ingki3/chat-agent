import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { analyse, parseHeaderLines, probe, sseParser, type Arrival } from "../../../scripts/sse-probe.js";
import { REPO_ROOT } from "../src/config.js";

const apps: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function start(env: Record<string, string>, diag = { tickMs: 20, heartbeatMs: 15 }) {
  const config = { ...loadConfig({ NODE_ENV: "test", ...env }), port: 0 };
  const app = await buildApp(config, { diag });
  apps.push(app);
  await app.listen({ host: config.host, port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

describe("diagnostic SSE stream", () => {
  it("is absent unless DIAG_STREAM=1", async () => {
    const base = await start({});
    const res = await fetch(`${base}/api/diag/stream?seconds=1`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("flushes SSE headers at once, sends ticks, heartbeats and a final done event", async () => {
    const base = await start({ DIAG_STREAM: "1" });
    const t0 = Date.now();
    const res = await fetch(`${base}/api/diag/stream?seconds=1`);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await res.text();
    expect(body.startsWith(": open\n\n")).toBe(true);
    expect(body.match(/^event: tick$/gm)).toHaveLength(50);
    expect(body).toMatch(/^: hb$/m);
    expect(body.trimEnd().split("\n\n").at(-1)).toMatch(/^event: done\ndata: \{"count":50,/);
  });

  it("rejects bad durations and caps concurrent streams", async () => {
    const base = await start({ DIAG_STREAM: "1" }, { tickMs: 20, heartbeatMs: 1000 });
    for (const s of ["0", "601", "1.5", "abc"])
      expect((await fetch(`${base}/api/diag/stream?seconds=${s}`)).status, s).toBe(400);
    const a = new AbortController();
    const b = new AbortController();
    const r1 = await fetch(`${base}/api/diag/stream?seconds=5`, { signal: a.signal });
    const r2 = await fetch(`${base}/api/diag/stream?seconds=5`, { signal: b.signal });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect((await fetch(`${base}/api/diag/stream?seconds=5`)).status).toBe(429);
    a.abort();
    await r1.body?.cancel().catch(() => {});
    // The slot is released when the client disconnects.
    let status = 429;
    for (let i = 0; i < 50 && status === 429; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const r = await fetch(`${base}/api/diag/stream?seconds=1`);
      status = r.status;
      await r.body?.cancel().catch(() => {});
    }
    expect(status).toBe(200);
    b.abort();
  });
});

describe("sse-probe analysis", () => {
  const meta = {
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    headersMs: 120,
    expectedTicks: 5,
  };
  const steady: Arrival[] = [1, 2, 3, 4, 5].map((i) => ({
    at: i * 1000 + 30,
    kind: "tick",
    sentAt: i * 1000,
  }));
  const done: Arrival = { at: 5040, kind: "done" };

  it("passes a steady stream", () => {
    const r = analyse(meta, [{ at: 125, kind: "open" }, ...steady, { at: 4000, kind: "heartbeat" }, done]);
    expect(r).toMatchObject({ pass: true, ticks: 5, heartbeats: 1, done: true, maxGapMs: 1000, bunched: 0 });
  });

  it("flags buffering: ticks released together", () => {
    const burst: Arrival[] = steady.map((a, i) => ({ ...a, at: 5000 + i * 5 }));
    const r = analyse(meta, [...burst, done]);
    expect(r.pass).toBe(false);
    expect(r.bunched).toBe(4);
    expect(r.reasons.join()).toMatch(/bunched/);
  });

  it("flags long gaps, missing done, wrong type and slow headers", () => {
    const gappy = steady.map((a, i) => (i === 3 ? { ...a, at: a.at + 4000 } : a));
    const r = analyse({ ...meta, contentType: "text/html", headersMs: 2500 }, gappy);
    expect(r.pass).toBe(false);
    expect(r.reasons.join("|")).toMatch(/content-type text\/html/);
    expect(r.reasons.join("|")).toMatch(/headers after 2500 ms/);
    expect(r.reasons.join("|")).toMatch(/before the done event/);
    expect(r.reasons.join("|")).toMatch(/max gap/);
  });

  it("parses events split across chunks", () => {
    let t = 0;
    const parse = sseParser(() => t++);
    const got = [
      ...parse(": open\n\nevent: ti"),
      ...parse('ck\ndata: {"seq":1,"t":1000}\n'),
      ...parse("\n: hb\n\nevent: done\ndata: {}\n\n"),
    ];
    expect(got.map((g) => g.kind)).toEqual(["open", "tick", "heartbeat", "done"]);
    expect(got[1]!.sentAt).toBe(1000);
  });

  it("parses CRLF streams, including a CRLF split across chunks", () => {
    const parse = sseParser(() => 0);
    const got = [...parse(': open\r\n\r\nevent: tick\r\ndata: {"t":5}\r'), ...parse("\n\r\n: hb\r\n\r\n")];
    expect(got.map((g) => g.kind)).toEqual(["open", "tick", "heartbeat"]);
  });

  it("flags a late first tick, a late done and a missing heartbeat", () => {
    const late = steady.map((a) => ({ ...a, at: a.at + 30_000 }));
    const r = analyse(meta, [...late, { at: 35_040, kind: "done" }]);
    expect(r.reasons.join("|")).toMatch(/max gap 30\d{3} ms/);
    expect(r.reasons.join("|")).toMatch(/no heartbeat for/);
    const lateDone = analyse(meta, [...steady, { at: 9000, kind: "done" }]);
    expect(lateDone.reasons.join("|")).toMatch(/max gap 3970 ms/);
  });
});

describe("sse-probe runtime safeguards", () => {
  const tsx = path.join(REPO_ROOT, "node_modules/.bin/tsx");
  const cli = (args: string[], script = path.join(REPO_ROOT, "scripts/sse-probe.ts")) =>
    spawnSync(tsx, [script, ...args], { encoding: "utf8", cwd: REPO_ROOT });

  it("gives up on a stream that stops sending (idle deadline) and reports instead of hanging", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": open\n\n");
    });
    apps.push({ close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const r = await probe(`http://127.0.0.1:${port}/s?seconds=1`, {}, { idleMs: 200 });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toBe("request failed: idle deadline");
  });

  it("never prints header values, even when the request fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-probe-"));
    const hf = path.join(dir, "h.txt");
    fs.writeFileSync(hf, "# access cookie\nCookie: CF_Authorization=FILE-SECRET\n", { mode: 0o600 });
    const out = path.join(dir, "out.json");
    for (const args of [
      ["http://127.0.0.1:9/api/diag/stream?seconds=1", "--header-file", hf, "--json", out],
      ["http://127.0.0.1:9/api/diag/stream?seconds=1", "-H", "Cookie: ARG-SECRET"],
      ["http://127.0.0.1:9/api/diag/stream?seconds=1", "-H", "X-Bad: BAD\u0001SECRET"],
    ]) {
      const r = cli(args);
      expect(r.status, r.stderr).toBe(1);
      const all = r.stdout + r.stderr + (fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "");
      expect(all).toMatch(/request failed/);
      for (const secret of ["FILE-SECRET", "ARG-SECRET", "SECRET"]) expect(all).not.toContain(secret);
    }
    expect(parseHeaderLines("A: 1\r\n\n# x\nB:2:3")).toEqual({ A: "1", B: "2:3" });
  });

  it("runs as a CLI from a path with spaces and non-ASCII characters", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee probe 경로 "));
    // .mts: outside the repo there is no package.json with "type": "module".
    const copy = path.join(dir, "sse-probe.mts");
    fs.copyFileSync(path.join(REPO_ROOT, "scripts/sse-probe.ts"), copy);
    const r = cli([], copy);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });
});
