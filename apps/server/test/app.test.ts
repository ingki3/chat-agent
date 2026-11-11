import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HealthResponse } from "@agentlee/shared";
import { APP_CSP, buildApp, isApiPath } from "../src/app.js";
import { loadConfig, REPO_ROOT } from "../src/config.js";

const apps: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function fakeWebDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-web-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><title>Agent Lee</title><div id=root></div>",
  );
  return dir;
}

describe("config", () => {
  it("defaults to 127.0.0.1:3000", () => {
    const c = loadConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(3000);
  });
  it("anchors relative DATA_DIR at the repository root, not the cwd", () => {
    expect(loadConfig({ DATA_DIR: "./data" }).dataDir).toBe(path.join(REPO_ROOT, "data"));
    expect(fs.existsSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });
  it("refuses non-loopback hosts", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => loadConfig({ HOST: "192.168.0.10" })).toThrow(/loopback/);
  });
});

describe("server", () => {
  it("serves /api/health with the shared schema and security headers", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), { webDist: fakeWebDist() });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json()).service).toBe("agent-lee");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("returns JSON 404 for unknown API routes and index.html for client routes", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), { webDist: fakeWebDist() });
    apps.push(app);
    const api = await app.inject({ method: "GET", url: "/api/nope" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: "not_found" });
    const page = await app.inject({ method: "GET", url: "/c/123" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Agent Lee");
    const head = await app.inject({ method: "HEAD", url: "/c/123" });
    expect(head.statusCode).toBe(200);
    for (const url of ["/api", "/api?x=1", "/api/nope?x=1"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json(), url).toEqual({ error: "not_found" });
    }
  });

  it("recognises API paths", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api?x=1")).toBe(true);
    expect(isApiPath("/api/health")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isApiPath("/c/api")).toBe(false);
  });

  it("sends the app CSP in production", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "production" }), {
      webDist: fakeWebDist(),
      logger: false,
    });
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["content-security-policy"]).toBe(APP_CSP);
  });

  it("keeps /api routes on Fastify when Vite middleware is attached (dev mode)", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), { vite: true });
    apps.push(app);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.headers["content-type"]).toMatch(/application\/json/);
    expect(HealthResponse.parse(health.json()).status).toBe("ok");
    const page = await app.inject({ method: "GET", url: "/c/abc" });
    expect(page.body).toContain("/@vite/client");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    const bare = await app.inject({ method: "GET", url: "/api" });
    expect(bare.json()).toEqual({ error: "not_found" });
  });

  it("listens on 127.0.0.1 only", async () => {
    const config = { ...loadConfig({ NODE_ENV: "test" }), port: 0 };
    const app = await buildApp(config, { webDist: fakeWebDist() });
    apps.push(app);
    await app.listen({ host: config.host, port: 0 });
    const addr = app.server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });
});

describe("logging", () => {
  it("only parses complete lines, even when a record arrives in several chunks", async () => {
    const { sanitizingStream } = await import("../src/logging.js");
    const { Writable } = await import("node:stream");
    const run = async (parts: Buffer[]) => {
      const got: string[] = [];
      const dest = new Writable({ write: (c, _e, cb) => (got.push(String(c)), cb()) });
      const s = sanitizingStream(dest);
      for (const part of parts) s.write(part);
      await new Promise<void>((r) => s.end(r));
      return got;
    };
    const record = JSON.stringify({
      level: 30,
      msg: "run.finished",
      note: "확인",
      credentials: { msg: "SECRET-SPLIT" },
      runId: "r9",
    });
    const bytes = Buffer.from(record + "\n");
    const hangul = bytes.indexOf(Buffer.from("확"));
    // Cut inside the multi-byte character and inside the nested object.
    const cuts = [hangul + 1, hangul + 4, bytes.indexOf(Buffer.from("SECRET")) + 2];
    const parts = [0, ...cuts].map((start, k) => bytes.subarray(start, [...cuts, bytes.length][k]));
    const got = await run(parts);
    expect(got).toHaveLength(1);
    expect(got[0]).not.toContain("SECRET-SPLIT");
    expect(JSON.parse(got[0]!)).toMatchObject({ msg: "run.finished", runId: "r9" });
    // A final record without a trailing newline is emitted exactly once on end().
    const tail = await run([Buffer.from(record.slice(0, 10)), Buffer.from(record.slice(10))]);
    expect(tail).toHaveLength(1);
    expect(JSON.parse(tail[0]!)).toMatchObject({ msg: "run.finished" });
  });

  it("writes only allow-listed fields and strips query strings", async () => {
    const lines: string[] = [];
    const { Writable } = await import("node:stream");
    const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
    const { default: Fastify } = await import("fastify");
    const { loggerOptions } = await import("../src/logging.js");
    const app = Fastify({ logger: loggerOptions(stream) });
    apps.push(app);
    app.get("/boom", async () => {
      throw new Error("THROWN-WITH-USER-DATA");
    });
    app.post("/x", async (req) => {
      req.log
        .child({ apiKey: "sk-CHILD", credentials: { password: "PW-CHILD" }, runId: "r1" })
        .info("tool.finished");
      req.log.info(
        {
          apiKey: "sk-TOPLEVEL",
          credentials: { password: "PW-NESTED" },
          content: "MY-PRIVATE-PROMPT",
          conversationId: "c1",
        },
        "run.finished",
      );
      req.log.error(new Error("failed with PROMPT-IN-ERROR"));
      return { ok: true };
    });
    await app.inject({
      method: "POST",
      url: "/x?token=QUERY-TOKEN",
      headers: { cookie: "sid=SESSION-SECRET" },
      payload: { apiKey: "sk-BODY" },
    });
    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(500);
    const out = lines.join("");
    expect(out).toContain('"msg":"tool.finished"');
    expect(out).toContain('"msg":"error"');
    for (const leak of [
      "sk-TOPLEVEL",
      "PW-NESTED",
      "MY-PRIVATE-PROMPT",
      "QUERY-TOKEN",
      "SESSION-SECRET",
      "sk-BODY",
      "PROMPT-IN-ERROR",
      "sk-CHILD",
      "PW-CHILD",
      "THROWN-WITH-USER-DATA",
    ]) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toContain('"conversationId":"c1"');
    expect(out).toContain('"url":"/x"');
    expect(out).toContain('"runId":"r1"');
  });
});
