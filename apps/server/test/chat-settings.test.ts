import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatSettings,
  Conversation,
  CSRF_HEADER,
  DefaultsResponse,
  Message,
  RuntimeOption,
  StartRunResponse,
  type RuntimeId,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { API_KEY_COOLDOWN_MS, SUBSCRIPTION_COOLDOWN_MS, limitFor } from "../src/connections/service.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { CLAUDE_MODELS } from "../src/runtime/claude.js";
import { CODEX_MODELS } from "../src/runtime/codex.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime, type FakeScript } from "../src/runtime/fake.js";
import { createFamily, PW, type Family } from "./helpers/permission-matrix.js";

/**
 * #19: new conversations start on the defaults with the FR-12.6 fallback, the chip changes a conversation from its
 * next message on, and nothing about a conversation changes when the defaults do (FR-12.5).
 */
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const CLAUDE_KEY = `sk-ant-CHIPTESTFAKE${"c".repeat(24)}`;
const CODEX_KEY = `sk-CHIPTESTFAKE${"x".repeat(24)}`;

async function start(o: { script?: FakeScript } = {}) {
  const runtimes = new RuntimeRegistry();
  const claude = new FakeRuntime({ models: CLAUDE_MODELS, needsConnection: true, ...o });
  const codex = new FakeRuntime({ id: "codex", models: CODEX_MODELS, needsConnection: true, ...o });
  runtimes.register(claude);
  runtimes.register(codex);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-chip-"));
  closers.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir }), {
    db: createTestDb(),
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    notifications: { sender: async () => {} },
    // The connection test's skill check, in process (as in connections.test.ts).
    mcp: {
      runSkill: async (_skill, input) => {
        const text = String(input.text);
        return {
          ok: true,
          output: {
            characters: [...text].length,
            sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
            reversed: [...text].reverse().join(""),
          },
        };
      },
    },
    connectionTest: { timeoutMs: 5000 },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const req = async (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, body?: object) =>
    app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie,
        ...(method === "GET" ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
      },
      ...(method === "GET" ? {} : { payload: body ?? {} }),
    });
  const as = (who: keyof Family["cookies"]) => ({
    get: (url: string) => req(f.cookies[who], "GET", url),
    post: (url: string, body?: object) => req(f.cookies[who], "POST", url, body),
    put: (url: string, body: object) => req(f.cookies[who], "PUT", url, body),
    patch: (url: string, body: object) => req(f.cookies[who], "PATCH", url, body),
  });
  const store = app.connections!.store;
  /** A connection of `runtime`, already `passed` unless `untested` (personal for `owner`, else shared). */
  const connect = (
    runtime: RuntimeId,
    owner: keyof Family["users"] | null,
    o2: { untested?: boolean } = {},
  ) => {
    const c = store.create({
      runtime,
      authType: "api_key",
      scope: owner ? "personal" : "shared",
      owner: owner ? f.users[owner] : null,
      createdBy: f.users.admin.id,
      secret: runtime === "codex" ? CODEX_KEY : CLAUDE_KEY,
    });
    if (!o2.untested) store.setTestResult(c.id, "passed", "ok", 1);
    return c;
  };
  const owner = as("owner");
  const ownerId = f.users.owner.id;
  const policy = (
    runtime: RuntimeId,
    p: { allowed?: boolean; models?: "all" | string[]; efforts?: "all" | string[] },
  ) =>
    app.connections!.store.setPolicy(ownerId, {
      runtime,
      allowed: p.allowed ?? true,
      models: p.models ?? "all",
      efforts: p.efforts ?? "all",
      allowPersonal: true,
      allowShared: true,
    });
  const newConversation = async (body: object = {}) => {
    const r = await owner.post("/api/conversations", body);
    expect(r.statusCode).toBe(201);
    return Conversation.parse(r.json());
  };
  const getConversation = async (id: string) =>
    Conversation.parse((await owner.get(`/api/conversations/${id}`)).json());
  const settle = async (runId: string) => {
    for (let i = 0; i < 400; i++) {
      const r = app.runs!.get(runId);
      if (r?.endedAt) return r;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("run did not end");
  };
  /** Sends a message and waits for the reply; returns the run. */
  const send = async (conversationId: string, text = "안녕", extra: object = {}) => {
    const r = await owner.post(`/api/conversations/${conversationId}/messages`, { text, ...extra });
    expect(r.statusCode).toBe(201);
    return settle(StartRunResponse.parse(r.json()).run.id);
  };
  const messages = async (conversationId: string) =>
    Message.array().parse(
      (await owner.get(`/api/conversations/${conversationId}/messages`)).json<{ items: unknown }>().items,
    );
  const setDefaults = async (defaults: object | null) => owner.put("/api/settings/defaults", { defaults });
  return {
    as,
    app,
    f,
    owner,
    ownerId,
    connect,
    policy,
    newConversation,
    getConversation,
    send,
    settle,
    messages,
    setDefaults,
    claude,
    codex,
  };
}

type T = Awaited<ReturnType<typeof start>>;
const codexDefault = (model: string, effort: string | null = null) => ({
  runtime: "codex",
  models: { codex: { model, effort } },
});

describe("new conversations start on the defaults without a picking step (FR-3.5, acceptance 7)", () => {
  it("a user with nothing set gets Claude Code · Opus 5.5; a saved default is used as soon as it is saved", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", "owner");
    const first = await t.newConversation();
    expect(first.settings).toEqual({
      runtime: "claude-code",
      model: "claude-opus-5-5",
      effort: "high",
      useShared: false,
    });
    expect(first.fallbackNotice).toBeNull();
    const run = await t.send(first.id);
    expect(run).toMatchObject({
      status: "done",
      runtime: "claude-code",
      model: "claude-opus-5-5",
      effort: "high",
    });

    expect((await t.setDefaults(codexDefault("gpt-6-astra", "medium"))).statusCode).toBe(200);
    const second = await t.newConversation();
    expect(second.settings).toMatchObject({ runtime: "codex", model: "gpt-6-astra", effort: "medium" });
    expect(await t.send(second.id)).toMatchObject({
      runtime: "codex",
      model: "gpt-6-astra",
      effort: "medium",
    });
    // The message says who answered (FR-3.5) and the first reply has no divider.
    const ms = await t.messages(second.id);
    expect(ms.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(ms[1]).toMatchObject({ runtime: "codex", model: "gpt-6-astra" });
  });

  it("the admin's initial value is used while the user has none of their own (FR-12.4)", async () => {
    const t = await start();
    t.connect("claude-code", null);
    const r = await t.app.inject({
      method: "PUT",
      url: `/api/admin/users/${t.ownerId}/defaults`,
      headers: {
        host: "localhost:3000",
        cookie: t.f.cookies.admin,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
      },
      payload: {
        defaults: {
          runtime: "claude-code",
          models: { "claude-code": { model: "claude-sonnet-5-5", effort: "low" } },
        },
      },
    });
    expect(r.statusCode).toBe(200);
    expect((await t.newConversation()).settings).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
  });
});

describe("FR-12.6 fallback order when the default cannot be used", () => {
  const sonnet = {
    runtime: "claude-code",
    models: {
      "claude-code": { model: "claude-sonnet-5-5", effort: "medium" },
      codex: { model: "gpt-6-luna", effort: "high" },
    },
  };

  it("1. the same runtime's first allowed model in the model-list order, with the notice", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    expect((await t.setDefaults(sonnet)).statusCode).toBe(200);
    // The admin takes Sonnet away (and Opus): Haiku is the first allowed Claude model left.
    t.policy("claude-code", { models: ["claude-haiku-5-5"] });
    const c = await t.newConversation();
    expect(c.settings).toMatchObject({ runtime: "claude-code", model: "claude-haiku-5-5", effort: "low" });
    expect(c.fallbackNotice).toEqual({ runtime: "claude-code", model: "claude-haiku-5-5" });
    t.policy("claude-code", { models: ["claude-opus-5-5", "claude-haiku-5-5"] });
    expect((await t.newConversation()).settings).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("2. then the other runtime with the user's default model there, else its first allowed model", async () => {
    const t = await start();
    t.connect("codex", "owner");
    expect((await t.setDefaults(sonnet)).statusCode).toBe(200);
    // No Claude connection at all: Codex with the user's Codex default (GPT-6 Luna, high).
    const c = await t.newConversation();
    expect(c.settings).toEqual({ runtime: "codex", model: "gpt-6-luna", effort: "high", useShared: false });
    expect(c.fallbackNotice).toEqual({ runtime: "codex", model: "gpt-6-luna" });
    expect(await t.send(c.id)).toMatchObject({ runtime: "codex", model: "gpt-6-luna" });
    // Luna not allowed for him: Codex's first allowed model.
    t.policy("codex", { models: ["gpt-6-astra"] });
    expect((await t.newConversation()).settings).toMatchObject({
      runtime: "codex",
      model: "gpt-6-astra",
      effort: "low",
    });
  });

  it("a Codex default falls back to Claude Code (Claude Code → Codex order), with the user's Claude default", async () => {
    const t = await start();
    t.connect("claude-code", "owner");
    const codexCon = t.connect("codex", "owner");
    expect(
      (
        await t.setDefaults({
          runtime: "codex",
          models: {
            codex: { model: "gpt-6-luna", effort: null },
            "claude-code": { model: "claude-haiku-5-5", effort: null },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect((await t.newConversation()).settings).toMatchObject({ runtime: "codex", model: "gpt-6-luna" });
    t.app.connections!.store.disconnect(codexCon.id);
    const c = await t.newConversation();
    expect(c.settings).toMatchObject({ runtime: "claude-code", model: "claude-haiku-5-5" });
    expect(c.fallbackNotice).not.toBeNull();
  });

  it("an untested connection, or someone else's, does not count; nothing usable → no settings and the notice-less 'no runtime' start", async () => {
    const t = await start();
    t.connect("claude-code", null, { untested: true });
    t.connect("codex", "shared"); // mom's personal one
    const d = DefaultsResponse.parse((await t.owner.get("/api/settings/defaults")).json());
    expect(d).toMatchObject({ source: "service", start: null, fallback: false });
    const c = await t.newConversation();
    expect(c.settings).toBeNull();
    expect(c.fallbackNotice).toBeNull();
    // Sending anyway fails without a connection (nothing silently picks someone else's).
    expect((await t.send(c.id)).errorCode).toBe("no_connection");
  });

  it("only the default effort being forbidden is not a fallback: same model, an allowed effort, no notice", async () => {
    const t = await start();
    t.connect("claude-code", null);
    expect(
      (
        await t.setDefaults({
          runtime: "claude-code",
          models: { "claude-code": { model: "claude-opus-5-5", effort: "max" } },
        })
      ).statusCode,
    ).toBe(200);
    t.policy("claude-code", { efforts: ["low", "medium"] });
    const c = await t.newConversation();
    expect(c.settings).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
    expect(c.fallbackNotice).toBeNull();
  });

  it("the settings screen says what new conversations start with (FR-12.6 notice)", async () => {
    const t = await start();
    t.connect("codex", null);
    const d = DefaultsResponse.parse((await t.owner.get("/api/settings/defaults")).json());
    expect(d).toMatchObject({
      source: "service",
      fallback: true,
      start: { runtime: "codex", model: "gpt-6.1-sol" },
    });
  });
});

describe("the fallback notice is shown once", () => {
  const consume = (t: T, id: string, who: "owner" | "stranger" = "owner") =>
    t.app.inject({
      method: "POST",
      url: `/api/conversations/${id}/fallback-notice/consume`,
      headers: {
        host: "localhost:3000",
        cookie: t.f.cookies[who],
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
      },
      payload: {},
    });

  it("is handed out once by consume — never again; a new start brings its own", async () => {
    const t = await start();
    t.connect("codex", null);
    const c = await t.newConversation();
    expect(c.fallbackNotice).toEqual({ runtime: "codex", model: "gpt-6.1-sol" });
    // Sending or reading does not consume it.
    await t.send(c.id);
    expect((await t.getConversation(c.id)).fallbackNotice).not.toBeNull();
    const r = await consume(t, c.id);
    expect([r.statusCode, r.json()]).toEqual([200, { notice: { runtime: "codex", model: "gpt-6.1-sol" } }]);
    expect((await consume(t, c.id)).json()).toEqual({ notice: null });
    expect((await t.getConversation(c.id)).fallbackNotice).toBeNull();
    await t.send(c.id, "또");
    expect((await t.getConversation(c.id)).fallbackNotice).toBeNull();
    // A chip change ends a pending notice too: the chip shows the user's own choice now.
    const other = await t.newConversation();
    expect(other.fallbackNotice).not.toBeNull();
    await t.owner.put(`/api/conversations/${other.id}/settings`, { model: "gpt-6-astra" });
    expect((await consume(t, other.id)).json()).toEqual({ notice: null });
    // Without a fallback there is no notice.
    t.connect("claude-code", null);
    expect((await t.newConversation()).fallbackNotice).toBeNull();
  });

  it("two tabs consuming at once: exactly one gets it", async () => {
    const t = await start();
    t.connect("codex", null);
    for (let round = 0; round < 5; round++) {
      const c = await t.newConversation();
      const all = await Promise.all([consume(t, c.id), consume(t, c.id), consume(t, c.id)]);
      const got = all.map((r) => r.json<{ notice: unknown }>().notice).filter((n) => n !== null);
      expect(got).toHaveLength(1);
    }
  });

  it("a consume that fails takes nothing: the notice is still there for the next page", async () => {
    const t = await start();
    t.connect("codex", null);
    const c = await t.newConversation();
    // Refused (someone else's conversation, a bad CSRF header) → nothing consumed.
    expect((await consume(t, c.id, "stranger")).statusCode).toBe(403);
    const noCsrf = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${c.id}/fallback-notice/consume`,
      headers: { host: "localhost:3000", cookie: t.f.cookies.owner },
      payload: {},
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.getConversation(c.id)).fallbackNotice).not.toBeNull();
    expect((await consume(t, c.id)).json<{ notice: unknown }>().notice).not.toBeNull();
  });

  it("a conversation without settings resolves them on its first message (notice included)", async () => {
    const t = await start();
    const c = await t.newConversation();
    expect(c.settings).toBeNull();
    t.connect("codex", null);
    const run = await t.send(c.id);
    expect(run).toMatchObject({ status: "done", runtime: "codex", model: "gpt-6.1-sol" });
    expect(await t.getConversation(c.id)).toMatchObject({
      settings: { runtime: "codex", model: "gpt-6.1-sol" },
      fallbackNotice: { runtime: "codex", model: "gpt-6.1-sol" },
    });
  });
});

describe("the chip lists only what can answer now (allowed + passed)", () => {
  const listed = async (t: T) =>
    RuntimeOption.array()
      .parse((await t.owner.get("/api/runtimes/usable")).json<{ items: unknown }>().items)
      .map((o) => ({
        runtime: o.runtime,
        models: o.models.map((m) => m.id),
        connections: o.connections.map((c) => c.scope),
      }));

  it("filters runtimes without a passed connection the user may use, and models / efforts not allowed", async () => {
    const t = await start();
    expect(await listed(t)).toEqual([]);
    t.connect("codex", "owner", { untested: true });
    t.connect("codex", "shared"); // someone else's
    expect(await listed(t)).toEqual([]);
    // The settings screen still offers both (a default may name a runtime not connected yet).
    expect(
      RuntimeOption.array()
        .parse((await t.owner.get("/api/runtimes")).json<{ items: unknown }>().items)
        .map((o) => o.runtime),
    ).toEqual(["claude-code", "codex"]);
    t.connect("claude-code", null);
    t.connect("claude-code", "owner");
    t.policy("claude-code", { models: ["claude-sonnet-5-5"], efforts: ["low", "high"] });
    const items = RuntimeOption.array().parse(
      (await t.owner.get("/api/runtimes/usable")).json<{ items: unknown }>().items,
    );
    expect(items.map((o) => o.runtime)).toEqual(["claude-code"]);
    expect(items[0]!.models).toEqual([
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "high"], defaultEffort: null },
    ]);
    // Personal first, then shared: the chip offers "공용으로 쓰기".
    expect(items[0]!.connections.map((c) => c.scope)).toEqual(["personal", "shared"]);
    // A runtime the admin did not allow is not there even with a connection.
    t.connect("codex", null);
    expect((await listed(t)).map((o) => o.runtime)).toEqual(["claude-code", "codex"]);
    t.policy("codex", { allowed: false });
    expect((await listed(t)).map((o) => o.runtime)).toEqual(["claude-code"]);
  });
});

describe("the chip changes a conversation from its next message on (FR-3.5, FR-12.3)", () => {
  it("runtime only → that runtime's default model; model only → that model's default effort", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation();
    const change = async (body: object) => {
      const r = await t.owner.put(`/api/conversations/${c.id}/settings`, body);
      expect(r.statusCode).toBe(200);
      return Conversation.parse(r.json()).settings;
    };
    // No Codex default saved: its first allowed model.
    expect(await change({ runtime: "codex" })).toEqual({
      runtime: "codex",
      model: "gpt-6.1-sol",
      effort: "low",
      useShared: false,
    });
    await t.setDefaults({
      runtime: "claude-code",
      models: {
        "claude-code": { model: "claude-opus-5-5", effort: null },
        codex: { model: "gpt-6-luna", effort: "high" },
      },
    });
    expect(await change({ runtime: "claude-code" })).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
    });
    // With a saved Codex default: it follows, with its effort.
    expect(await change({ runtime: "codex" })).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    expect(await change({ model: "gpt-6-astra" })).toMatchObject({ model: "gpt-6-astra", effort: "low" });
    expect(await change({ effort: "xhigh" })).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    // The same model again keeps the chosen effort; the saved default model brings back its saved effort.
    expect(await change({ model: "gpt-6-astra" })).toMatchObject({ effort: "xhigh" });
    expect(await change({ model: "gpt-6-luna" })).toMatchObject({ effort: "high" });
    // Defaults themselves are not changed by the chip (FR-3.5).
    const d = DefaultsResponse.parse((await t.owner.get("/api/settings/defaults")).json());
    expect(d.defaults.runtime).toBe("claude-code");
  });

  it("not allowed → 403 with the run check's code, nothing changed: effort, model, runtime, connection", async () => {
    const t = await start();
    t.connect("claude-code", "owner");
    const c = await t.newConversation();
    const before = c.settings;
    const refused = async (body: object, code: string) => {
      const r = await t.owner.put(`/api/conversations/${c.id}/settings`, body);
      expect([r.statusCode, r.json()]).toEqual([403, { error: code }]);
    };
    // An effort the model does not take (Haiku has no xhigh), and one the admin did not allow.
    await refused({ model: "claude-haiku-5-5", effort: "xhigh" }, "effort_not_allowed");
    t.policy("claude-code", { efforts: ["low", "medium"] });
    await refused({ effort: "high" }, "effort_not_allowed");
    await refused({ model: "claude-opus-5-5", effort: "max" }, "effort_not_allowed");
    await refused({ model: "claude-nonexistent" }, "model_not_allowed");
    t.policy("claude-code", { models: ["claude-haiku-5-5"] });
    await refused({ model: "claude-opus-5-5" }, "model_not_allowed");
    // Codex: no connection for him → not usable; not allowed at all → runtime_not_allowed.
    await refused({ runtime: "codex" }, "connection_not_allowed");
    t.policy("codex", { allowed: false });
    await refused({ runtime: "codex" }, "runtime_not_allowed");
    // "공용으로 쓰기" without a shared connection.
    t.policy("claude-code", {});
    await refused({ useShared: true }, "connection_not_allowed");
    expect((await t.getConversation(c.id)).settings).toEqual(before);
    // The same codes on a send with an explicit effort (#17), and an empty change is a bad request.
    t.policy("claude-code", { efforts: ["low"] });
    const r = await t.owner.post(`/api/conversations/${c.id}/messages`, { text: "x", effort: "high" });
    expect([r.statusCode, r.json()]).toEqual([403, { error: "effort_not_allowed" }]);
    expect((await t.owner.put(`/api/conversations/${c.id}/settings`, {})).statusCode).toBe(400);
  });

  it("someone else's conversation: 403 forbidden even with a choice that would be valid for them, nothing changed", async () => {
    const t = await start();
    // Shared connections: the stranger may use Codex · GPT-6 Luna in his own conversations.
    t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation();
    const as = (who: "stranger" | "shared" | "admin") =>
      t.app.inject({
        method: "PUT",
        url: `/api/conversations/${c.id}/settings`,
        headers: {
          host: "localhost:3000",
          cookie: t.f.cookies[who],
          origin: "http://localhost:3000",
          [CSRF_HEADER]: "1",
        },
        payload: { runtime: "codex", model: "gpt-6-luna" },
      });
    // Valid for him: his own conversation takes exactly this change.
    const own = await t.app.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        host: "localhost:3000",
        cookie: t.f.cookies.stranger,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
      },
      payload: { settings: { runtime: "codex", model: "gpt-6-luna" } },
    });
    expect(own.statusCode).toBe(201);
    for (const who of ["stranger", "shared", "admin"] as const) {
      const r = await as(who);
      expect([who, r.statusCode, r.json()]).toEqual([who, 403, { error: "forbidden" }]);
    }
    expect((await t.getConversation(c.id)).settings).toEqual(c.settings);
  });

  it("a reply being written keeps its settings; the next one uses the new ones, after a divider", async () => {
    // Replies take a moment, so the change lands while one is being written.
    const t = await start({ script: (input) => [{ delayMs: 80 }, { text: `ok ${input.text}` }] });
    t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation();
    const r = await t.owner.post(`/api/conversations/${c.id}/messages`, { text: "첫 질문" });
    const firstRun = StartRunResponse.parse(r.json()).run;
    const changed = await t.owner.put(`/api/conversations/${c.id}/settings`, {
      runtime: "codex",
      model: "gpt-6-luna",
    });
    expect(changed.statusCode).toBe(200);
    for (let i = 0; i < 400 && !t.app.runs!.get(firstRun.id)!.endedAt; i++)
      await new Promise((res) => setTimeout(res, 5));
    expect(t.app.runs!.get(firstRun.id)).toMatchObject({
      status: "done",
      runtime: "claude-code",
      model: "claude-opus-5-5",
    });
    expect(await t.send(c.id, "둘째 질문")).toMatchObject({ runtime: "codex", model: "gpt-6-luna" });
    const ms = await t.messages(c.id);
    expect(ms.map((m) => `${m.role}:${m.runtime ?? "-"}/${m.model ?? "-"}`)).toEqual([
      "user:-/-",
      "assistant:claude-code/claude-opus-5-5",
      "system:-/-",
      "user:-/-",
      "assistant:codex/gpt-6-luna",
    ]);
    expect(ms[2]!.parts).toEqual([
      {
        type: "divider",
        kind: "runtime_switch",
        label: "여기부터 Codex · GPT-6 Luna",
        runtime: "codex",
        model: "gpt-6-luna",
      },
    ]);
    // A third message on the same settings: no new divider. An effort change: one.
    await t.send(c.id, "셋째");
    expect((await t.messages(c.id)).filter((m) => m.role === "system")).toHaveLength(1);
    await t.owner.put(`/api/conversations/${c.id}/settings`, { effort: "low" });
    await t.send(c.id, "넷째");
    const dividers = (await t.messages(c.id)).filter((m) => m.role === "system");
    expect(dividers).toHaveLength(2);
    expect(dividers[1]!.parts[0]).toMatchObject({ label: "여기부터 Codex · GPT-6 Luna · 추론 low" });
  });

  it("regenerating a reply after a switch keeps one divider (review #101: it became two)", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation();
    await t.send(c.id, "첫");
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "codex" });
    await t.send(c.id, "둘째");
    const shape = async () => (await t.messages(c.id)).map((m) => `${m.role}:${m.runtime ?? "-"}`);
    expect(await shape()).toEqual([
      "user:-",
      "assistant:claude-code",
      "system:-",
      "user:-",
      "assistant:codex",
    ]);
    for (let i = 0; i < 2; i++) {
      const last = (await t.messages(c.id)).at(-1)!;
      const r = await t.owner.post(`/api/conversations/${c.id}/messages/${last.id}/regenerate`, {});
      expect(r.statusCode).toBe(200);
      await t.settle(StartRunResponse.parse(r.json()).run.id);
      expect(await shape()).toEqual([
        "user:-",
        "assistant:claude-code",
        "system:-",
        "user:-",
        "assistant:codex",
      ]);
    }
    // Switched back to Claude: regenerating drops the Codex divider (Claude answered right before).
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "claude-code" });
    const last = (await t.messages(c.id)).at(-1)!;
    const r = await t.owner.post(`/api/conversations/${c.id}/messages/${last.id}/regenerate`, {});
    await t.settle(StartRunResponse.parse(r.json()).run.id);
    expect(await shape()).toEqual(["user:-", "assistant:claude-code", "user:-", "assistant:claude-code"]);
  });

  it("editing the switching message after switching back drops the stale divider (review #101)", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation();
    await t.send(c.id, "첫");
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "codex" });
    await t.send(c.id, "둘째");
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "claude-code" });
    const second = (await t.messages(c.id)).filter((m) => m.role === "user").at(-1)!;
    const r = await t.owner.post(`/api/conversations/${c.id}/messages/${second.id}/edit`, {
      text: "고친 둘째",
    });
    expect(r.statusCode).toBe(200);
    await t.settle(StartRunResponse.parse(r.json()).run.id);
    const ms = await t.messages(c.id);
    expect(ms.map((m) => `${m.role}:${m.runtime ?? "-"}`)).toEqual([
      "user:-",
      "assistant:claude-code",
      "user:-",
      "assistant:claude-code",
    ]);
    // Editing it again on Codex: exactly one Codex divider, before the edited message.
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "codex" });
    const edited = (await t.messages(c.id)).filter((m) => m.role === "user").at(-1)!;
    const r2 = await t.owner.post(`/api/conversations/${c.id}/messages/${edited.id}/edit`, {
      text: "다시 고침",
    });
    await t.settle(StartRunResponse.parse(r2.json()).run.id);
    expect((await t.messages(c.id)).map((m) => `${m.role}:${m.runtime ?? "-"}`)).toEqual([
      "user:-",
      "assistant:claude-code",
      "system:-",
      "user:-",
      "assistant:codex",
    ]);
  });

  it("a change undone before sending leaves no divider; regenerating after a change answers with the new one", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation();
    await t.send(c.id);
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "codex" });
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "claude-code" });
    await t.send(c.id, "또");
    expect((await t.messages(c.id)).some((m) => m.role === "system")).toBe(false);
    // "다른 런타임으로 이어가기": switch, then regenerate the last reply — it is answered by Codex, after a divider.
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "codex" });
    const last = (await t.messages(c.id)).at(-1)!;
    const r = await t.owner.post(`/api/conversations/${c.id}/messages/${last.id}/regenerate`, {});
    expect(r.statusCode).toBe(200);
    const run = StartRunResponse.parse(r.json()).run;
    expect(run).toMatchObject({ runtime: "codex", model: "gpt-6.1-sol" });
    const ms = await t.messages(c.id);
    expect(ms.slice(-3).map((m) => m.role)).toEqual(["user", "system", "assistant"]);
  });

  it("공용으로 쓰기: the next reply runs on the shared connection; another runtime starts on the personal one again", async () => {
    const t = await start();
    const mine = t.connect("claude-code", "owner");
    const shared = t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation();
    expect((await t.send(c.id)).connectionId).toBe(mine.id);
    const r = await t.owner.put(`/api/conversations/${c.id}/settings`, { useShared: true });
    expect(Conversation.parse(r.json()).settings).toMatchObject({ useShared: true });
    expect((await t.send(c.id, "공용")).connectionId).toBe(shared.id);
    const r2 = await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "codex" });
    expect(Conversation.parse(r2.json()).settings).toMatchObject({ runtime: "codex", useShared: false });
  });

  it("a choice made on the new-conversation screen is checked at creation (403 when not allowed)", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation({ settings: { runtime: "codex", model: "gpt-6-luna", effort: "max" } });
    expect(c.settings).toEqual({ runtime: "codex", model: "gpt-6-luna", effort: "max", useShared: false });
    expect(c.fallbackNotice).toBeNull();
    const bad = await t.owner.post("/api/conversations", {
      settings: { runtime: "codex", model: "gpt-6-luna", effort: "ultra" },
    });
    expect([bad.statusCode, bad.json()]).toEqual([403, { error: "effort_not_allowed" }]);
  });
});

describe("changing the defaults never changes an existing conversation (FR-12.5)", () => {
  it("keeps its runtime, model and effort — for the settings and for the next reply", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    const old = await t.newConversation();
    await t.send(old.id);
    const empty = await t.newConversation(); // not answered yet: still fixed at creation
    expect((await t.setDefaults(codexDefault("gpt-6-luna", "max"))).statusCode).toBe(200);
    for (const c of [old, empty]) {
      expect((await t.getConversation(c.id)).settings).toEqual(c.settings);
      expect(await t.send(c.id, "기본값 바꾼 뒤")).toMatchObject({
        runtime: "claude-code",
        model: "claude-opus-5-5",
        effort: "high",
      });
    }
    // Only new conversations get the new default.
    expect((await t.newConversation()).settings).toMatchObject({
      runtime: "codex",
      model: "gpt-6-luna",
      effort: "max",
    });
    // Clearing the own defaults later does not touch them either.
    await t.setDefaults(null);
    expect((await t.getConversation(old.id)).settings).toEqual(old.settings);
  });
});

describe("a usage limit is an FR-12.6 fallback condition (reviews #101 1·2)", () => {
  /** Replies by message: limits of each kind, a slow reply, else "ok". */
  const script: FakeScript = (input) =>
    input.text === "429"
      ? [{ limit: "한도" }]
      : input.text === "429-retry"
        ? [{ limit: "한도", retryAfterMs: 5 * 60_000 }]
        : input.text === "opus-window"
          ? [{ limit: "한도", modelFamily: "opus" }]
          : input.text === "plan-window"
            ? [{ limit: "한도" }]
            : input.text === "느리게"
              ? [{ delayMs: 150 }, { text: "ok" }]
              : [{ text: "ok" }];
  const SUB_TOKEN = `admin-claude-subscription-token-${"t".repeat(20)}`;
  /** The admin's own Claude subscription (only an admin may have one, D2), passed. */
  const subscription = (t: T) => {
    const store = t.app.connections!.store;
    const c = store.create({
      runtime: "claude-code",
      authType: "subscription",
      scope: "personal",
      owner: t.f.users.admin,
      createdBy: t.f.users.admin.id,
      secret: SUB_TOKEN,
    });
    store.setTestResult(c.id, "passed", "ok", 1);
    return c;
  };
  const runAs = async (
    t: T,
    who: "owner" | "shared" | "admin",
    conversationId: string,
    text: string,
    extra = {},
  ) => {
    const r = await t.as(who).post(`/api/conversations/${conversationId}/messages`, { text, ...extra });
    expect(r.statusCode).toBe(201);
    return t.settle(StartRunResponse.parse(r.json()).run.id);
  };
  const newAs = async (t: T, who: "owner" | "shared" | "admin", body: object = {}) =>
    Conversation.parse((await t.as(who).post("/api/conversations", body)).json());
  const limitRows = (t: T, id: string) =>
    t.app.connections!.store.limits(id).sort((a, b) => a.scope.localeCompare(b.scope));

  it("API key: a 429 limits only its model, for a minute (or the provider's retry-after) — not the whole family's key", async () => {
    const t = await start({ script });
    const key = t.connect("claude-code", null); // the shared key
    t.connect("codex", null);
    const c = await t.newConversation();
    const before = Date.now();
    expect((await t.send(c.id, "429")).errorCode).toBe("usage_limit");
    const [l] = limitRows(t, key.id);
    expect(l!.scope).toBe("model:claude-opus-5-5");
    expect(l!.until).toBeGreaterThanOrEqual(before + API_KEY_COOLDOWN_MS);
    expect(l!.until).toBeLessThanOrEqual(Date.now() + API_KEY_COOLDOWN_MS);
    // Mom (same shared key, nothing set → Opus): Claude stays, on its next usable model; the notice names the cause.
    const mom = await newAs(t, "shared");
    expect(mom.settings).toMatchObject({ runtime: "claude-code", model: "claude-sonnet-5-5" });
    expect(mom.fallbackNotice).toEqual({
      runtime: "claude-code",
      model: "claude-sonnet-5-5",
      limitedUntil: l!.until,
    });
    // The provider's retry-after is used instead when it gave one.
    const c2 = await t.newConversation({ settings: { runtime: "claude-code", model: "claude-haiku-5-5" } });
    const at = Date.now();
    await t.send(c2.id, "429-retry");
    const haiku = limitRows(t, key.id).find((x) => x.scope === "model:claude-haiku-5-5")!;
    expect(haiku.until).toBeGreaterThanOrEqual(at + 5 * 60_000);
    expect(haiku.until).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    // The minute passes: Opus again for everyone.
    t.app.connections!.store.recordLimit(key.id, "model:claude-opus-5-5", Date.now() - 1, Date.now() - 2);
    expect((await newAs(t, "shared")).settings).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("subscription: a plan window without a reset time limits the whole connection for five hours", async () => {
    const t = await start({ script });
    const sub = subscription(t);
    t.connect("codex", null);
    const c = await newAs(t, "admin");
    expect(c.settings).toMatchObject({ runtime: "claude-code", model: "claude-opus-5-5" });
    const before = Date.now();
    expect((await runAs(t, "admin", c.id, "plan-window")).connectionId).toBe(sub.id);
    const [l] = limitRows(t, sub.id);
    expect(l!.scope).toBe("all");
    expect(l!.until).toBeGreaterThanOrEqual(before + SUBSCRIPTION_COOLDOWN_MS);
    const n = await newAs(t, "admin");
    expect(n.settings).toMatchObject({ runtime: "codex" });
    expect(n.fallbackNotice).toMatchObject({ runtime: "codex", limitedUntil: l!.until });
    const d = DefaultsResponse.parse((await t.as("admin").get("/api/settings/defaults")).json());
    expect(d).toMatchObject({ fallback: true, limitedUntil: l!.until, start: { runtime: "codex" } });
    // The chip refuses moving onto it (any model); tuning the effort of a conversation already on it is fine.
    const move = await t.as("admin").put(`/api/conversations/${n.id}/settings`, { runtime: "claude-code" });
    expect([move.statusCode, move.json()]).toEqual([403, { error: "connection_limited" }]);
    expect(
      (await t.as("admin").put(`/api/conversations/${c.id}/settings`, { effort: "low" })).statusCode,
    ).toBe(200);
    // The usable list carries the limit for the chip.
    const usable = RuntimeOption.array().parse(
      (await t.as("admin").get("/api/runtimes/usable")).json<{ items: unknown }>().items,
    );
    expect(usable.find((o) => o.runtime === "claude-code")!.connections[0]!.limits).toEqual([
      { scope: "all", until: l!.until },
    ]);
  });

  it("an Opus-only window leaves Sonnet usable; a Sonnet success does not end it", async () => {
    const t = await start({ script });
    const sub = subscription(t);
    t.connect("codex", null);
    const c = await newAs(t, "admin");
    await runAs(t, "admin", c.id, "opus-window");
    expect(limitRows(t, sub.id).map((l) => l.scope)).toEqual(["family:opus"]);
    // Nothing set (Opus): same runtime, Sonnet — with the cause in the notice.
    const n = await newAs(t, "admin");
    expect(n.settings).toMatchObject({ runtime: "claude-code", model: "claude-sonnet-5-5" });
    expect(n.fallbackNotice).toMatchObject({ model: "claude-sonnet-5-5", limitedUntil: expect.any(Number) });
    // A Sonnet default stays exactly as it is (no fallback, no notice).
    await t.as("admin").put("/api/settings/defaults", {
      defaults: {
        runtime: "claude-code",
        models: { "claude-code": { model: "claude-sonnet-5-5", effort: null } },
      },
    });
    const s = await newAs(t, "admin");
    expect(s).toMatchObject({ settings: { model: "claude-sonnet-5-5" }, fallbackNotice: null });
    // The chip: Sonnet → Opus is refused while the window lasts.
    const toOpus = await t
      .as("admin")
      .put(`/api/conversations/${s.id}/settings`, { model: "claude-opus-5-5" });
    expect([toOpus.statusCode, toOpus.json()]).toEqual([403, { error: "connection_limited" }]);
    // A finished Sonnet reply proves nothing about Opus.
    expect(await runAs(t, "admin", s.id, "안녕")).toMatchObject({
      status: "done",
      model: "claude-sonnet-5-5",
    });
    expect(limitRows(t, sub.id).map((l) => l.scope)).toEqual(["family:opus"]);
    // An Opus reply started after the limit (the conversation already on Opus) does.
    expect(await runAs(t, "admin", c.id, "다시")).toMatchObject({ status: "done", model: "claude-opus-5-5" });
    expect(limitRows(t, sub.id)).toEqual([]);
  });

  it("a reply that started before the limit and finishes after it does not end it (review #101 3)", async () => {
    const t = await start({ script });
    const sub = subscription(t);
    t.connect("codex", null);
    const a = await newAs(t, "admin");
    const b = await newAs(t, "admin");
    // A starts first and takes a while; B hits the plan window meanwhile; then A finishes.
    const ra = await t.as("admin").post(`/api/conversations/${a.id}/messages`, { text: "느리게" });
    const runA = StartRunResponse.parse(ra.json()).run;
    await new Promise((r) => setTimeout(r, 10));
    expect((await runAs(t, "admin", b.id, "plan-window")).errorCode).toBe("usage_limit");
    expect(await t.settle(runA.id)).toMatchObject({ status: "done", connectionId: sub.id });
    expect(limitRows(t, sub.id).map((l) => l.scope)).toEqual(["all"]);
    expect((await newAs(t, "admin")).settings).toMatchObject({ runtime: "codex" });
    // A reply started after it (picked by hand) does.
    await new Promise((r) => setTimeout(r, 2));
    expect(await runAs(t, "admin", a.id, "안녕")).toMatchObject({ status: "done" });
    expect(limitRows(t, sub.id)).toEqual([]);
  });

  it("clearing: only evidence after the limit, on a model it covers; a new credential ends every limit", () => {
    return (async () => {
      const t = await start();
      const key = t.connect("claude-code", null);
      const store = t.app.connections!.store;
      const now = Date.now();
      store.recordLimit(key.id, "family:opus", now + 60_000, now);
      store.recordLimit(key.id, "model:claude-haiku-5-5", now + 60_000, now);
      store.clearLimits(key.id, { model: "claude-opus-5-5", startedAt: now }); // same moment: not after
      store.clearLimits(key.id, { model: "claude-sonnet-5-5", startedAt: now + 1 }); // another model
      expect(limitRows(t, key.id).map((l) => l.scope)).toEqual(["family:opus", "model:claude-haiku-5-5"]);
      store.clearLimits(key.id, { model: "claude-opus-5-5", startedAt: now + 1 });
      expect(limitRows(t, key.id).map((l) => l.scope)).toEqual(["model:claude-haiku-5-5"]);
      store.update(key.id, { secret: `sk-ant-NEWKEYFAKE${"n".repeat(24)}` });
      expect(limitRows(t, key.id)).toEqual([]);
    })();
  });

  it("a passed connection test ends the limits on its model recorded before it started — not others", async () => {
    const t = await start();
    const mine = t.connect("claude-code", "owner");
    const store = t.app.connections!.store;
    const now = Date.now();
    // The test runs on the smallest allowed model (Haiku).
    store.recordLimit(mine.id, "model:claude-haiku-5-5", now + 60_000, now - 1_000);
    store.recordLimit(mine.id, "family:opus", now + 60_000, now - 1_000);
    const r = await t.owner.post(`/api/connections/${mine.id}/test`, {});
    expect(r.json()).toMatchObject({ result: { status: "passed" } });
    expect(limitRows(t, mine.id).map((l) => l.scope)).toEqual(["family:opus"]);
  });

  it("new-conversation chip: Claude picked while Opus is limited → the server's preview says Sonnet; the send works (review #101 3차)", async () => {
    const t = await start({ script });
    const sub = subscription(t);
    t.connect("codex", null);
    await t.as("admin").put("/api/settings/defaults", {
      defaults: { runtime: "codex", models: { codex: { model: "gpt-6-luna", effort: null } } },
    });
    t.app.connections!.store.recordLimit(sub.id, "family:opus", Date.now() + 3_600_000, Date.now() - 1);
    const d = DefaultsResponse.parse((await t.as("admin").get("/api/settings/defaults")).json());
    expect(d.start).toMatchObject({ runtime: "codex", model: "gpt-6-luna" });
    const preview = (change: object, base: unknown = d.start) =>
      t.as("admin").post("/api/settings/preview", { base, change });
    const p = await preview({ runtime: "claude-code" });
    expect(p.statusCode).toBe(200);
    const chosen = ChatSettings.parse(p.json());
    expect(chosen).toMatchObject({ runtime: "claude-code", model: "claude-sonnet-5-5" });
    // What the screen then creates the conversation with is accepted, and it answers.
    const c = await newAs(t, "admin", { settings: chosen });
    expect(c.settings).toEqual(chosen);
    expect(await runAs(t, "admin", c.id, "안녕")).toMatchObject({
      status: "done",
      model: "claude-sonnet-5-5",
    });
    // Opus itself, and a bad request, are refused like a conversation's change.
    const opus = await preview({ model: "claude-opus-5-5" }, chosen);
    expect([opus.statusCode, opus.json()]).toEqual([403, { error: "connection_limited" }]);
    expect((await preview({})).statusCode).toBe(400);
    // Nothing was stored by previews.
    expect(
      DefaultsResponse.parse((await t.as("admin").get("/api/settings/defaults")).json()).defaults.runtime,
    ).toBe("codex");
  });

  it("공용으로 쓰기 alone onto a connection limited for the model: 403, model and effort unchanged (review #101 3차)", async () => {
    const t = await start({ script });
    t.connect("claude-code", "owner");
    const shared = t.connect("claude-code", null);
    t.connect("codex", null);
    t.app.connections!.store.recordLimit(shared.id, "family:opus", Date.now() + 3_600_000, Date.now() - 1);
    const c = await t.newConversation();
    expect(c.settings).toEqual({
      runtime: "claude-code",
      model: "claude-opus-5-5",
      effort: "high",
      useShared: false,
    });
    const r = await t.owner.put(`/api/conversations/${c.id}/settings`, { useShared: true });
    expect([r.statusCode, r.json()]).toEqual([403, { error: "connection_limited" }]);
    expect((await t.getConversation(c.id)).settings).toEqual(c.settings);
    // A real runtime change still lands on the first model that is not limited.
    await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "codex" });
    const back = await t.owner.put(`/api/conversations/${c.id}/settings`, { runtime: "claude-code" });
    expect(Conversation.parse(back.json()).settings).toMatchObject({ model: "claude-opus-5-5" }); // personal: fine
  });

  it("limitFor: by auth type — reset time, retry-after, cooldown; scope from the window", () => {
    const now = 1_000_000_000_000;
    const sub = (info = {}) => limitFor("subscription", "claude-opus-5-5", info, now);
    const api = (info = {}) => limitFor("api_key", "claude-opus-5-5", info, now);
    expect(sub()).toEqual({ scope: "all", until: now + SUBSCRIPTION_COOLDOWN_MS });
    expect(api()).toEqual({ scope: "model:claude-opus-5-5", until: now + API_KEY_COOLDOWN_MS });
    expect(api({ retryAfterMs: 7_000 })).toMatchObject({ until: now + 7_000 });
    expect(api({ retryAfterMs: 0 })).toMatchObject({ until: now + 1_000 });
    expect(sub({ resetsAt: now + 30 * 60_000 })).toMatchObject({ until: now + 30 * 60_000 });
    expect(sub({ resetsAt: now - 5 })).toMatchObject({ until: now + 60_000 });
    expect(sub({ resetsAt: now + 30 * 86_400_000 })).toMatchObject({ until: now + 7 * 86_400_000 });
    expect(sub({ modelFamily: "opus" })).toMatchObject({ scope: "family:opus" });
    expect(api({ modelFamily: "sonnet" })).toMatchObject({ scope: "family:sonnet" });
    expect(sub({ resetsAt: Number.NaN })).toMatchObject({ until: now + SUBSCRIPTION_COOLDOWN_MS });
  });
});

describe("POST /api/settings/preview: per account, nothing stored (review #101 4차)", () => {
  const post = (t: T, cookie: string | null, body: object, headers: Record<string, string> = {}) =>
    t.app.inject({
      method: "POST",
      url: "/api/settings/preview",
      headers: {
        host: "localhost:3000",
        ...(cookie ? { cookie } : {}),
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        ...headers,
      },
      payload: body,
    });
  const opus = { runtime: "claude-code", model: "claude-opus-5-5", effort: "high", useShared: false };

  it("is computed with the caller's own policy and defaults; a forged base gains nothing", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    // The son (owner) may use Haiku only; mom has everything and a Codex default.
    t.policy("claude-code", { models: ["claude-haiku-5-5"] });
    await t.as("shared").put("/api/settings/defaults", {
      defaults: { runtime: "claude-code", models: { codex: { model: "gpt-6-luna", effort: "max" } } },
    });
    const son = await post(t, t.f.cookies.owner, { base: opus, change: { model: "claude-opus-5-5" } });
    expect([son.statusCode, son.json()]).toEqual([403, { error: "model_not_allowed" }]);
    expect(son.headers["cache-control"]).toBe("no-store");
    const mom = await post(t, t.f.cookies.shared, { base: opus, change: { runtime: "codex" } });
    expect(mom.statusCode).toBe(200);
    expect(mom.headers["cache-control"]).toBe("no-store");
    expect(ChatSettings.parse(mom.json())).toEqual({
      runtime: "codex",
      model: "gpt-6-luna",
      effort: "max",
      useShared: false,
    });
    // The same change for the son: his own defaults (none for Codex) → Codex's first model.
    expect(
      ChatSettings.parse(
        (await post(t, t.f.cookies.owner, { base: opus, change: { runtime: "codex" } })).json(),
      ),
    ).toMatchObject({ model: "gpt-6.1-sol" });
    // A forged base naming a model he may not use: only the effort was asked, and he still gets an allowed model.
    const forged = await post(t, t.f.cookies.owner, { base: opus, change: { effort: "low" } });
    expect(forged.statusCode).toBe(200);
    expect(ChatSettings.parse(forged.json())).toMatchObject({
      runtime: "claude-code",
      model: "claude-haiku-5-5",
    });
    // A forged base on a runtime he may not use at all, and "공용으로 쓰기" without a shared Codex connection for him.
    t.policy("codex", { allowed: false });
    const off = await post(t, t.f.cookies.owner, {
      base: { runtime: "codex", model: "gpt-6-luna", effort: null, useShared: false },
      change: { effort: "low" },
    });
    expect([off.statusCode, off.json()]).toEqual([403, { error: "runtime_not_allowed" }]);
  });

  it("refuses without a session, without CSRF, with a pending password change and for an inactive account", async () => {
    const t = await start();
    t.connect("claude-code", null);
    const body = { base: opus, change: { effort: "low" } };
    expect((await post(t, null, body)).statusCode).toBe(401);
    expect((await post(t, t.f.cookies.owner, body, { [CSRF_HEADER]: "" })).statusCode).toBe(403);
    const noOrigin = await t.app.inject({
      method: "POST",
      url: "/api/settings/preview",
      headers: { host: "localhost:3000", cookie: t.f.cookies.owner },
      payload: body,
    });
    expect(noOrigin.statusCode).toBe(403);
    expect((await post(t, t.f.cookies.owner, body)).statusCode).toBe(200);
    // Mom must change her password first; the stranger is deactivated.
    const users = t.app.users!;
    users.setPassword(t.f.users.shared.id, users.byId(t.f.users.shared.id)!.passwordHash!, {
      mustChange: true,
    });
    // The password reset ended her session; signing in again gives one that must change the password first.
    const login = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
      payload: { email: t.f.users.shared.email, password: PW },
    });
    expect(login.statusCode).toBe(200);
    const pending = await post(t, String(login.headers["set-cookie"]).split(";")[0]!, body);
    expect([pending.statusCode, pending.json()]).toEqual([403, { error: "password_change_required" }]);
    users.deactivate(t.f.users.stranger.id);
    expect([401, 403]).toContain((await post(t, t.f.cookies.stranger, body)).statusCode);
  });

  it("stores nothing: no defaults, no conversation, no settings", async () => {
    const t = await start();
    t.connect("claude-code", null);
    t.connect("codex", null);
    const c = await t.newConversation();
    const before = DefaultsResponse.parse((await t.owner.get("/api/settings/defaults")).json());
    const list = async () =>
      (await t.owner.get("/api/conversations")).json<{ items: unknown[] }>().items.length;
    const n = await list();
    for (const change of [{ runtime: "codex" }, { model: "claude-haiku-5-5" }, { useShared: false }])
      expect((await post(t, t.f.cookies.owner, { base: c.settings, change })).statusCode).toBe(200);
    expect(DefaultsResponse.parse((await t.owner.get("/api/settings/defaults")).json())).toEqual(before);
    expect(await list()).toBe(n);
    expect((await t.getConversation(c.id)).settings).toEqual(c.settings);
  });
});
