import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HealthResponse } from "@agentlee/shared";
import { APP_CSP, buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

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
