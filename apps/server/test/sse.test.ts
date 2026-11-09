import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { analyse, sseParser, type Arrival } from "../../../scripts/sse-probe.js";

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
    const r = analyse(meta, [...steady, { at: 4000, kind: "comment" }, done]);
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
    expect(got.map((g) => g.kind)).toEqual(["comment", "tick", "comment", "done"]);
    expect(got[1]!.sentAt).toBe(1000);
  });
});
