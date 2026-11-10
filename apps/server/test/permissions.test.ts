import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/passwords.js";
import { can, type ResourceRef } from "../src/authz/policy.js";
import { watchAccess } from "../src/authz/resources.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { openSse } from "../src/sse.js";
import {
  APP_MATRIX,
  OWNER_ONLY,
  READ,
  USAGE,
  runMatrix,
  type MatrixRow,
} from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const PW = "family-password-1";
const local = { host: "localhost:3000" };

/** Dad (admin), mom and son (members); a "note" resource kind owned by mom and shared with son. */
async function family() {
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), { db: createTestDb(), logger: false });
  apps.push(app);
  const users = app.users!;
  const hash = await hashPassword(PW);
  const dad = users.create({ email: "dad@example.com", name: "아빠", role: "admin", passwordHash: hash });
  const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: hash });
  const son = users.create({ email: "son@example.com", name: "아들", role: "member", passwordHash: hash });
  const notes = new Map<string, ResourceRef>([
    ["n1", { kind: "note", id: "n1", ownerId: mom.id, sharedWith: [son.id] }],
    ["n2", { kind: "note", id: "n2", ownerId: mom.id }],
  ]);
  app.resources.register("note", (id) => notes.get(id));
  const ok = async (req: { resource?: ResourceRef }) => ({ id: req.resource!.id });
  app.get("/api/test/notes/:id", { config: { resource: { kind: "note", action: "read" } } }, ok);
  app.patch("/api/test/notes/:id", { config: { resource: { kind: "note", action: "write" } } }, ok);
  app.delete("/api/test/notes/:id", { config: { resource: { kind: "note", action: "delete" } } }, ok);
  app.get("/api/test/notes/:id/usage", { config: { resource: { kind: "note", action: "usage" } } }, ok);
  app.get(
    "/api/test/notes/:id/stream",
    { config: { resource: { kind: "note", action: "read" } } },
    async (req, reply) => {
      const stream = openSse(reply, { heartbeatMs: 1000 });
      const stop = watchAccess(app, req, () => {
        stream.send("revoked", {});
        stream.close();
      });
      stream.onClose(stop);
      stream.send("ready", {});
    },
  );
  // A stream that is not about one resource (e.g. the user's notification feed) — only the user is re-checked.
  app.get("/api/test/feed", async (req, reply) => {
    const stream = openSse(reply, { heartbeatMs: 1000 });
    stream.onClose(watchAccess(app, req, () => (stream.send("revoked", {}), stream.close())));
    stream.send("ready", {});
  });
  const cookie = async (email: string) => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { ...local, origin: "http://localhost:3000", "x-agent-lee": "1" },
      payload: { email, password: PW },
    });
    return String(r.headers["set-cookie"]).split(";")[0]!;
  };
  const cookies = {
    owner: await cookie("mom@example.com"),
    shared: await cookie("son@example.com"),
    admin: await cookie("dad@example.com"),
    stranger: "",
  };
  return { app, users, dad, mom, son, notes, cookies };
}

describe("policy", () => {
  const note: ResourceRef = { kind: "note", id: "n", ownerId: "mom", sharedWith: ["son"] };
  const u = (id: string, role: "admin" | "member" = "member", active = true) => ({ id, role, active });
  it("owner: everything; shared: read; admin: usage only; inactive: nothing", () => {
    for (const a of ["read", "write", "delete", "share", "usage"] as const)
      expect(can(u("mom"), a, note)).toBe(true);
    expect(can(u("son"), "read", note)).toBe(true);
    for (const a of ["write", "delete", "share", "usage"] as const)
      expect(can(u("son"), a, note)).toBe(false);
    expect(can(u("dad", "admin"), "usage", note)).toBe(true);
    for (const a of ["read", "write", "delete", "share"] as const)
      expect(can(u("dad", "admin"), a, note)).toBe(false);
    expect(can(u("mom", "member", false), "read", note)).toBe(false);
    expect(can(u("x"), "read", note)).toBe(false);
  });
});

describe("resource routes", () => {
  it("son asking for mom's private note gets 403, the admin too, a missing id 404 (matrix)", async () => {
    const { app, cookies } = await family();
    // A third family member with no share plays "stranger".
    app.users!.create({
      email: "x@example.com",
      name: "x",
      role: "member",
      passwordHash: await hashPassword(PW),
    });
    const stranger = String(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { ...local, origin: "http://localhost:3000", "x-agent-lee": "1" },
          payload: { email: "x@example.com", password: PW },
        })
      ).headers["set-cookie"],
    ).split(";")[0]!;
    const all = { ...cookies, stranger };
    const shared: MatrixRow[] = [
      { route: "GET /api/test/notes/:id", expect: READ },
      { route: "PATCH /api/test/notes/:id", expect: OWNER_ONLY },
      { route: "DELETE /api/test/notes/:id", expect: OWNER_ONLY },
      { route: "GET /api/test/notes/:id/usage", expect: USAGE },
    ];
    expect(await runMatrix(app, shared, { cookies: all, id: "n1", missingId: "nope" })).toEqual([]);
    // n2 is not shared: the son is a stranger to it.
    const priv: MatrixRow[] = [{ route: "GET /api/test/notes/:id", expect: { ...READ, shared: 403 } }];
    expect(await runMatrix(app, priv, { cookies: all, id: "n2", missingId: "../n1" })).toEqual([]);
  });

  it("refuses to register a parameterised API route without a permission declaration", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), { db: createTestDb(), logger: false });
    apps.push(app);
    expect(() => app.get("/api/things/:id", async () => ({}))).toThrow(/must declare config.resource/);
    expect(() =>
      app.get(
        "/api/things/:id",
        { config: { resource: { kind: "x", action: "read", param: "thingId" } } },
        async () => ({}),
      ),
    ).toThrow(/not in path/);
    expect(() =>
      app.get(
        "/api/things/:id",
        { config: { auth: "public", resource: { kind: "x", action: "read" } } },
        async () => ({}),
      ),
    ).toThrow(/cannot be public/);
    // An explicit, reasoned opt-out is accepted.
    expect(() =>
      app.get("/api/runtimes/:name/models", { config: { noResource: "static catalogue" } }, async () => ({})),
    ).not.toThrow();
  });

  it("every resource route of the real app has a row in the permission matrix", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), { db: createTestDb(), logger: false });
    apps.push(app);
    await app.ready();
    const declared = app.resources.routes.map((r) => `${r.method} ${r.url}`).sort();
    expect(declared).toEqual(APP_MATRIX.map((r) => r.route).sort());
  });
});

describe("open streams re-check access", () => {
  async function openStream(app: App, cookie: string, path = "/api/test/notes/n1/stream") {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { cookie, host: "localhost:3000" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (re: RegExp) => {
      while (!re.test(text)) {
        const { value, done } = await reader.read();
        if (done) return { text, ended: true };
        text += decoder.decode(value);
      }
      return { text, ended: false };
    };
    return { until, rest: async () => until(/$^/) };
  }

  it("closes a shared user's stream when the share is revoked", async () => {
    const { app, notes, cookies } = await family();
    const s = await openStream(app, cookies.shared);
    await s.until(/event: ready/);
    notes.set("n1", { ...notes.get("n1")!, sharedWith: [] });
    app.appEvents.emit("resource-access-changed", { kind: "note", id: "n1" });
    const end = await s.rest();
    expect(end.text).toMatch(/event: revoked/);
    expect(end.ended).toBe(true);
  });

  it("closes the stream when the user is deactivated, but not for unrelated changes", async () => {
    const { app, users, son, dad, cookies } = await family();
    const s = await openStream(app, cookies.shared);
    await s.until(/event: ready/);
    users.setRole(dad.id, "member"); // someone else: no effect
    app.appEvents.emit("resource-access-changed", { kind: "note", id: "n2" }); // other note: no effect
    users.setRole(son.id, "member"); // re-checked, still allowed
    users.deactivate(son.id);
    const end = await s.rest();
    expect(end.text.match(/event: revoked/g)).toHaveLength(1);
    expect(end.ended).toBe(true);
  });

  it("closes a non-resource stream when its user is deactivated", async () => {
    const { app, users, son, cookies } = await family();
    const s = await openStream(app, cookies.shared, "/api/test/feed");
    await s.until(/event: ready/);
    users.deactivate(son.id);
    const end = await s.rest();
    expect(end.text).toMatch(/event: revoked/);
    expect(end.ended).toBe(true);
  });
});
