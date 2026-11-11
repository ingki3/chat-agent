import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdminRuntimesResponse,
  AdminUser,
  CSRF_HEADER,
  DefaultsResponse,
  RuntimeOption,
  SystemStatus,
  UserSkillsResponse,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { CLAUDE_MODELS } from "../src/runtime/claude.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { parseMetricsAddress, tunnelStatus } from "../src/observability/tunnel.js";
import type { McpTokens } from "../src/isolation/tokens.js";
import { callOurTool } from "./helpers/live-mcp.js";
import { createFamily, type Family } from "./helpers/permission-matrix.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const FAKE_KEY = `sk-ant-ADMINSCREENFAKE${"k".repeat(20)}9876`;

/**
 * The real app with a Claude-shaped FakeRuntime (the real model list: Opus, Sonnet, Haiku) and a Codex one, and
 * the matrix family: owner = the son (youth), shared = mom, admin = dad, stranger = another member.
 */
async function start(o: { env?: Record<string, string>; needsConnection?: boolean } = {}) {
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeRuntime({ models: CLAUDE_MODELS, needsConnection: o.needsConnection ?? false }));
  runtimes.register(new FakeRuntime({ id: "codex", needsConnection: o.needsConnection ?? false }));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-admin-"));
  closers.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, ...o.env }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    notifications: { sender: async () => {} },
    mcp: { runSkill: async () => ({ ok: false, code: "skill_failed" }) },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  app.users!.setYouth(f.users.owner.id, true);
  const bodies: string[] = [];
  const req = async (
    cookie: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ) => {
    const r = await app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie,
        ...(method === "GET" ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
      },
      ...(method === "GET" ? {} : { payload: payload ?? {} }),
    });
    bodies.push(r.body);
    return r;
  };
  const as = (who: keyof Family["cookies"]) => ({
    get: (url: string) => req(f.cookies[who], "GET", url),
    post: (url: string, body?: object) => req(f.cookies[who], "POST", url, body),
    put: (url: string, body: object) => req(f.cookies[who], "PUT", url, body),
    patch: (url: string, body: object) => req(f.cookies[who], "PATCH", url, body),
    del: (url: string) => req(f.cookies[who], "DELETE", url),
  });
  return {
    app,
    db,
    f,
    son: as("owner"),
    mom: as("shared"),
    admin: as("admin"),
    stranger: as("stranger"),
    bodies,
    dataDir,
  };
}

const policy = (models: "all" | string[], efforts: "all" | string[] = "all") => ({
  items: [{ runtime: "claude-code", allowed: true, models, efforts, allowPersonal: true, allowShared: true }],
});
const modelIds = (items: unknown) =>
  RuntimeOption.array()
    .parse(items)
    .flatMap((o) => o.models.map((m) => `${o.runtime}/${m.id}`));

describe("per-user model permission (#35 acceptance: Haiku taken away from the son)", () => {
  it("disappears from his pickers, and the API refuses it for a run and as a default (403)", async () => {
    const t = await start();
    const sonId = t.f.users.owner.id;
    // Before: Haiku is offered, and he can make it his default.
    expect(modelIds((await t.son.get("/api/runtimes")).json<{ items: unknown }>().items)).toContain(
      "claude-code/claude-haiku-5-5",
    );
    const haiku = {
      runtime: "claude-code",
      models: { "claude-code": { model: "claude-haiku-5-5", effort: "low" } },
    };
    expect((await t.son.put("/api/settings/defaults", { defaults: haiku })).statusCode).toBe(200);

    // The admin takes Haiku away.
    const put = await t.admin.put(
      `/api/admin/users/${sonId}/runtime-policies`,
      policy(["claude-opus-5-5", "claude-sonnet-5-5"]),
    );
    expect(put.statusCode).toBe(200);

    // Gone from every picker he has (the settings default selector and the chip read /api/runtimes).
    const after = modelIds((await t.son.get("/api/runtimes")).json<{ items: unknown }>().items);
    expect(after).not.toContain("claude-code/claude-haiku-5-5");
    expect(after).toContain("claude-code/claude-sonnet-5-5");
    // The saved default is reported as no longer usable (FR-12.6 notice).
    const d = DefaultsResponse.parse((await t.son.get("/api/settings/defaults")).json());
    expect(d).toMatchObject({ source: "own", unavailable: ["claude-code"] });

    // Starting a run with it: 403, nothing created.
    const conv = t.app.conversations!.create(sonId);
    const run = await t.son.post(`/api/conversations/${conv.id}/messages`, {
      text: "안녕",
      model: "claude-haiku-5-5",
    });
    expect(run.statusCode).toBe(403);
    expect(run.json()).toEqual({ error: "model_not_allowed" });
    expect(t.app.conversations!.messages(conv.id, {})).toEqual([]);

    // Saving it as his default again: 403 — for the default runtime's model and for another runtime's entry.
    const again = await t.son.put("/api/settings/defaults", { defaults: haiku });
    expect(again.statusCode).toBe(403);
    expect(again.json()).toEqual({ error: "model_not_allowed" });
    const viaCodex = await t.son.put("/api/settings/defaults", {
      defaults: { runtime: "codex", models: { "claude-code": { model: "claude-haiku-5-5", effort: null } } },
    });
    expect(viaCodex.json()).toEqual({ error: "model_not_allowed" });
    // The admin cannot make it his initial default either (400, the same code).
    const initial = await t.admin.put(`/api/admin/users/${sonId}/defaults`, { defaults: haiku });
    expect(initial.statusCode).toBe(400);
    expect(initial.json()).toEqual({ error: "model_not_allowed" });

    // What is allowed still works, and effort is checked too.
    const sonnet = {
      runtime: "claude-code",
      models: { "claude-code": { model: "claude-sonnet-5-5", effort: "high" } },
    };
    expect((await t.son.put("/api/settings/defaults", { defaults: sonnet })).statusCode).toBe(200);
    await t.admin.put(`/api/admin/users/${sonId}/runtime-policies`, policy(["claude-sonnet-5-5"], ["low"]));
    expect((await t.son.put("/api/settings/defaults", { defaults: sonnet })).json()).toEqual({
      error: "effort_not_allowed",
    });
    const ok = await t.son.post(`/api/conversations/${conv.id}/messages`, {
      text: "안녕",
      model: "claude-sonnet-5-5",
    });
    expect(ok.statusCode).toBe(201);
    // Mom is not affected.
    expect(modelIds((await t.mom.get("/api/runtimes")).json<{ items: unknown }>().items)).toContain(
      "claude-code/claude-haiku-5-5",
    );
  });

  it("a runtime that is not allowed (or not on this server) cannot be the default", async () => {
    const t = await start();
    const sonId = t.f.users.owner.id;
    await t.admin.put(`/api/admin/users/${sonId}/runtime-policies`, {
      items: [
        {
          runtime: "codex",
          allowed: false,
          models: "all",
          efforts: "all",
          allowPersonal: true,
          allowShared: true,
        },
      ],
    });
    const r = await t.son.put("/api/settings/defaults", { defaults: { runtime: "codex", models: {} } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "runtime_not_allowed" });
    // Unknown fields and bad shapes are 400, never saved.
    expect(
      (await t.son.put("/api/settings/defaults", { defaults: { runtime: "x", models: {} } })).statusCode,
    ).toBe(400);
    expect((await t.son.put("/api/settings/defaults", { defaults: null, extra: 1 })).statusCode).toBe(400);
  });

  it("initial defaults (FR-12.4): service default first, the admin's value next, the user's own wins", async () => {
    const t = await start();
    const momId = t.f.users.shared.id;
    expect(DefaultsResponse.parse((await t.mom.get("/api/settings/defaults")).json())).toMatchObject({
      source: "service",
      defaults: { runtime: "claude-code", models: { "claude-code": { model: "claude-opus-5-5" } } },
      unavailable: [],
    });
    const codex = { runtime: "codex", models: { codex: { model: "fake-small", effort: null } } };
    const set = await t.admin.put(`/api/admin/users/${momId}/defaults`, { defaults: codex });
    expect(set.statusCode).toBe(200);
    expect(AdminUser.parse(set.json<{ user: unknown }>().user)).toMatchObject({
      initialDefaults: codex,
      defaultRuntime: "codex",
    });
    expect((await t.mom.get("/api/settings/defaults")).json()).toMatchObject({
      source: "initial",
      defaults: codex,
    });
    const own = { runtime: "claude-code", models: {} };
    await t.mom.put("/api/settings/defaults", { defaults: own });
    expect((await t.mom.get("/api/settings/defaults")).json()).toMatchObject({
      source: "own",
      defaults: own,
    });
    // Clearing her own brings the admin's back.
    await t.mom.put("/api/settings/defaults", { defaults: null });
    expect((await t.mom.get("/api/settings/defaults")).json()).toMatchObject({ source: "initial" });
    // Creating an account with a runtime makes it the initial default.
    const created = await t.admin.post("/api/admin/users", {
      name: "새",
      email: "new@x.test",
      defaultRuntime: "codex",
    });
    expect(AdminUser.parse(created.json<{ user: unknown }>().user).initialDefaults).toEqual({
      runtime: "codex",
      models: {},
    });
  });
});

describe("users tab (#35, FR-15.1): name, email, role — and the last admin", () => {
  it("edits name, email and role; a new email ends the user's sessions", async () => {
    const t = await start();
    const momId = t.f.users.shared.id;
    const r = await t.admin.patch(`/api/admin/users/${momId}`, { name: "엄마2", email: " Mom2@X.test " });
    expect(r.statusCode).toBe(200);
    expect(AdminUser.parse(r.json<{ user: unknown }>().user)).toMatchObject({
      name: "엄마2",
      email: "mom2@x.test",
    });
    expect((await t.mom.get("/api/settings/defaults")).statusCode).toBe(401);
    // Taken emails, empty patches, members and unknown ids.
    expect(
      (await t.admin.patch(`/api/admin/users/${momId}`, { email: "stranger@matrix.test" })).json(),
    ).toEqual({
      error: "email_taken",
    });
    expect((await t.admin.patch(`/api/admin/users/${momId}`, {})).statusCode).toBe(400);
    expect((await t.admin.patch(`/api/admin/users/${momId}`, { role: "owner" })).statusCode).toBe(400);
    expect((await t.son.patch(`/api/admin/users/${momId}`, { name: "x" })).statusCode).toBe(403);
    expect((await t.admin.patch("/api/admin/users/nobody", { name: "x" })).statusCode).toBe(404);
    // Name only keeps the session.
    expect((await t.admin.patch(`/api/admin/users/${t.f.users.owner.id}`, { name: "아들" })).statusCode).toBe(
      200,
    );
    expect((await t.son.get("/api/settings/defaults")).statusCode).toBe(200);
  });

  it("an admin's email changes only through #36 (FR-15.7)", async () => {
    const t = await start();
    const self = await t.admin.patch(`/api/admin/users/${t.f.users.admin.id}`, { email: "dad2@x.test" });
    expect(self.statusCode).toBe(409);
    expect(self.json()).toEqual({ error: "admin_email_change" });
    // Promoting and changing the email at once is the same.
    const both = await t.admin.patch(`/api/admin/users/${t.f.users.shared.id}`, {
      role: "admin",
      email: "a@x.test",
    });
    expect(both.json()).toEqual({ error: "admin_email_change" });
    expect(t.app.users!.byId(t.f.users.shared.id)).toMatchObject({
      role: "member",
      email: "shared@matrix.test",
    });
  });

  it("the last active admin can neither demote nor deactivate themselves; with two, the second demotion fails", async () => {
    const t = await start();
    const dadId = t.f.users.admin.id;
    const momId = t.f.users.shared.id;
    const demoteSelf = await t.admin.patch(`/api/admin/users/${dadId}`, { role: "member" });
    expect(demoteSelf.statusCode).toBe(409);
    expect(demoteSelf.json()).toEqual({ error: "last_admin" });
    expect((await t.admin.post(`/api/admin/users/${dadId}/deactivate`)).statusCode).toBe(400);
    expect(t.app.users!.byId(dadId)).toMatchObject({ role: "admin", active: true });

    // Mom becomes an admin: now dad may step down, and then mom is the last one.
    expect((await t.admin.patch(`/api/admin/users/${momId}`, { role: "admin" })).statusCode).toBe(200);
    expect((await t.admin.patch(`/api/admin/users/${dadId}`, { role: "member" })).statusCode).toBe(200);
    // Dad is no admin any more: his admin calls are refused.
    expect((await t.admin.patch(`/api/admin/users/${momId}`, { role: "member" })).statusCode).toBe(403);
    expect((await t.mom.patch(`/api/admin/users/${momId}`, { role: "member" })).json()).toEqual({
      error: "last_admin",
    });
    const admins = t.app.users!.list().filter((u) => u.role === "admin" && u.active);
    expect(admins.map((u) => u.id)).toEqual([momId]);
  });

  it("two admins demoting each other at the same moment cannot both succeed (one transaction each)", async () => {
    const t = await start();
    const users = t.app.users!;
    users.setRole(t.f.users.shared.id, "admin");
    const a = users.update(t.f.users.admin.id, { role: "member" });
    const b = users.update(t.f.users.shared.id, { role: "member" });
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(b).toEqual({ ok: false, code: "last_admin" });
    // An inactive admin does not count.
    users.setRole(t.f.users.stranger.id, "admin");
    users.deactivate(t.f.users.stranger.id);
    expect(users.update(t.f.users.shared.id, { role: "member" })).toEqual({ ok: false, code: "last_admin" });
  });
});

describe("skills tab (#35, FR-10.3): server allow-list and per-user switches", () => {
  it('per-user switches keep the youth account\'s finance skills hidden (#30) and go back to "all"', async () => {
    const t = await start();
    const sonId = t.f.users.owner.id;
    const view = UserSkillsResponse.parse((await t.admin.get(`/api/admin/users/${sonId}/skills`)).json());
    expect(view.mode).toBe("all");
    expect(view.youth).toBe(true);
    const kr = view.skills.find((s) => s.name === "kr-stock-skill")!;
    expect(kr).toMatchObject({ finance: true, allowed: false, reason: "youth_hidden" });
    expect(view.skills.find((s) => s.name === "google-news-search-skill")).toMatchObject({
      allowed: true,
      reason: "all",
    });

    // Switching a non-finance skill off writes a list — without the finance skills.
    const off = await t.admin.put(`/api/admin/users/${sonId}/skills/google-news-search-skill`, {
      enabled: false,
    });
    expect(off.statusCode).toBe(200);
    const list = t.app.users!.byId(sonId)!.permissions.skills as string[];
    expect(list).not.toContain("google-news-search-skill");
    expect(
      list.filter((s) =>
        ["kr-stock-skill", "us-stock-skill", "market-disclosure-monitor", "dart-investment-monitor"].includes(
          s,
        ),
      ),
    ).toEqual([]);
    expect(t.app.mcp!.allows(sonId, "kr-stock-skill")).toBe(false);
    // On again: exactly what "all" gives a youth account → "all".
    await t.admin.put(`/api/admin/users/${sonId}/skills/google-news-search-skill`, { enabled: true });
    expect(t.app.users!.byId(sonId)!.permissions.skills).toBe("all");
    // Only naming a finance skill turns it on.
    await t.admin.put(`/api/admin/users/${sonId}/skills/kr-stock-skill`, { enabled: true });
    expect(t.app.mcp!.allows(sonId, "kr-stock-skill")).toBe(true);
    expect(t.app.mcp!.allows(sonId, "us-stock-skill")).toBe(false);
    // An adult account under "all" sees finance.
    expect(t.app.mcp!.allows(t.f.users.shared.id, "kr-stock-skill")).toBe(true);
    // Unknown skill, bad body, members.
    expect((await t.admin.put(`/api/admin/users/${sonId}/skills/nope`, { enabled: true })).statusCode).toBe(
      404,
    );
    expect(
      (await t.admin.put(`/api/admin/users/${sonId}/skills/kr-stock-skill`, { enabled: "yes" })).statusCode,
    ).toBe(400);
    expect(
      (await t.son.put(`/api/admin/users/${sonId}/skills/kr-stock-skill`, { enabled: true })).statusCode,
    ).toBe(403);
  });

  it("a skill switched off on the server is offered to nobody, whatever their permissions", async () => {
    const t = await start();
    const momId = t.f.users.shared.id;
    const mcp = t.app.mcp!;
    expect(mcp.allows(momId, "kr-stock-skill")).toBe(true);
    const off = await t.admin.put("/api/admin/skills/kr-stock-skill", { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(
      off
        .json<{ skills: { name: string; enabled: boolean }[] }>()
        .skills.find((s) => s.name === "kr-stock-skill"),
    ).toMatchObject({ enabled: false });
    expect(mcp.allows(momId, "kr-stock-skill")).toBe(false);
    expect(mcp.toolNamesFor(momId).some((n) => n.startsWith("kr_"))).toBe(false);
    // Explicitly listed for the son: still off.
    await t.admin.put(`/api/admin/users/${t.f.users.owner.id}/skills/kr-stock-skill`, { enabled: true });
    expect(mcp.allows(t.f.users.owner.id, "kr-stock-skill")).toBe(false);
    expect(
      UserSkillsResponse.parse(
        (await t.admin.get(`/api/admin/users/${t.f.users.owner.id}/skills`)).json(),
      ).skills.find((s) => s.name === "kr-stock-skill"),
    ).toMatchObject({ allowed: true, serverEnabled: false });
    // The verification skill is always on.
    expect(mcp.allows(momId, "selftest")).toBe(true);
    // Kept across a restart (settings).
    const again = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: t.dataDir }), {
      db: t.db,
      logger: false,
    });
    closers.push(() => again.close());
    expect(again.mcp!.allows(momId, "kr-stock-skill")).toBe(false);
    await t.admin.put("/api/admin/skills/kr-stock-skill", { enabled: true });
    expect(mcp.allows(momId, "kr-stock-skill")).toBe(true);
    expect((await t.admin.put("/api/admin/skills/nope", { enabled: false })).statusCode).toBe(404);
  });
});

describe("runtimes tab (#35): model list, shared and on-behalf connections, never a credential", () => {
  it("lists each runtime's models and capabilities", async () => {
    const t = await start();
    const r = AdminRuntimesResponse.parse((await t.admin.get("/api/admin/runtimes")).json());
    const claude = r.items.find((i) => i.runtime === "claude-code")!;
    expect(claude.registered).toBe(true);
    expect(claude.models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(claude.models[2]).toMatchObject({ efforts: ["low", "medium", "high"], defaultEffort: "low" });
    expect(Object.keys(claude.capabilities).sort()).toEqual([
      "canResume",
      "canSwitchModelInSession",
      "needsConnection",
      "usesTools",
    ]);
  });

  it("registers and tests a member's API key on their behalf; subscriptions only by their owner; nothing shows the key", async () => {
    const t = await start({ needsConnection: true });
    const momId = t.f.users.shared.id;
    const add = await t.admin.post(`/api/admin/users/${momId}/connections`, {
      runtime: "claude-code",
      authType: "api_key",
      secret: FAKE_KEY,
    });
    expect(add.statusCode).toBe(201);
    const c = add.json<{ connection: { id: string; hint: string; registeredByAdmin: boolean } }>().connection;
    expect(c).toMatchObject({ hint: "••••9876", registeredByAdmin: true });
    // Tested as mom (her policy, her folder): it passes and becomes usable for her.
    const test = await t.admin.post(`/api/admin/users/${momId}/connections/${c.id}/test`);
    expect(test.statusCode).toBe(200);
    expect(test.json<{ result: { status: string } }>().result.status).toBe("passed");
    expect(
      (await t.mom.get("/api/runtimes"))
        .json<{ items: { connections: { id: string }[] }[] }>()
        .items[0]!.connections.map((x) => x.id),
    ).toEqual([c.id]);
    // Someone else's connection id under mom's path: 404.
    expect(
      (await t.admin.post(`/api/admin/users/${t.f.users.owner.id}/connections/${c.id}/test`)).statusCode,
    ).toBe(404);
    // A subscription on someone else's account: never (a member's — the store's rule; another admin's — 403).
    const member = await t.admin.post(`/api/admin/users/${momId}/connections`, {
      runtime: "claude-code",
      authType: "subscription",
      secret: `sk-ant-oat01-${"t".repeat(30)}`,
    });
    expect(member.statusCode).toBe(403);
    t.app.users!.setRole(t.f.users.stranger.id, "admin");
    const otherAdmin = await t.admin.post(`/api/admin/users/${t.f.users.stranger.id}/connections`, {
      runtime: "claude-code",
      authType: "subscription",
      secret: `sk-ant-oat01-${"t".repeat(30)}`,
    });
    expect(otherAdmin.statusCode).toBe(403);
    expect(otherAdmin.json()).toEqual({ error: "subscription_self_only" });
    // A ChatGPT login is never pasted, on anyone's behalf.
    const chatgpt = await t.admin.post(`/api/admin/users/${momId}/connections`, {
      runtime: "codex",
      authType: "subscription",
      secret: `x${"t".repeat(30)}`,
    });
    expect(chatgpt.statusCode).toBe(400);

    // A shared connection registered and tested; then every admin screen read.
    const shared = await t.admin.post("/api/admin/connections", {
      runtime: "claude-code",
      authType: "api_key",
      secret: FAKE_KEY.replace("ADMIN", "SHARE"),
    });
    await t.admin.post(
      `/api/admin/connections/${shared.json<{ connection: { id: string } }>().connection.id}/test`,
    );
    for (const url of [
      "/api/admin/users",
      "/api/admin/connections",
      `/api/admin/users/${momId}/connections`,
      "/api/admin/system",
      "/api/admin/runtimes",
      "/api/admin/skills",
    ])
      expect((await t.admin.get(url)).statusCode).toBe(200);
    const secretBody = FAKE_KEY.slice(0, -4);
    for (const b of t.bodies) {
      expect(b).not.toContain(secretBody);
      expect(b).not.toContain(FAKE_KEY.replace("ADMIN", "SHARE").slice(0, -4));
    }
  });

  it("another admin's own subscription cannot be tested on their behalf (403); their own call can", async () => {
    const t = await start({ needsConnection: true });
    // Admin A (stranger promoted) connects their own Claude subscription themselves.
    const a = t.f.users.stranger;
    t.app.users!.setRole(a.id, "admin");
    const own = await t.stranger.post("/api/connections", {
      runtime: "claude-code",
      authType: "subscription",
      secret: `sk-ant-oat01-${"a".repeat(30)}`,
    });
    expect(own.statusCode).toBe(201);
    const id = own.json<{ connection: { id: string } }>().connection.id;
    // Admin B tries to test it as A: refused, nothing run, the connection stays untested.
    const r = await t.admin.post(`/api/admin/users/${a.id}/connections/${id}/test`);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "subscription_self_only" });
    expect(t.app.connections!.store.get(id)).toMatchObject({ status: "untested", lastTestAt: null });
    // A on the on-behalf path for their own: allowed (it is theirs), as is their own settings route.
    expect((await t.stranger.post(`/api/admin/users/${a.id}/connections/${id}/test`)).statusCode).toBe(200);
    expect((await t.stranger.post(`/api/connections/${id}/test`)).statusCode).toBe(200);
  });
});

describe("system status (#35, FR-10.4)", () => {
  it("uptime, runtime connections, tunnel 미설정, recent errors and skill failures as codes, disk", async () => {
    const t = await start({ needsConnection: true });
    t.app.errors!.record({
      source: "http",
      code: "internal_error",
      category: "app",
      route: "GET /api/admin/system",
      statusCode: 500,
    });
    t.app.errors!.record({ source: "tool", code: "skill_failed", category: "tool", tool: "skill_selftest" });
    t.app.errors!.record({ source: "tool", code: "skill_failed", category: "tool", tool: "skill_selftest" });
    t.app.errors!.record({ source: "tool", code: "tool_error", category: "tool", tool: "other" });
    await t.admin.post("/api/admin/connections", {
      runtime: "claude-code",
      authType: "api_key",
      secret: FAKE_KEY,
    });
    await t.son.post("/api/connections", {
      runtime: "codex",
      authType: "api_key",
      secret: `sk-SONCODEX${"c".repeat(24)}`,
    });
    const s = SystemStatus.parse((await t.admin.get("/api/admin/system")).json());
    expect(s.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(s.tunnel).toEqual({ state: "unconfigured", readyConnections: null });
    const claude = s.runtimes.find((r) => r.runtime === "claude-code")!;
    expect(claude.shared).toEqual([expect.objectContaining({ status: "untested", lastTestCode: null })]);
    expect(s.runtimes.find((r) => r.runtime === "codex")!.personal).toEqual({
      untested: 1,
      passed: 0,
      failed: 0,
      expired: 0,
    });
    expect(s.recentErrors.map((e) => e.code)).toEqual([
      "tool_error",
      "skill_failed",
      "skill_failed",
      "internal_error",
    ]);
    // Only codes and patterns: no user, conversation or run ids in the status list, no message field.
    expect(Object.keys(s.recentErrors[0]!).sort()).toEqual([
      "at",
      "category",
      "code",
      "id",
      "route",
      "runtime",
      "source",
      "statusCode",
      "tool",
    ]);
    expect(s.skillFailures).toEqual([
      { tool: "skill_selftest", code: "skill_failed", count: 2, lastAt: expect.any(Number) },
    ]);
    expect(s.disk.totalBytes).toBeGreaterThan(0);
    expect(s.disk.freeBytes).toBeGreaterThan(0);
    expect(s.disk.databaseBytes).toBeNull(); // in-memory database
  });

  it("a failed finance tool call through our MCP server joins the skill failures (dart_disclosures → finance_unconfigured)", async () => {
    // No OPENDART_API_KEY in this app: the DART tool answers finance_unconfigured before any network.
    const t = await start();
    const mcp = t.app.mcp!;
    const { url } = await mcp.endpoint();
    const token = (mcp as unknown as { tokens: McpTokens }).tokens.issue({
      userId: t.f.users.shared.id,
      conversationId: "conv-fin",
      runId: "run-fin",
    });
    const r = await callOurTool(url, token, "dart_disclosures", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("finance_unconfigured");
    const s = SystemStatus.parse((await t.admin.get("/api/admin/system")).json());
    expect(s.skillFailures).toEqual([
      { tool: "dart_disclosures", code: "finance_unconfigured", count: 1, lastAt: expect.any(Number) },
    ]);
    expect(s.recentErrors[0]).toMatchObject({
      source: "tool",
      code: "finance_unconfigured",
      tool: "dart_disclosures",
    });
  });

  it("a failed skill call on our MCP server is recorded with its code (not its output)", async () => {
    const t = await start();
    const host = (
      t.app.mcp as unknown as { host(): { runSkill(n: string, i: object, s: object): Promise<unknown> } }
    ).host();
    await host.runSkill(
      "selftest",
      { text: "비밀 내용" },
      { userId: t.f.users.shared.id, conversationId: "c-1", runId: "r-1" },
    );
    const [e] = t.app.errors!.recent({ source: "tool" });
    expect(e).toMatchObject({ code: "skill_failed", tool: "skill_selftest", userId: t.f.users.shared.id });
    expect(JSON.stringify(t.app.errors!.recent())).not.toContain("비밀");
  });
});

describe("tunnel status: cloudflared's loopback metrics server only (#35)", () => {
  it("accepts loopback IP literals with a port, refuses anything else (config refuses to start)", () => {
    expect(parseMetricsAddress("http://127.0.0.1:20241")).toEqual({ host: "127.0.0.1", port: 20241 });
    expect(parseMetricsAddress("http://127.0.0.2:20241/")).toEqual({ host: "127.0.0.2", port: 20241 });
    expect(parseMetricsAddress("http://[::1]:20241")).toEqual({ host: "::1", port: 20241 });
    expect(parseMetricsAddress("http://127.255.10.1:65535")).toEqual({ host: "127.255.10.1", port: 65535 });
    for (const bad of [
      // Other spellings URL parsing would normalise to 127.0.0.1: checked as written, so refused.
      "http://0x7f000001:20241",
      "http://127.1:20241",
      "http://2130706433:20241",
      "http://0177.0.0.1:20241",
      "http://127.0.0.01:20241",
      "http://127.000.000.001:20241",
      "http://[0:0:0:0:0:0:0:1]:20241",
      "http://127.0.0.256:20241",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:020241",
      "HTTP://127.0.0.1:20241",
      "http://127.0.0.1:20241#x",
      " http://127.0.0.1:20241",
      "http://localhost:20241",
      "http://10.0.0.5:20241",
      "http://192.168.0.1:20241",
      "http://chat.2prostream.com:20241",
      "https://127.0.0.1:20241",
      "http://127.0.0.1",
      "http://127.0.0.1:20241/ready",
      "http://user:pw@127.0.0.1:20241",
      "http://127.0.0.1:20241?x=1",
      "http://[::ffff:10.0.0.1]:20241",
      "127.0.0.1:20241",
    ])
      expect(parseMetricsAddress(bad), bad).toBeUndefined();
    expect(() => loadConfig({ NODE_ENV: "test", CLOUDFLARED_METRICS: "http://10.0.0.5:20241" })).toThrow(
      /CLOUDFLARED_METRICS/,
    );
    expect(
      loadConfig({ NODE_ENV: "test", CLOUDFLARED_METRICS: "http://127.0.0.1:20241" }).tunnelMetrics,
    ).toEqual({
      host: "127.0.0.1",
      port: 20241,
    });
    expect(loadConfig({ NODE_ENV: "test", CLOUDFLARED_METRICS: "" }).tunnelMetrics).toBeUndefined();
  });

  it("reads /ready: connections → ok, none → down, no answer → unreachable; never asks a non-loopback host", async () => {
    let answer = { status: 200, body: '{"status":200,"readyConnections":4,"connectorId":"x"}' };
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    expect(await tunnelStatus({ host: "127.0.0.1", port })).toEqual({ state: "ok", readyConnections: 4 });
    answer = { status: 503, body: '{"status":503,"readyConnections":0}' };
    expect(await tunnelStatus({ host: "127.0.0.1", port })).toEqual({ state: "down", readyConnections: 0 });
    // 200 but not ready.
    answer = { status: 200, body: '{"status":200,"readyConnections":0}' };
    expect(await tunnelStatus({ host: "127.0.0.1", port })).toEqual({ state: "down", readyConnections: 0 });
    // Not cloudflared's answer — some other local service: never "ok".
    for (const body of [
      "",
      "   ",
      "<html>ok</html>",
      "{}",
      '{"readyConnections":"4"}',
      '{"readyConnections":1.5}',
      "null",
      '{"readyConnections":-1}',
    ])
      for (const status of [200, 503]) {
        answer = { status, body };
        expect(await tunnelStatus({ host: "127.0.0.1", port }), `${status} ${body}`).toEqual({
          state: "unreachable",
          readyConnections: null,
        });
      }
    answer = { status: 302, body: '{"readyConnections":4}' };
    expect(await tunnelStatus({ host: "127.0.0.1", port })).toEqual({
      state: "unreachable",
      readyConnections: null,
    });
    // An answer longer than the cap is not read to the end.
    answer = { status: 200, body: `{"readyConnections":4,"pad":"${"x".repeat(5000)}"}` };
    expect(await tunnelStatus({ host: "127.0.0.1", port })).toEqual({
      state: "unreachable",
      readyConnections: null,
    });
    expect(paths.length).toBe(21);
    // A host that is not a loopback IP literal is never asked — not even "localhost" or this machine's name.
    for (const host of ["localhost", os.hostname(), "10.0.0.5", "example.com"])
      expect(await tunnelStatus({ host, port })).toEqual({ state: "unreachable", readyConnections: null });
    expect(paths.length).toBe(21);
    expect(await tunnelStatus(undefined)).toEqual({ state: "unconfigured", readyConnections: null });
    // Closed port.
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    expect(await tunnelStatus({ host: "127.0.0.1", port: closedPort })).toEqual({
      state: "unreachable",
      readyConnections: null,
    });

    // A slow drip (a byte every 40 ms, never ending) is cut off by the overall deadline, not kept alive by it.
    const drip = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"readyConnections":4');
      const t = setInterval(() => res.write(" "), 40);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => drip.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => (drip.closeAllConnections(), drip.close(r))));
    const dripPort = (drip.address() as AddressInfo).port;
    const t0 = Date.now();
    expect(await tunnelStatus({ host: "127.0.0.1", port: dripPort }, { timeoutMs: 200 })).toEqual({
      state: "unreachable",
      readyConnections: null,
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    // A server that accepts and never answers: the same deadline.
    const silent = http.createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => (silent.closeAllConnections(), silent.close(r))));
    const t1 = Date.now();
    expect(
      await tunnelStatus(
        { host: "127.0.0.1", port: (silent.address() as AddressInfo).port },
        { timeoutMs: 200 },
      ),
    ).toEqual({ state: "unreachable", readyConnections: null });
    expect(Date.now() - t1).toBeLessThan(1000);

    // Through the app: CLOUDFLARED_METRICS → the admin's system status.
    answer = { status: 200, body: '{"status":200,"readyConnections":2}' };
    const t = await start({ env: { CLOUDFLARED_METRICS: `http://127.0.0.1:${port}` } });
    expect(SystemStatus.parse((await t.admin.get("/api/admin/system")).json()).tunnel).toEqual({
      state: "ok",
      readyConnections: 2,
    });
  });
});
